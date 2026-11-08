import type { DatabaseSync } from "node:sqlite";
import type { OptionGroup, ShopConfig } from "./config.ts";
import { transaction } from "./db.ts";
import { ShopError } from "./errors.ts";

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  price: number;
  /** False = sold out. Staff toggle this, and it turns false automatically when stock hits 0. */
  available: boolean;
  /** Option group ids (size, milk...) offered for this item. */
  options: string[];
  /** Units left, or null when this item isn't counted. */
  stock: number | null;
  /** Hidden items are off the menu entirely (managers can bring them back). */
  hidden: boolean;
}

export interface MenuItemInput {
  name: string;
  category: string;
  price: number;
  options?: string[];
  stock?: number | null;
}

interface Row {
  id: string;
  name: string;
  category: string;
  price: number;
  available: number;
  active: number;
  options: string | null;
  stock: number | null;
  edited: number;
  origin: string;
  sort: number;
}

const MAX_PRICE = 100_000; // $1,000 per item is plenty for a café
const MAX_STOCK = 9_999;

/**
 * The live menu. shop.json seeds it; after that the database is the source of truth:
 * items edited or added in the desk keep their changes when shop.json changes.
 */
export class MenuService {
  private readonly db: DatabaseSync;
  private readonly config: ShopConfig;
  private readonly onChange: (id: string) => void;

  constructor(deps: { db: DatabaseSync; config: ShopConfig; onChange?: (id: string) => void }) {
    this.db = deps.db;
    this.config = deps.config;
    this.onChange = deps.onChange ?? (() => {});
  }

  /**
   * Brings shop.json changes into the database: adds new items, updates items nobody
   * edited in the desk, hides file items that were removed. Desk changes always win.
   */
  sync(items: ShopConfig["menu"]): void {
    transaction(this.db, () => {
      this.db.exec("UPDATE menu_items SET active = 0 WHERE origin = 'file' AND edited = 0");
      const upsert = this.db.prepare(
        `INSERT INTO menu_items (id, name, category, price, sort, active, options, origin) VALUES (?, ?, ?, ?, ?, 1, ?, 'file')
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, category = excluded.category, price = excluded.price,
           sort = excluded.sort, options = excluded.options, active = 1
         WHERE menu_items.edited = 0`,
      );
      items.forEach((item, i) => upsert.run(item.id, item.name, item.category, item.price, i, JSON.stringify(item.options ?? [])));
    });
  }

  /** The menu as staff and customers see it. Managers can include hidden items. */
  list(opts: { includeHidden?: boolean } = {}): MenuItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM menu_items ${opts.includeHidden ? "" : "WHERE active = 1"} ORDER BY sort, name`)
      .all() as unknown as Row[];
    return rows.map((r) => this.toItem(r));
  }

  get(id: string): MenuItem | null {
    const row = this.db.prepare(`SELECT * FROM menu_items WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? this.toItem(row) : null;
  }

  optionGroups(): OptionGroup[] {
    return this.config.optionGroups ?? [];
  }

  setAvailable(id: string, available: boolean): MenuItem {
    const item = this.requireActive(id);
    // Marking a counted item available again with nothing left: stop counting it.
    const clearStock = available && item.stock === 0;
    this.db
      .prepare(`UPDATE menu_items SET available = ?, stock = CASE WHEN ? THEN NULL ELSE stock END WHERE id = ?`)
      .run(available ? 1 : 0, clearStock ? 1 : 0, id);
    this.onChange(id);
    return this.get(id)!;
  }

  /** Sets the count (e.g. "12 croissants baked"). 0 = sold out, null = stop counting. */
  setStock(id: string, stock: number | null): MenuItem {
    this.requireActive(id);
    const value = checkStock(stock);
    this.db
      .prepare(`UPDATE menu_items SET stock = ?, available = CASE WHEN ? IS NULL THEN available WHEN ? > 0 THEN 1 ELSE 0 END WHERE id = ?`)
      .run(value, value, value, id);
    this.onChange(id);
    return this.get(id)!;
  }

  /** Manager: add a new item. */
  create(input: MenuItemInput): MenuItem {
    const clean = this.validate(input);
    const id = this.uniqueId(clean.name);
    const { next } = this.db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM menu_items`).get() as { next: number };
    this.db
      .prepare(
        `INSERT INTO menu_items (id, name, category, price, sort, active, available, options, stock, edited, origin)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 'desk')`,
      )
      .run(id, clean.name, clean.category, clean.price, next, clean.stock === 0 ? 0 : 1, JSON.stringify(clean.options), clean.stock);
    this.onChange(id);
    return this.get(id)!;
  }

  /** Manager: change name, category, price, options or stock. Marks the item as desk-edited. */
  update(id: string, input: MenuItemInput): MenuItem {
    const current = this.get(id);
    if (!current) throw new ShopError("not_found", "Menu item not found");
    const clean = this.validate(input);
    this.db
      .prepare(
        `UPDATE menu_items SET name = ?, category = ?, price = ?, options = ?, stock = ?, edited = 1,
           available = CASE WHEN ? IS NULL THEN available WHEN ? > 0 THEN 1 ELSE 0 END
         WHERE id = ?`,
      )
      .run(clean.name, clean.category, clean.price, JSON.stringify(clean.options), clean.stock, clean.stock, clean.stock, id);
    this.onChange(id);
    return this.get(id)!;
  }

  /** Manager: take an item off the menu (or bring it back). Past orders keep their copy. */
  setHidden(id: string, hidden: boolean): MenuItem {
    if (!this.get(id)) throw new ShopError("not_found", "Menu item not found");
    this.db.prepare(`UPDATE menu_items SET active = ?, edited = 1 WHERE id = ?`).run(hidden ? 0 : 1, id);
    this.onChange(id);
    return this.get(id)!;
  }

  private requireActive(id: string): MenuItem {
    const item = this.get(id);
    if (!item || item.hidden) throw new ShopError("not_found", "Menu item not found");
    return item;
  }

  private validate(input: MenuItemInput): Required<MenuItemInput> {
    const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
    const category = String(input.category ?? "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 40) throw new ShopError("invalid_name", "Name must be 1-40 characters.");
    if (!category || category.length > 30) throw new ShopError("invalid_category", "Category must be 1-30 characters.");
    if (!Number.isInteger(input.price) || input.price < 0 || input.price > MAX_PRICE) {
      throw new ShopError("invalid_price", "Price must be between $0.00 and $1,000.00.");
    }
    const groups = new Set(this.optionGroups().map((g) => g.id));
    const options = Array.isArray(input.options) ? [...new Set(input.options.map(String))] : [];
    for (const g of options) if (!groups.has(g)) throw new ShopError("invalid_option", `Unknown option group "${g}".`);
    return { name, category, price: input.price, options, stock: checkStock(input.stock ?? null) };
  }

  private uniqueId(name: string): string {
    const base =
      name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "item";
    let id = base;
    for (let n = 2; this.db.prepare(`SELECT 1 FROM menu_items WHERE id = ?`).get(id); n++) id = `${base}-${n}`;
    return id;
  }

  private toItem(r: Row): MenuItem {
    const fromFile = this.config.menu.find((m) => m.id === r.id)?.options ?? [];
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      price: r.price,
      available: r.available === 1,
      options: r.options === null ? fromFile : (JSON.parse(r.options) as string[]),
      stock: r.stock,
      hidden: r.active !== 1,
    };
  }
}

function checkStock(stock: number | null): number | null {
  if (stock === null) return null;
  if (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK) throw new ShopError("invalid_stock", "Stock must be a whole number from 0 to 9,999.");
  return stock;
}
