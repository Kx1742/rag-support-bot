import type { OrderLineInput } from "./orders.ts";
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

  // Works for any café: each line names a preferred item per demo café (first one on this menu wins),
  // and only keeps the options that item actually has.
  const menu = shop.menu.list();
  const itemId = (ids: string[]) => ids.find((id) => menu.some((m) => m.id === id)) ?? ids[0];
  const line = (ids: string[], quantity: number, options: Record<string, string | string[]> = {}): OrderLineInput => {
    const item = menu.find((m) => m.id === itemId(ids));
    const kept = Object.fromEntries(Object.entries(options).filter(([group]) => item?.options.includes(group)));
    return { itemId: itemId(ids), quantity, options: kept };
  };
  const qrOrCard = shop.config.payments?.methods.includes("qr") ? "qr" : "card";
  const fourSeater = shop.config.tables.find((t) => t.seats === 4)?.id ?? shop.config.tables[0]?.id;

  // Stock counts, one of them running low.
  tryIt(() => shop.menu.setStock(itemId(["croissant", "curry-puff"]), 8));
  tryIt(() => shop.menu.setStock(itemId(["almond-croissant", "kuih-lapis"]), 2));

  // Orders in every kitchen stage.
  const by = { name: "Demo Barista" };
  const done = tryIt(() =>
    shop.orders.create({ type: "takeaway", customerName: "Sam", items: [line(["latte", "kopi"], 2)] }, { by, payment: { method: "card" } }),
  );
  if (done) {
    shop.orders.setStatus(done.id, "ready");
    shop.orders.setStatus(done.id, "completed");
  }
  const ready = tryIt(() =>
    shop.orders.create(
      { type: "takeaway", customerName: "Lena", items: [line(["mocha", "teh-tarik"], 1, { size: "large", temp: "iced" })] },
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
          line(["flat-white", "white-coffee"], 1, { milk: "oat", sugar: "less" }),
          line(["croissant", "nasi-lemak"], 1, { "food-extras": ["warmed"], "nasi-extras": ["egg"] }),
        ],
      },
      { by, payment: { method: qrOrCard } },
    ),
  );
  if (preparing) shop.orders.setStatus(preparing.id, "preparing");
  tryIt(() =>
    shop.orders.create(
      {
        type: "dine_in",
        tableId: fourSeater,
        notes: itemId(["avo-toast", "mee-goreng"]) === "avo-toast" ? "No onions on the toast" : "Mee goreng tak nak pedas (not spicy)",
        items: [line(["avo-toast", "mee-goreng"], 1), line(["chai", "teh-o-limau"], 2, { temp: "iced" })],
      },
      { by },
    ),
  );
  tryIt(() =>
    shop.orders.createOnline({
      name: "Online Olivia",
      phone: "5550100200",
      pickupTime: "asap",
      items: [line(["cold-brew", "kopi-c"], 1, { milk: "oat", temp: "iced", sugar: "none" })],
    }),
  );

  // What customers asked the chat assistant over the past week, for the owner's report.
  const hoursAgo = (h: number) => new Date(shop.now().getTime() - h * 3_600_000);
  const asked: [string, boolean, number][] = [
    ["Is there a baby changing table?", false, 2],
    ["Do you have a baby changing table?", false, 20],
    ["Is there a baby changing table?", false, 70],
    ["Baby changing table?", false, 120],
    ["Is there a kids menu?", false, 5],
    ["Do you have a kids menu?", false, 50],
    ["Is there a power socket for laptops?", false, 30],
    ["What time do you open on Sunday?", true, 1],
    ["Do you have oat milk?", true, 3],
    ["How does the loyalty program work?", true, 8],
    ["Is your food halal?", true, 9],
    ["What time do you close today?", true, 12],
    ["Can I pay by card?", true, 26],
    ["Do you take bookings for 6 people?", true, 40],
    ["Where are you located?", true, 60],
    ["Do you have vegan options?", true, 90],
    ["What time do you open tomorrow?", true, 100],
  ];
  for (const [question, answered, h] of asked) tryIt(() => shop.questions.record(question, answered, hoursAgo(h)));

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
