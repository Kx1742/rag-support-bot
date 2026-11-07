import { loadShopConfig, type ShopConfig } from "../src/shop/config.ts";
import { openDatabase } from "../src/shop/db.ts";
import { Shop } from "../src/shop/shop.ts";

/** Friday 13 November 2026, 10:00 in New York (UTC-5). */
export const FRIDAY_10AM = new Date("2026-11-13T15:00:00Z");

/** A demo café shop on an in-memory database with a controllable clock. */
export async function makeShop(now = FRIDAY_10AM, config?: ShopConfig) {
  const cfg = config ?? (await loadShopConfig("bean-and-byte"))!;
  let clock = now;
  const shop = new Shop({ tenantId: "bean-and-byte", config: cfg, db: openDatabase(":memory:"), now: () => clock });
  return { shop, setNow: (d: Date) => (clock = d) };
}
