import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../tenant.ts";
import { BookingService } from "./bookings.ts";
import { loadShopConfig, type ShopConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { MenuService, OrderService } from "./orders.ts";

export type ShopChange = { kind: "booking" | "order" | "menu"; id: string | number; action: "created" | "updated" };

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
  readonly events = new EventEmitter();
  private readonly db: DatabaseSync;

  constructor(deps: { tenantId: string; config: ShopConfig; db: DatabaseSync; now?: () => Date }) {
    this.tenantId = deps.tenantId;
    this.config = deps.config;
    this.db = deps.db;
    const now = deps.now ?? (() => new Date());
    const emit =
      (kind: ShopChange["kind"]) =>
      (id: string | number, action: ShopChange["action"] = "updated") =>
        this.events.emit("change", { kind, id, action } satisfies ShopChange);

    this.events.setMaxListeners(100); // one listener per open desk screen
    this.bookings = new BookingService({ db: this.db, config: this.config, now, onChange: emit("booking") });
    this.menu = new MenuService({ db: this.db, onChange: emit("menu") });
    this.orders = new OrderService({ db: this.db, config: this.config, now, onChange: emit("order") });
    this.menu.sync(this.config.menu);
  }

  close(): void {
    this.db.close();
  }
}

/** Opens a tenant's shop, or returns null if the tenant has no shop.json. */
export async function openShop(tenantId: string, opts: { dataDir?: string; dbPath?: string; now?: () => Date } = {}): Promise<Shop | null> {
  const config = await loadShopConfig(tenantId);
  if (!config) return null;
  const db = openDatabase(opts.dbPath ?? join(opts.dataDir ?? DATA_DIR, tenantId, "shop.db"));
  return new Shop({ tenantId, config, db, now: opts.now });
}
