import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizePhone } from "../src/shop/bookings.ts";
import { loadShopConfig, validateShopConfig } from "../src/shop/config.ts";
import { ShopError } from "../src/shop/errors.ts";
import { zonedNow } from "../src/shop/time.ts";
import { FRIDAY_10AM, makeShop } from "./helpers.ts";

const guest = (over: Record<string, unknown> = {}) => ({
  date: "2026-11-14",
  time: "10:00",
  partySize: 2,
  name: "Amy Lee",
  phone: "555 010 1111",
  ...over,
});

describe("time helpers", () => {
  it("converts now into the shop's timezone", () => {
    assert.deepEqual(zonedNow("America/New_York", FRIDAY_10AM), { date: "2026-11-13", minutes: 600 });
    assert.deepEqual(zonedNow("Asia/Tokyo", FRIDAY_10AM), { date: "2026-11-14", minutes: 0 });
  });

  it("normalizes phone numbers", () => {
    assert.equal(normalizePhone("(555) 010-2040"), "5550102040");
    assert.equal(normalizePhone("+60 12-345 6789"), "+60123456789");
    assert.equal(normalizePhone("call me"), "");
    assert.equal(normalizePhone("123"), "");
  });
});

describe("shop config", () => {
  it("rejects broken configs", async () => {
    const good = (await loadShopConfig("bean-and-byte"))!;
    assert.throws(() => validateShopConfig({ ...good, timezone: "Mars/Base" }), /timezone/);
    assert.throws(() => validateShopConfig({ ...good, openingHours: { mon: ["18:00", "07:00"] } }), /open before close/);
    assert.throws(() => validateShopConfig({ ...good, tables: [...good.tables, good.tables[0]] }), /duplicate/);
  });
});

