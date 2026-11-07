import type { DatabaseSync } from "node:sqlite";
import type { ShopConfig } from "./config.ts";
import { transaction } from "./db.ts";
import { ShopError } from "./errors.ts";
import { zonedNow } from "./time.ts";

// ---------- Menu ----------

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
  /** False = sold out today. Staff toggle this on the desk. */
  available: boolean;
}

export class MenuService {
  private readonly db: DatabaseSync;
  private readonly onChange: (id: string) => void;

  constructor(deps: { db: DatabaseSync; onChange?: (id: string) => void }) {
    this.db = deps.db;
    this.onChange = deps.onChange ?? (() => {});
  }

  /**
   * Makes the database match shop.json: adds new items, updates names/prices,
   * hides removed items. Keeps each item's sold-out flag.
   */
  sync(items: ShopConfig["menu"]): void {
    transaction(this.db, () => {
      this.db.exec("UPDATE menu_items SET active = 0");
      const upsert = this.db.prepare(
        `INSERT INTO menu_items (id, name, category, price, sort, active) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, category = excluded.category,
           price = excluded.price, sort = excluded.sort, active = 1`,
      );
      items.forEach((item, i) => upsert.run(item.id, item.name, item.category, item.price, i));
    });
  }

  list(): MenuItem[] {
    const rows = this.db
      .prepare(`SELECT id, name, category, price, available FROM menu_items WHERE active = 1 ORDER BY sort`)
      .all() as { id: string; name: string; category: string; price: number; available: number }[];
    return rows.map((r) => ({ ...r, available: r.available === 1 }));
  }

  setAvailable(id: string, available: boolean): MenuItem {
    const { changes } = this.db.prepare(`UPDATE menu_items SET available = ? WHERE id = ? AND active = 1`).run(available ? 1 : 0, id);
    if (!changes) throw new ShopError("not_found", "Menu item not found");
    this.onChange(id);
    return this.list().find((m) => m.id === id)!;
  }
}

// ---------- Orders ----------

export const ORDER_STATUSES = ["new", "preparing", "ready", "completed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderType = "takeaway" | "dine_in";

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["preparing", "ready", "cancelled"],
  preparing: ["ready", "new", "cancelled"],
  ready: ["completed", "preparing", "cancelled"],
  completed: ["ready"],
  cancelled: [],
};

export interface OrderLine {
  itemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  note: string;
  lineTotal: number;
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
  createdAt: string;
}

export interface OrderInput {
  type: OrderType;
  tableId?: string | null;
  customerName?: string;
  notes?: string;
  items: { itemId: string; quantity: number; note?: string }[];
}

export class OrderService {
  private readonly db: DatabaseSync;
  private readonly config: ShopConfig;
  private readonly now: () => Date;
  private readonly onChange: (id: number, action: "created" | "updated") => void;

  constructor(deps: {
    db: DatabaseSync;
    config: ShopConfig;
    now: () => Date;
    onChange?: (id: number, action: "created" | "updated") => void;
  }) {
    this.db = deps.db;
    this.config = deps.config;
    this.now = deps.now;
    this.onChange = deps.onChange ?? (() => {});
  }

  /** Creates an order. Prices always come from the database, never from the request. */
  create(input: OrderInput): Order {
    if (input.type !== "takeaway" && input.type !== "dine_in") throw new ShopError("invalid_type", "Order type must be takeaway or dine_in");
    const tableId = input.type === "dine_in" ? input.tableId || null : null;
    if (tableId && !this.config.tables.some((t) => t.id === tableId)) throw new ShopError("invalid_table", "Unknown table");
    const customerName = String(input.customerName ?? "").trim().slice(0, 60);
    const notes = String(input.notes ?? "").trim();
    if (notes.length > 300) throw new ShopError("invalid_notes", "Notes can be up to 300 characters.");
    if (!Array.isArray(input.items) || input.items.length === 0) throw new ShopError("empty_order", "Add at least one item.");
    if (input.items.length > 50) throw new ShopError("too_many_items", "An order can have up to 50 lines.");

    const menu = new Map(
      (this.db.prepare(`SELECT id, name, price, available FROM menu_items WHERE active = 1`).all() as {
        id: string;
        name: string;
        price: number;
        available: number;
      }[]).map((m) => [m.id, m]),
    );

    const lines = input.items.map((line) => {
      const item = menu.get(line?.itemId);
      if (!item) throw new ShopError("invalid_item", `Unknown menu item "${line?.itemId}"`);
      if (!item.available) throw new ShopError("sold_out", `${item.name} is sold out.`);
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 50) {
        throw new ShopError("invalid_quantity", "Quantity must be between 1 and 50.");
      }
      const note = String(line.note ?? "").trim().slice(0, 100);
      return { itemId: item.id, name: item.name, unitPrice: item.price, quantity: line.quantity, note };
    });
    const total = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);

    const id = transaction(this.db, () => {
      const businessDate = zonedNow(this.config.timezone, this.now()).date;
      const { next } = this.db
        .prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS next FROM orders WHERE business_date = ?`)
        .get(businessDate) as { next: number };
      const stamp = this.now().toISOString();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO orders (number, business_date, type, table_id, customer_name, notes, status, total, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
        )
        .run(next, businessDate, input.type, tableId, customerName, notes, total, stamp, stamp);
      const orderId = Number(lastInsertRowid);
      const insertLine = this.db.prepare(
        `INSERT INTO order_items (order_id, item_id, name, unit_price, quantity, note) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const l of lines) insertLine.run(orderId, l.itemId, l.name, l.unitPrice, l.quantity, l.note);
      return orderId;
    });
    this.onChange(id, "created");
    return this.get(id)!;
  }

  get(id: number): Order | null {
    return this.load(`WHERE id = ?`, [id])[0] ?? null;
  }

  /** Orders for a business day (default today), oldest first. */
  list(date?: string): Order[] {
    const day = date ?? zonedNow(this.config.timezone, this.now()).date;
    return this.load(`WHERE business_date = ?`, [day]);
  }

  setStatus(id: number, status: OrderStatus): Order {
    const order = this.get(id);
    if (!order) throw new ShopError("not_found", "Order not found");
    if (!ORDER_STATUSES.includes(status)) throw new ShopError("invalid_status", `Unknown status "${status}"`);
    if (order.status === status) return order;
    if (!ORDER_TRANSITIONS[order.status].includes(status)) {
      throw new ShopError("invalid_status", `Can't change a ${order.status} order to ${status}.`);
    }
    this.db.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ?`).run(status, this.now().toISOString(), id);
    this.onChange(id, "updated");
    return this.get(id)!;
  }

  /** Simple end-of-day numbers for the desk. */
  summary(date?: string): { orders: number; items: number; sales: number; open: number } {
    const orders = this.list(date);
    const counted = orders.filter((o) => o.status !== "cancelled");
    return {
      orders: counted.length,
      items: counted.reduce((n, o) => n + o.items.reduce((m, l) => m + l.quantity, 0), 0),
      sales: counted.reduce((n, o) => n + o.total, 0),
      open: orders.filter((o) => ["new", "preparing", "ready"].includes(o.status)).length,
    };
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
      createdAt: r.created_at,
      items: lineRows
        .filter((l) => l.order_id === r.id)
        .map((l) => ({
          itemId: l.item_id,
          name: l.name,
          unitPrice: l.unit_price,
          quantity: l.quantity,
          note: l.note,
          lineTotal: l.unit_price * l.quantity,
        })),
    }));
  }
}
