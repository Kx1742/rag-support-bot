import type { Shop } from "./shop.ts";
import type { Role } from "./staff.ts";
import { addDays, toMinutes } from "./time.ts";

/**
 * Public demo accounts. Their PINs are shown on the login screen in demo mode,
 * and the desk refuses to change or deactivate them so one visitor can't lock out the rest.
 */
export const DEMO_ACCOUNTS: { username: string; name: string; role: Role; pin: string }[] = [
  { username: "demo-barista", name: "Demo Barista", role: "staff", pin: "2580" },
  { username: "demo-manager", name: "Demo Manager", role: "manager", pin: "1357" },
];

export const DEMO_MEMBER_PHONE = "5550100100";

export function isDemoAccount(username: string): boolean {
  return DEMO_ACCOUNTS.some((a) => a.username === username);
}

/**
 * Fills an empty shop with a believable morning: staff accounts, a loyalty member,
 * orders in every kitchen stage, bookings today and tomorrow, and some stock counts.
 * Everything goes through the normal services, so the same rules apply as for real data.
 * Steps that don't fit the current time (e.g. the café is closed) are skipped.
 */
export async function seedDemo(shop: Shop): Promise<void> {
  for (const account of DEMO_ACCOUNTS) await shop.staff.create(account);

  const tryIt = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  // Loyalty member with enough points to try a reward.
  const member = shop.loyalty.enabled ? tryIt(() => shop.loyalty.join(DEMO_MEMBER_PHONE, "Demo Member")) : null;
  if (member) shop.loyalty.change(member.id, 120, "Demo welcome points");

  // Stock counts, one of them running low.
  tryIt(() => shop.menu.setStock("croissant", 8));
  tryIt(() => shop.menu.setStock("almond-croissant", 2));

  // Orders in every kitchen stage.
  const by = { name: "Demo Barista" };
  const done = tryIt(() =>
    shop.orders.create({ type: "takeaway", customerName: "Sam", items: [{ itemId: "latte", quantity: 2 }] }, { by, payment: { method: "card" } }),
  );
  if (done) {
    shop.orders.setStatus(done.id, "ready");
    shop.orders.setStatus(done.id, "completed");
  }
  const ready = tryIt(() =>
    shop.orders.create(
      { type: "takeaway", customerName: "Lena", items: [{ itemId: "mocha", quantity: 1, options: { size: "large" } }] },
      { by, payment: { method: "cash", tendered: 1000 } },
    ),
  );
  if (ready) shop.orders.setStatus(ready.id, "ready");
  const preparing = tryIt(() =>
    shop.orders.create(
      {
        type: "takeaway",
        customerName: "Demo Member",
        memberId: member?.id ?? null,
        items: [
          { itemId: "flat-white", quantity: 1, options: { milk: "oat" } },
          { itemId: "croissant", quantity: 1, options: { "food-extras": ["warmed"] } },
        ],
      },
      { by, payment: { method: "card" } },
    ),
  );
  if (preparing) shop.orders.setStatus(preparing.id, "preparing");
  tryIt(() =>
    shop.orders.create(
      {
        type: "dine_in",
        tableId: "T4",
        notes: "No onions on the toast",
        items: [
          { itemId: "avo-toast", quantity: 1 },
          { itemId: "chai", quantity: 2 },
        ],
      },
      { by },
    ),
  );
  tryIt(() =>
    shop.orders.createOnline({
      name: "Online Olivia",
      phone: "5550100200",
      pickupTime: "asap",
      items: [{ itemId: "cold-brew", quantity: 1, options: { milk: "oat" } }],
    }),
  );

  // Bookings: a couple later today (one already seated), a few tomorrow.
  const { date: today, minutes: now } = shop.bookings.today();
  const book = (date: string, pick: (times: string[]) => string | undefined, partySize: number, name: string, phone: string, notes = "") =>
    tryIt(() => {
      const time = pick(shop.bookings.availableTimes(date, partySize, { staff: true }).times);
      return time ? shop.bookings.create({ date, time, partySize, name, phone, notes }, "staff") : null;
    });
  const seated = book(today, (t) => t.find((x) => toMinutes(x) <= now) ?? t[0], 2, "Marco Rossi", "5550100300");
  if (seated) tryIt(() => shop.bookings.setStatus(seated.id, "seated"));
  book(today, (t) => t.find((x) => toMinutes(x) >= now + 45), 4, "Priya Shah", "5550100400", "Birthday, candle on the brownie");
  const tomorrow = addDays(today, 1);
  book(tomorrow, (t) => t[2], 2, "Hana Kim", "5550100500");
  book(tomorrow, (t) => t[6], 6, "Team breakfast", "5550100600", "High chair please");
}
