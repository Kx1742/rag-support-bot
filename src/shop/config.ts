import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertValidTenantId, TENANTS_DIR } from "../tenant.ts";
import { isTime, toMinutes, WEEKDAYS, type Weekday } from "./time.ts";

export interface TableConfig {
  id: string;
  name: string;
  seats: number;
}

export interface MenuItemConfig {
  id: string;
  name: string;
  category: string;
  /** Price in cents. */
  price: number;
  /** Ids of option groups (size, milk...) this item offers. */
  options?: string[];
}

export interface OptionChoice {
  id: string;
  name: string;
  /** Extra cost in cents (0 for free choices). */
  price: number;
  /** The pre-selected choice in a "single" group. */
  default?: boolean;
}

/** "single" = pick exactly one (size, milk); "multi" = pick any (extra shot, iced). */
export interface OptionGroup {
  id: string;
  name: string;
  type: "single" | "multi";
  choices: OptionChoice[];
}

export interface ShopConfig {
  timezone: string;
  currency: string;
  /** Prefix for booking references, e.g. "BB" -> "BB-7K3QX". */
  referencePrefix: string;
  /** Missing day = closed. Times are "HH:MM" in the shop's timezone. */
  openingHours: Partial<Record<Weekday, [string, string]>>;
  closedDates: string[];
  booking: {
    durationMinutes: number;
    slotMinutes: number;
    minNoticeMinutes: number;
    maxDaysAhead: number;
    maxActivePerPhone: number;
  };
  tables: TableConfig[];
  menu: MenuItemConfig[];
  optionGroups?: OptionGroup[];
  /** Optional loyalty program. Leave out to turn loyalty off. */
  loyalty?: LoyaltyConfig;
  /** Optional order-ahead (pickup) settings. Leave out to turn online ordering off. */
  orderAhead?: {
    /** Minutes needed to make an order; earliest pickup is now + this. */
    prepMinutes: number;
    /** Most items (units) in one online order. */
    maxItems: number;
    /** Most open online orders per phone number at once. */
    maxOpenPerPhone: number;
  };
}

/** One reward, e.g. "Free drink" for 100 points. Each part makes one matching item free. */
export interface LoyaltyReward {
  id: string;
  name: string;
  points: number;
  /** e.g. [{ categories: ["Coffee"], label: "coffee" }, { categories: ["Food"], label: "food item" }] for a combo. */
  parts: { label: string; categories?: string[]; items?: string[] }[];
}

export interface LoyaltyConfig {
  name: string;
  pointsPerDollar: number;
  /** Points expire after this many months without any activity. */
  expiryMonths: number;
  rewards: LoyaltyReward[];
}

