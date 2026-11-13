import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dataDir } from "../tenant.ts";
import { BookingService } from "./bookings.ts";
import { loadShopConfig, type ShopConfig } from "./config.ts";
import { openDatabase, transaction } from "./db.ts";
import { LoyaltyService } from "./loyalty.ts";
import { MenuService } from "./menu.ts";
import { OrderService } from "./orders.ts";
import { QuestionLog } from "./questions.ts";
import { AnswerBook } from "./answers.ts";
import { StaffService } from "./staff.ts";

export type ShopChange = { kind: "booking" | "order" | "menu" | "answers"; id: string | number; action: "created" | "updated" };

/**
 * Everything one business needs for bookings and the till, backed by its own
 * SQLite file (data/<tenant>/shop.db). Emits "change" events for live desk updates.
 */
export class Shop {
  readonly tenantId: string;
  readonly config: ShopConfig;
  readonly bookings: BookingService;
  readonly menu: MenuService;
  readonly orders: OrderService;
  readonly staff: StaffService;
  readonly loyalty: LoyaltyService;
  /** What customers ask the chat assistant, and whether it could answer. */
  readonly questions: QuestionLog;
  /** Answers added on the desk; the assistant reads them as an extra document. */
  readonly answers: AnswerBook;
  readonly events = new EventEmitter();
  private readonly db: DatabaseSync;
  private readonly clock?: () => Date;

  constructor(deps: { tenantId: string; config: ShopConfig; db: DatabaseSync; now?: () => Date }) {
    this.tenantId = deps.tenantId;
    this.config = deps.config;
    this.db = deps.db;
    const now = deps.now ?? (() => new Date());
    this.clock = now;
    const emit =
      (kind: ShopChange["kind"]) =>
      (id: string | number, action: ShopChange["action"] = "updated") =>
        this.events.emit("change", { kind, id, action } satisfies ShopChange);

    this.events.setMaxListeners(100); // one listener per open desk screen
    this.bookings = new BookingService({ db: this.db, config: this.config, now, onChange: emit("booking") });
    this.menu = new MenuService({ db: this.db, config: this.config, onChange: emit("menu") });
    this.loyalty = new LoyaltyService({ db: this.db, config: this.config.loyalty, now });
    this.orders = new OrderService({
      loyalty: this.loyalty,
      db: this.db,
      config: this.config,
      now,
      onChange: emit("order"),
      onStockChange: (itemId) => emit("menu")(itemId),
    });
    this.staff = new StaffService({ db: this.db, now });
    this.questions = new QuestionLog({ db: this.db, now });
    this.answers = new AnswerBook({ db: this.db, now, onChange: () => emit("answers")(0) });
    this.menu.sync(this.config.menu);
  }

  /**
   * Deletes all orders, bookings, members and staff accounts, and resets the menu to
   * shop.json. Used by the public demo's nightly reset. Desks are told to refresh.
   */
  resetData(): void {
    transaction(this.db, () => {
      this.db.exec(`
        DELETE FROM loyalty_ledger;
        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM loyalty_members;
        DELETE FROM bookings;
        DELETE FROM staff;
        DELETE FROM chat_questions;
        DELETE FROM team_answers;
        DELETE FROM menu_items WHERE origin = 'desk';
        UPDATE menu_items SET edited = 0, stock = NULL, available = 1;
      `);
    });
    this.menu.sync(this.config.menu);
    for (const kind of ["booking", "order", "menu"] as const) this.events.emit("change", { kind, id: 0, action: "updated" } satisfies ShopChange);
  }

  /**
   * Writes a consistent copy of the database (safe while the shop is running) and keeps
   * only the newest `keep` copies. Returns the new file's path.
   */
  backup(dir: string, keep = 7): string {
    mkdirSync(dir, { recursive: true });
    const stamp = this.nowIso().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); // 20261113-150000
    const file = join(dir, `shop-${stamp}.db`);
    if (existsSync(file)) return file;
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const old = readdirSync(dir)
      .filter((f) => /^shop-\d{8}-\d{6}\.db$/.test(f))
      .sort()
      .slice(0, -keep);
    for (const f of old) rmSync(join(dir, f));
    return file;
  }

  /** Cheap query to prove the database is reachable (used by the health check). */
  ping(): void {
    this.db.prepare("SELECT 1").get();
  }

  close(): void {
    this.db.close();
  }

  /** The shop's clock (controllable in tests). */
  now(): Date {
    return (this.clock ?? (() => new Date()))();
  }

  private nowIso(): string {
    return (this.clock ?? (() => new Date()))().toISOString();
  }
}

/** Opens a tenant's shop, or returns null if the tenant has no shop.json. */
export async function openShop(tenantId: string, opts: { dataDir?: string; dbPath?: string; now?: () => Date } = {}): Promise<Shop | null> {
  const config = await loadShopConfig(tenantId);
  if (!config) return null;
  const db = openDatabase(opts.dbPath ?? join(opts.dataDir ?? dataDir(), tenantId, "shop.db"));
  return new Shop({ tenantId, config, db, now: opts.now });
}
