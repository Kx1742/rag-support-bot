import type { DatabaseSync } from "node:sqlite";
import type { ShopConfig } from "./config.ts";
import { transaction } from "./db.ts";
import { ShopError } from "./errors.ts";
import { zonedNow } from "./time.ts";

// ---------- Orders ----------

export const ORDER_STATUSES = ["new", "preparing", "ready", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderType = "takeaway" | "dine_in";
export const PAYMENT_METHODS = ["cash", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type PaymentStatus = "unpaid" | "paid" | "refunded";

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["preparing", "ready", "cancelled"],
  preparing: ["ready", "new", "cancelled"],
  ready: ["completed", "preparing", "cancelled"],
  completed: ["ready"],
  cancelled: [],
};

/** One chosen option on an order line, frozen at order time (later menu changes don't alter old orders). */
export interface ChosenOption {
  group: string;
  choice: string;
  name: string;
  price: number;
  /** True for pre-selected defaults like "Regular" or "Whole milk" (not shown to the kitchen). */
  isDefault: boolean;
}

export interface OrderLine {
  itemId: string;
  name: string;
  /** Base price + options, per unit. */
  unitPrice: number;
  quantity: number;
  note: string;
  options: ChosenOption[];
  /** Non-default choices for display, e.g. "Large · Oat milk · Extra shot". */
  optionsLabel: string;
  lineTotal: number;
}

export interface Payment {
  status: PaymentStatus;
  method: PaymentMethod | null;
  tendered: number | null;
  change: number | null;
  paidAt: string | null;
  paidBy: string | null;
  refundedAt: string | null;
  refundedBy: string | null;
  refundReason: string | null;
}

export interface Order {
  id: number;
  /** Ticket number, restarts at 1 each day. */
  number: number;
  businessDate: string;
  type: OrderType;
  tableId: string | null;
  customerName: string;
  notes: string;
  status: OrderStatus;
  total: number;
  items: OrderLine[];
  payment: Payment;
  createdBy: string;
  createdAt: string;
}

export interface OrderLineInput {
  itemId: string;
  quantity: number;
  note?: string;
  /** Chosen options by group id: "large" for single groups, ["extra-shot"] for multi groups. */
  options?: Record<string, string | string[]>;
}

export interface OrderInput {
  type: OrderType;
  tableId?: string | null;
  customerName?: string;
  notes?: string;
  items: OrderLineInput[];
}

export interface PaymentInput {
  method: PaymentMethod;
  /** Cash handed over, in cents. Ignored for card (card always pays the exact total). */
  tendered?: number;
}

/** Who did something, for the audit trail. */
export interface Actor {
  name: string;
}

const MAX_TENDER_OVER = 100_000; // refuse obviously mistyped cash amounts ($1,000+ over the total)

export class OrderService {
  private readonly db: DatabaseSync;
  private readonly config: ShopConfig;
  private readonly now: () => Date;
  private readonly onChange: (id: number, action: "created" | "updated") => void;
  private readonly onStockChange: (itemId: string) => void;

  constructor(deps: {
    db: DatabaseSync;
    config: ShopConfig;
    now: () => Date;
    onChange?: (id: number, action: "created" | "updated") => void;
    /** Called when an order changes an item's stock count (so the menu can refresh). */
    onStockChange?: (itemId: string) => void;
  }) {
    this.db = deps.db;
    this.config = deps.config;
    this.now = deps.now;
    this.onChange = deps.onChange ?? (() => {});
    this.onStockChange = deps.onStockChange ?? (() => {});
  }

  /**
   * Creates an order (optionally paying for it in the same step).
   * Prices always come from the server's menu, never from the request.
   * `clientRef` makes retries safe: sending the same ref twice returns the first order.
   */
  create(input: OrderInput, opts: { by?: Actor; clientRef?: string; payment?: PaymentInput } = {}): Order {
    if (opts.clientRef !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(opts.clientRef)) {
      throw new ShopError("invalid_ref", "clientRef must be 8-64 letters, digits or dashes.");
    }
    if (opts.clientRef) {
      const existing = this.byClientRef(opts.clientRef);
      if (existing) return existing;
    }

    if (input.type !== "takeaway" && input.type !== "dine_in") throw new ShopError("invalid_type", "Order type must be takeaway or dine_in");
    const tableId = input.type === "dine_in" ? input.tableId || null : null;
    if (tableId && !this.config.tables.some((t) => t.id === tableId)) throw new ShopError("invalid_table", "Unknown table");
    const customerName = String(input.customerName ?? "").trim().slice(0, 60);
    const notes = String(input.notes ?? "").trim();
    if (notes.length > 300) throw new ShopError("invalid_notes", "Notes can be up to 300 characters.");
    if (!Array.isArray(input.items) || input.items.length === 0) throw new ShopError("empty_order", "Add at least one item.");
    if (input.items.length > 50) throw new ShopError("too_many_items", "An order can have up to 50 lines.");

    const lines = input.items.map((line) => this.priceLine(line));
    const total = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
    if (opts.payment) this.checkPayment(opts.payment, total);

    let stockTouched: string[] = [];
    const id = transaction(this.db, () => {
      if (opts.clientRef) {
        const raced = this.byClientRef(opts.clientRef);
        if (raced) return raced.id;
      }
      stockTouched = this.takeStock(lines);
      const businessDate = zonedNow(this.config.timezone, this.now()).date;
      const { next } = this.db
        .prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS next FROM orders WHERE business_date = ?`)
        .get(businessDate) as { next: number };
      const stamp = this.now().toISOString();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO orders (number, business_date, type, table_id, customer_name, notes, status, total, created_at, updated_at, client_ref, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
        )
        .run(next, businessDate, input.type, tableId, customerName, notes, total, stamp, stamp, opts.clientRef ?? null, opts.by?.name ?? "");
      const orderId = Number(lastInsertRowid);
      const insertLine = this.db.prepare(
        `INSERT INTO order_items (order_id, item_id, name, unit_price, quantity, note, options) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const l of lines) insertLine.run(orderId, l.itemId, l.name, l.unitPrice, l.quantity, l.note, JSON.stringify(l.options));
      if (opts.payment) this.recordPayment(orderId, total, opts.payment, opts.by);
      return orderId;
    });
    this.onChange(id, "created");
    for (const itemId of stockTouched) this.onStockChange(itemId);
    return this.get(id)!;
  }

  /** Takes payment for an unpaid order. */
  pay(id: number, payment: PaymentInput, by?: Actor): Order {
    const order = this.get(id);
    if (!order) throw new ShopError("not_found", "Order not found");
    if (order.status === "cancelled") throw new ShopError("invalid_status", "This order was cancelled.");
    if (order.payment.status !== "unpaid") throw new ShopError("already_paid", `This order is already ${order.payment.status}.`);
    this.checkPayment(payment, order.total);
    this.recordPayment(id, order.total, payment, by);
    this.onChange(id, "updated");
    return this.get(id)!;
  }

  /** Refunds a paid order and cancels it. Callers must check the user is a manager. */
  refund(id: number, reason: string, by?: Actor): Order {
    const order = this.get(id);
    if (!order) throw new ShopError("not_found", "Order not found");
    if (order.payment.status !== "paid") throw new ShopError("not_paid", "Only paid orders can be refunded.");
    const why = String(reason ?? "").trim();
    if (!why || why.length > 200) throw new ShopError("invalid_reason", "Give a reason for the refund (up to 200 characters).");
    const stamp = this.now().toISOString();
    const restored = transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE orders SET payment_status = 'refunded', refunded_at = ?, refunded_by = ?, refund_reason = ?,
             status = 'cancelled', updated_at = ? WHERE id = ?`,
        )
        .run(stamp, by?.name ?? "", why, stamp, id);
      return order.status === "cancelled" ? [] : this.returnStock(order.items);
    });
    this.onChange(id, "updated");
    for (const itemId of restored) this.onStockChange(itemId);
    return this.get(id)!;
  }

  get(id: number): Order | null {
    return this.load(`WHERE id = ?`, [id])[0] ?? null;
  }

  /** Orders for a business day (default today), oldest first. */
  list(date?: string): Order[] {
    return this.load(`WHERE business_date = ?`, [date ?? this.today()]);
  }

  setStatus(id: number, status: OrderStatus): Order {
    const order = this.get(id);
    if (!order) throw new ShopError("not_found", "Order not found");
    if (!ORDER_STATUSES.includes(status)) throw new ShopError("invalid_status", `Unknown status "${status}"`);
    if (order.status === status) return order;
    if (status === "cancelled" && order.payment.status === "paid") {
      throw new ShopError("needs_refund", "This order is paid. A manager needs to refund it instead.");
    }
    if (!ORDER_TRANSITIONS[order.status].includes(status)) {
      throw new ShopError("invalid_status", `Can't change a ${order.status} order to ${status}.`);
    }
    const restored = transaction(this.db, () => {
      this.db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`).run(status, this.now().toISOString(), id);
      return status === "cancelled" ? this.returnStock(order.items) : [];
    });
    this.onChange(id, "updated");
    for (const itemId of restored) this.onStockChange(itemId);
    return this.get(id)!;
  }

  /**
   * What the customer pickup screen may show: today's order numbers only
   * (no names or items), split into "being made" and "ready to collect".
   */
  pickupBoard(): { preparing: number[]; ready: number[] } {
    const numbers = (sql: string) =>
      (this.db.prepare(sql).all(this.today()) as { number: number }[]).map((r) => r.number);
    return {
      preparing: numbers(`SELECT number FROM orders WHERE business_date = ? AND status IN ('new', 'preparing') ORDER BY id`),
      // Most recently called first, so the newest "ready" number is the easiest to spot.
      ready: numbers(`SELECT number FROM orders WHERE business_date = ? AND status = 'ready' ORDER BY updated_at DESC, id DESC`),
    };
  }

  /** Quick numbers for the desk. Money figures are for managers; the API hides them from staff. */
  summary(date?: string) {
    const orders = this.list(date);
    const live = orders.filter((o) => o.status !== "cancelled");
    const paid = orders.filter((o) => o.payment.status === "paid");
    const sum = (list: Order[]) => list.reduce((n, o) => n + o.total, 0);
    return {
      orders: live.length,
      items: live.reduce((n, o) => n + o.items.reduce((m, l) => m + l.quantity, 0), 0),
      open: orders.filter((o) => ["new", "preparing", "ready"].includes(o.status)).length,
      unpaid: live.filter((o) => o.payment.status === "unpaid").length,
      sales: sum(paid),
      cash: sum(paid.filter((o) => o.payment.method === "cash")),
      card: sum(paid.filter((o) => o.payment.method === "card")),
      unpaidTotal: sum(live.filter((o) => o.payment.status === "unpaid")),
      refunds: sum(orders.filter((o) => o.payment.status === "refunded")),
    };
  }

  /** End-of-day report: best sellers, sales by hour, refunds. */
  report(date?: string) {
    const day = date ?? this.today();
    const orders = this.list(day);
    const paid = orders.filter((o) => o.payment.status === "paid");

    const byItem = new Map<string, { name: string; quantity: number; sales: number }>();
    for (const o of paid) {
      for (const l of o.items) {
        const row = byItem.get(l.itemId) ?? { name: l.name, quantity: 0, sales: 0 };
        row.quantity += l.quantity;
        row.sales += l.lineTotal;
        byItem.set(l.itemId, row);
      }
    }

    const byHour = new Map<number, { orders: number; sales: number }>();
    for (const o of paid) {
      const hour = Math.floor(zonedNow(this.config.timezone, new Date(o.createdAt)).minutes / 60);
      const row = byHour.get(hour) ?? { orders: 0, sales: 0 };
      row.orders++;
      row.sales += o.total;
      byHour.set(hour, row);
    }

    const summary = this.summary(day);
    return {
      date: day,
      summary,
      averageOrder: paid.length ? Math.round(summary.sales / paid.length) : 0,
      items: [...byItem.values()].sort((a, b) => b.sales - a.sales),
      hours: [...byHour.entries()].sort(([a], [b]) => a - b).map(([hour, v]) => ({ hour, ...v })),
      refunds: orders
        .filter((o) => o.payment.status === "refunded")
        .map((o) => ({ number: o.number, total: o.total, by: o.payment.refundedBy, reason: o.payment.refundReason })),
    };
  }

  // ---------- internals ----------

  private today(): string {
    return zonedNow(this.config.timezone, this.now()).date;
  }

  private byClientRef(ref: string): Order | null {
    return this.load(`WHERE client_ref = ?`, [ref])[0] ?? null;
  }

  /** Validates one line and prices it from the menu + chosen options. */
  private priceLine(line: OrderLineInput): Omit<OrderLine, "optionsLabel" | "lineTotal"> {
    const item = this.db
      .prepare(`SELECT id, name, price, available, options FROM menu_items WHERE id = ? AND active = 1`)
      .get(String(line?.itemId ?? "")) as { id: string; name: string; price: number; available: number; options: string | null } | undefined;
    if (!item) throw new ShopError("invalid_item", `Unknown menu item "${line?.itemId}"`);
    if (!item.available) throw new ShopError("sold_out", `${item.name} is sold out.`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 50) {
      throw new ShopError("invalid_quantity", "Quantity must be between 1 and 50.");
    }

    const allowed: string[] = item.options === null ? (this.config.menu.find((m) => m.id === item.id)?.options ?? []) : JSON.parse(item.options);
    const groups = new Map((this.config.optionGroups ?? []).map((g) => [g.id, g]));
    const requested = line.options && typeof line.options === "object" ? line.options : {};
    for (const groupId of Object.keys(requested)) {
      if (!allowed.includes(groupId)) throw new ShopError("invalid_option", `${item.name} doesn't have "${groupId}" options.`);
    }

    const chosen: ChosenOption[] = [];
    for (const groupId of allowed) {
      const group = groups.get(groupId)!;
      const raw = requested[groupId];
      if (group.type === "single") {
        if (raw !== undefined && typeof raw !== "string") throw new ShopError("invalid_option", `Pick one ${group.name.toLowerCase()}.`);
        const choice = raw === undefined ? group.choices.find((c) => c.default)! : group.choices.find((c) => c.id === raw);
        if (!choice) throw new ShopError("invalid_option", `Unknown ${group.name.toLowerCase()} "${raw}".`);
        chosen.push({ group: group.id, choice: choice.id, name: choice.name, price: choice.price, isDefault: !!choice.default });
      } else {
        const ids = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : null;
        if (!ids || new Set(ids).size !== ids.length) throw new ShopError("invalid_option", `Invalid ${group.name.toLowerCase()}.`);
        for (const id of ids) {
          const choice = group.choices.find((c) => c.id === id);
          if (!choice) throw new ShopError("invalid_option", `Unknown option "${id}".`);
          chosen.push({ group: group.id, choice: choice.id, name: choice.name, price: choice.price, isDefault: false });
        }
      }
    }

    return {
      itemId: item.id,
      name: item.name,
      unitPrice: item.price + chosen.reduce((n, c) => n + c.price, 0),
      quantity: line.quantity,
      note: String(line.note ?? "").trim().slice(0, 100),
      options: chosen,
    };
  }

  /** Counts down stock for counted items. Throws if there isn't enough. Returns the item ids touched. */
  private takeStock(lines: { itemId: string; name: string; quantity: number }[]): string[] {
    const wanted = new Map<string, { name: string; quantity: number }>();
    for (const l of lines) {
      const w = wanted.get(l.itemId) ?? { name: l.name, quantity: 0 };
      w.quantity += l.quantity;
      wanted.set(l.itemId, w);
    }
    const touched: string[] = [];
    for (const [itemId, { name, quantity }] of wanted) {
      const row = this.db.prepare(`SELECT stock FROM menu_items WHERE id = ?`).get(itemId) as { stock: number | null };
      if (row.stock === null) continue;
      if (row.stock < quantity) {
        throw new ShopError("low_stock", row.stock === 0 ? `${name} is sold out.` : `Only ${row.stock} ${name} left.`);
      }
      this.db
        .prepare(`UPDATE menu_items SET stock = stock - ?, available = CASE WHEN stock - ? <= 0 THEN 0 ELSE available END WHERE id = ?`)
        .run(quantity, quantity, itemId);
      touched.push(itemId);
    }
    return touched;
  }

  /** Puts stock back when an order is cancelled or refunded. */
  private returnStock(items: OrderLine[]): string[] {
    const touched = new Set<string>();
    for (const l of items) {
      const { changes } = this.db
        .prepare(`UPDATE menu_items SET stock = stock + ?, available = 1 WHERE id = ? AND stock IS NOT NULL`)
        .run(l.quantity, l.itemId);
      if (changes) touched.add(l.itemId);
    }
    return [...touched];
  }

  private checkPayment(payment: PaymentInput, total: number): void {
    if (!PAYMENT_METHODS.includes(payment?.method)) throw new ShopError("invalid_payment", "Payment method must be cash or card.");
    if (payment.method === "cash") {
      const t = payment.tendered;
      if (!Number.isInteger(t) || t! < total) throw new ShopError("not_enough_cash", "Cash given is less than the total.");
      if (t! > total + MAX_TENDER_OVER) throw new ShopError("invalid_payment", "That cash amount looks wrong. Check it and try again.");
    }
  }

  private recordPayment(id: number, total: number, payment: PaymentInput, by?: Actor): void {
    const tendered = payment.method === "cash" ? payment.tendered! : total;
    this.db
      .prepare(
        `UPDATE orders SET payment_status = 'paid', payment_method = ?, amount_tendered = ?, paid_at = ?, paid_by = ?, updated_at = ?
         WHERE id = ? AND payment_status = 'unpaid'`,
      )
      .run(payment.method, tendered, this.now().toISOString(), by?.name ?? "", this.now().toISOString(), id);
  }

  private load(where: string, params: (string | number)[]): Order[] {
    const rows = this.db.prepare(`SELECT * FROM orders ${where} ORDER BY id`).all(...params) as {
      id: number;
      number: number;
      business_date: string;
      type: OrderType;
      table_id: string | null;
      customer_name: string;
      notes: string;
      status: OrderStatus;
      total: number;
      created_at: string;
      created_by: string;
      payment_status: PaymentStatus;
      payment_method: PaymentMethod | null;
      amount_tendered: number | null;
      paid_at: string | null;
      paid_by: string | null;
      refunded_at: string | null;
      refunded_by: string | null;
      refund_reason: string | null;
    }[];
    if (!rows.length) return [];

    const lineRows = this.db
      .prepare(`SELECT * FROM order_items WHERE order_id IN (${rows.map(() => "?").join(",")}) ORDER BY id`)
      .all(...rows.map((r) => r.id)) as {
      order_id: number;
      item_id: string;
      name: string;
      unit_price: number;
      quantity: number;
      note: string;
      options: string;
    }[];

    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      businessDate: r.business_date,
      type: r.type,
      tableId: r.table_id,
      customerName: r.customer_name,
      notes: r.notes,
      status: r.status,
      total: r.total,
      createdBy: r.created_by,
      createdAt: r.created_at,
      payment: {
        status: r.payment_status,
        method: r.payment_method,
        tendered: r.amount_tendered,
        change: r.payment_status !== "unpaid" && r.amount_tendered !== null ? r.amount_tendered - r.total : null,
        paidAt: r.paid_at,
        paidBy: r.paid_by,
        refundedAt: r.refunded_at,
        refundedBy: r.refunded_by,
        refundReason: r.refund_reason,
      },
      items: lineRows
        .filter((l) => l.order_id === r.id)
        .map((l) => {
          const options = JSON.parse(l.options) as ChosenOption[];
          return {
            itemId: l.item_id,
            name: l.name,
            unitPrice: l.unit_price,
            quantity: l.quantity,
            note: l.note,
            options,
            optionsLabel: options
              .filter((o) => !o.isDefault)
              .map((o) => o.name)
              .join(" · "),
            lineTotal: l.unit_price * l.quantity,
          };
        }),
    }));
  }
}