/** Loads tenants/<id>/shop.json. Returns null when the tenant has no shop features. */
export async function loadShopConfig(tenantId: string, tenantsDir = TENANTS_DIR): Promise<ShopConfig | null> {
  assertValidTenantId(tenantId);
  let raw: string;
  try {
    raw = await readFile(join(tenantsDir, tenantId, "shop.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const config = JSON.parse(raw) as ShopConfig;
  validateShopConfig(config);
  return config;
}

/** Fails fast on config mistakes instead of producing odd bookings later. */
export function validateShopConfig(c: ShopConfig): void {
  const fail = (msg: string) => {
    throw new Error(`Invalid shop.json: ${msg}`);
  };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: c.timezone });
  } catch {
    fail(`unknown timezone "${c.timezone}"`);
  }
  if (!/^[A-Z0-9]{1,6}$/.test(c.referencePrefix)) fail("referencePrefix must be 1-6 uppercase letters/digits");

  for (const [day, hours] of Object.entries(c.openingHours)) {
    if (!WEEKDAYS.includes(day as Weekday)) fail(`unknown weekday "${day}"`);
    if (!hours || !isTime(hours[0]) || !isTime(hours[1]) || toMinutes(hours[0]) >= toMinutes(hours[1])) {
      fail(`opening hours for ${day} must be ["HH:MM", "HH:MM"] with open before close`);
    }
  }
  const b = c.booking;
  for (const key of ["durationMinutes", "slotMinutes", "minNoticeMinutes", "maxDaysAhead", "maxActivePerPhone"] as const) {
    if (!Number.isInteger(b[key]) || b[key] < 0) fail(`booking.${key} must be a non-negative integer`);
  }
  if (b.slotMinutes < 5 || b.durationMinutes < b.slotMinutes) fail("booking.slotMinutes/durationMinutes are too small");

  const ids = new Set<string>();
  for (const t of c.tables) {
    if (!t.id || ids.has(t.id)) fail(`duplicate or missing table id "${t.id}"`);
    if (!Number.isInteger(t.seats) || t.seats < 1) fail(`table ${t.id} needs seats >= 1`);
    ids.add(t.id);
  }
  const groups = new Map<string, OptionGroup>();
  for (const g of c.optionGroups ?? []) {
    if (!/^[a-z0-9-]+$/.test(g.id) || groups.has(g.id)) fail(`duplicate or invalid option group id "${g.id}"`);
    if (g.type !== "single" && g.type !== "multi") fail(`option group ${g.id} type must be "single" or "multi"`);
    if (!g.choices?.length) fail(`option group ${g.id} needs at least one choice`);
    const choiceIds = new Set<string>();
    for (const ch of g.choices) {
      if (!/^[a-z0-9-]+$/.test(ch.id) || choiceIds.has(ch.id)) fail(`duplicate or invalid choice "${ch.id}" in ${g.id}`);
      if (!Number.isInteger(ch.price) || ch.price < 0) fail(`choice ${g.id}/${ch.id} needs a price in cents`);
      choiceIds.add(ch.id);
    }
    const defaults = g.choices.filter((ch) => ch.default).length;
    if (g.type === "single" && defaults !== 1) fail(`option group ${g.id} needs exactly one default choice`);
    if (g.type === "multi" && defaults > 0) fail(`option group ${g.id} is multi-choice and can't have defaults`);
    groups.set(g.id, g);
  }

  const itemIds = new Set<string>();
  for (const m of c.menu) {
    if (!/^[a-z0-9-]+$/.test(m.id) || itemIds.has(m.id)) fail(`duplicate or invalid menu id "${m.id}"`);
    if (!Number.isInteger(m.price) || m.price < 0) fail(`menu item ${m.id} needs a price in cents`);
    for (const groupId of m.options ?? []) {
      if (!groups.has(groupId)) fail(`menu item ${m.id} uses unknown option group "${groupId}"`);
    }
    itemIds.add(m.id);
  }

  if (c.loyalty) {
    const l = c.loyalty;
    if (!Number.isInteger(l.pointsPerDollar) || l.pointsPerDollar < 1) fail("loyalty.pointsPerDollar must be a whole number >= 1");
    if (!Number.isInteger(l.expiryMonths) || l.expiryMonths < 1) fail("loyalty.expiryMonths must be a whole number >= 1");
    const rewardIds = new Set<string>();
    for (const r of l.rewards ?? []) {
      if (!/^[a-z0-9-]+$/.test(r.id) || rewardIds.has(r.id)) fail(`duplicate or invalid reward id "${r.id}"`);
      if (!Number.isInteger(r.points) || r.points < 1) fail(`reward ${r.id} needs points >= 1`);
      if (!r.parts?.length) fail(`reward ${r.id} needs at least one part`);
      for (const p of r.parts) {
        if (!p.label || (!p.categories?.length && !p.items?.length)) fail(`reward ${r.id} parts need a label and categories or items`);
      }
      rewardIds.add(r.id);
    }
  }
  if (c.orderAhead) {
    const o = c.orderAhead;
    for (const key of ["prepMinutes", "maxItems", "maxOpenPerPhone"] as const) {
      if (!Number.isInteger(o[key]) || o[key] < 1) fail(`orderAhead.${key} must be a whole number >= 1`);
    }
  }
}