describe("booking availability", () => {
  it("lists slots that end by closing time", async () => {
    const { shop } = await makeShop();
    const sat = shop.bookings.availableTimes("2026-11-14", 2).times;
    assert.equal(sat[0], "08:00");
    assert.equal(sat.at(-1), "15:30"); // closes 17:00, bookings last 90 min
    assert.equal(sat.length, 16);
    assert.equal(shop.bookings.availableTimes("2026-11-15", 2).times.at(-1), "13:30"); // Sunday 9-15
  });

  it("respects the notice period today", async () => {
    const { shop } = await makeShop();
    assert.equal(shop.bookings.availableTimes("2026-11-13", 2).times[0], "11:00"); // now 10:00 + 60 min
    const tooSoon = shop.bookings.check("2026-11-13", "10:30", 2);
    assert.equal(tooSoon.available, false);
    assert.match(tooSoon.reason!, /60 minutes' notice/);
  });

  it("explains closed, past and too-far dates", async () => {
    const { shop } = await makeShop();
    assert.match(shop.bookings.availableTimes("2026-12-25", 2, { staff: true }).reason!, /closed on Friday, 25 December 2026/);
    assert.match(shop.bookings.availableTimes("2026-11-12", 2).reason!, /past/);
    assert.match(shop.bookings.availableTimes("2027-01-30", 2).reason!, /30 days/);
    assert.throws(() => shop.bookings.availableTimes("2026-02-30", 2), ShopError);
    assert.throws(() => shop.bookings.availableTimes("2026-11-14", 7), /up to 6 people/);
  });
});

describe("creating bookings", () => {
  it("gives each party the smallest free table, then reports alternatives", async () => {
    const { shop } = await makeShop();
    const tables = [];
    for (let i = 0; i < 6; i++) {
      tables.push(shop.bookings.create(guest({ phone: `555010200${i}` }), "web").tableId);
    }
    assert.deepEqual(tables, ["T1", "T2", "T3", "T4", "T5", "T6"]);

    const full = shop.bookings.check("2026-11-14", "10:00", 2);
    assert.equal(full.available, false);
    assert.match(full.reason!, /fully booked/);
    // 10:30 and 11:00 overlap the 90-minute bookings; 11:30 is free again.
    assert.deepEqual(full.alternatives, ["08:00", "08:30", "11:30"]);
    assert.throws(() => shop.bookings.create(guest({ phone: "5550109999" }), "web"), /just booked/);
  });

  it("validates input and limits bookings per phone", async () => {
    const { shop } = await makeShop();
    assert.throws(() => shop.bookings.create(guest({ name: " " }), "chat"), /name/);
    assert.throws(() => shop.bookings.create(guest({ phone: "nope" }), "chat"), /phone/);
    assert.throws(() => shop.bookings.create(guest({ time: "10:15" }), "chat"), /can't be booked/);

    shop.bookings.create(guest(), "chat");
    shop.bookings.create(guest({ time: "12:00" }), "chat");
    assert.throws(() => shop.bookings.create(guest({ time: "14:00" }), "chat"), /maximum number/);
    // Staff aren't limited, and can take walk-ins without a phone.
    const walkIn = shop.bookings.create({ ...guest({ time: "14:00" }), phone: "" }, "staff");
    assert.equal(walkIn.source, "staff");
  });

  it("lets staff book the current slot and a chosen table", async () => {
    const { shop } = await makeShop();
    const b = shop.bookings.create({ ...guest({ date: "2026-11-13", time: "10:00", tableId: "T6" }), phone: "" }, "staff");
    assert.equal(b.tableName, "Big Table 6");
    assert.throws(() => shop.bookings.create(guest({ date: "2026-11-13", time: "10:00" }), "web"), /can't be booked/);
  });

  it("generates readable unique references", async () => {
    const { shop } = await makeShop();
    const b = shop.bookings.create(guest(), "web");
    assert.match(b.reference, /^BB-[A-HJKMNP-Z2-9]{5}$/);
    assert.deepEqual(Object.keys(shop.bookings.toPublic(b)).sort(), ["date", "dateText", "name", "partySize", "reference", "status", "time"]);
  });
});

describe("changing bookings", () => {
  it("cancels by reference + phone and frees the table", async () => {
    const { shop } = await makeShop();
    const b = shop.bookings.create(guest({ partySize: 6 }), "chat");
    assert.equal(shop.bookings.check("2026-11-14", "10:00", 6).available, false);

    assert.throws(() => shop.bookings.cancelByReference(b.reference, "5550000000"), /No booking matches/);
    assert.throws(() => shop.bookings.cancelByReference("BB-XXXXX", "555 010 1111"), /No booking matches/);
    assert.equal(shop.bookings.cancelByReference(b.reference.toLowerCase(), "555-010-1111").status, "cancelled");
    assert.equal(shop.bookings.check("2026-11-14", "10:00", 6).available, true);
    assert.throws(() => shop.bookings.cancelByReference(b.reference, "555 010 1111"), /already cancelled/);
  });

  it("only allows sensible status changes and emits events", async () => {
    const { shop } = await makeShop();
    const events: unknown[] = [];
    shop.events.on("change", (e) => events.push(e));
    const b = shop.bookings.create(guest(), "web");

    assert.equal(shop.bookings.setStatus(b.id, "seated").status, "seated");
    assert.equal(shop.bookings.setStatus(b.id, "completed").status, "completed");
    assert.throws(() => shop.bookings.setStatus(b.id, "no_show"), /Can't change/);
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], { kind: "booking", id: b.id, action: "created" });
    assert.deepEqual(events[1], { kind: "booking", id: b.id, action: "updated" });
  });

  it("won't restore a no-show if the table was rebooked", async () => {
    const { shop } = await makeShop();
    const b = shop.bookings.create(guest({ partySize: 6 }), "web");
    shop.bookings.setStatus(b.id, "no_show");
    shop.bookings.create(guest({ partySize: 6, phone: "5550103333" }), "web");
    assert.throws(() => shop.bookings.setStatus(b.id, "confirmed"), /booked by someone else/);
  });
});

describe("menu and orders", () => {
  it("prices orders from the database and numbers them per day", async () => {
    const { shop, setNow } = await makeShop();
    const first = shop.orders.create({
      type: "takeaway",
      customerName: "Ben",
      items: [
        { itemId: "flat-white", quantity: 2 },
        { itemId: "oat-milk", quantity: 2, note: "for both" },
        { itemId: "croissant", quantity: 1 },
      ],
    });
    assert.equal(first.number, 1);
    assert.equal(first.total, 2 * 450 + 2 * 60 + 350);
    assert.equal(first.items[1].note, "for both");
    assert.equal(first.tableId, null);

    const second = shop.orders.create({ type: "dine_in", tableId: "T4", items: [{ itemId: "mocha", quantity: 1 }] });
    assert.equal(second.number, 2);
    assert.equal(second.tableId, "T4");

    setNow(new Date("2026-11-14T15:00:00Z"));
    assert.equal(shop.orders.create({ type: "takeaway", items: [{ itemId: "espresso", quantity: 1 }] }).number, 1);
  });

  it("rejects bad orders and sold-out items", async () => {
    const { shop } = await makeShop();
    assert.throws(() => shop.orders.create({ type: "takeaway", items: [] }), /at least one/);
    assert.throws(() => shop.orders.create({ type: "takeaway", items: [{ itemId: "caviar", quantity: 1 }] }), /Unknown menu item/);
    assert.throws(() => shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 0 }] }), /Quantity/);
    assert.throws(() => shop.orders.create({ type: "dine_in", tableId: "T99", items: [{ itemId: "mocha", quantity: 1 }] }), /Unknown table/);

    shop.menu.setAvailable("mocha", false);
    assert.throws(() => shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] }), /sold out/);
  });

  it("moves orders through the kitchen flow and summarizes the day", async () => {
    const { shop } = await makeShop();
    const a = shop.orders.create({ type: "takeaway", items: [{ itemId: "latte", quantity: 2 }] });
    const b = shop.orders.create({ type: "takeaway", items: [{ itemId: "chai", quantity: 1 }] });

    for (const s of ["preparing", "ready", "completed"] as const) shop.orders.setStatus(a.id, s);
    shop.orders.setStatus(b.id, "cancelled");
    assert.throws(() => shop.orders.setStatus(b.id, "new"), /Can't change/);

    assert.deepEqual(shop.orders.summary(), { orders: 1, items: 2, sales: 950, open: 0 });
  });

  it("keeps sold-out flags when the menu file changes", async () => {
    const { shop } = await makeShop();
    shop.menu.setAvailable("mocha", false);
    shop.menu.sync([
      { id: "mocha", name: "Mocha", category: "Coffee", price: 550 },
      { id: "tea", name: "Tea", category: "Not Coffee", price: 300 },
    ]);
    assert.deepEqual(shop.menu.list(), [
      { id: "mocha", name: "Mocha", category: "Coffee", price: 550, available: false },
      { id: "tea", name: "Tea", category: "Not Coffee", price: 300, available: true },
    ]);
  });
});
