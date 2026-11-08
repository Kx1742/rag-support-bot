import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadShopConfig, validateShopConfig } from "../src/shop/config.ts";
import { assertPin } from "../src/shop/staff.ts";
import { makeShop } from "./helpers.ts";

const by = { name: "Sam" };
const latte = (options = {}, quantity = 1) => ({ itemId: "latte", quantity, options });

describe("drink options", () => {
  it("prices options on the server and labels only the non-default choices", async () => {
    const { shop } = await makeShop();
    const order = shop.orders.create(
      {
        type: "takeaway",
        items: [
          latte({ size: "large", milk: "oat", "coffee-extras": ["extra-shot", "iced"] }, 2),
          latte(), // all defaults
          { itemId: "croissant", quantity: 1, options: { "food-extras": ["warmed"] }, note: "cut in half" },
        ],
      },
      { by },
    );
    const [fancy, plain, croissant] = order.items;
    assert.equal(fancy.unitPrice, 475 + 70 + 60 + 80);
    assert.equal(fancy.lineTotal, 2 * 685);
    assert.equal(fancy.optionsLabel, "Large · Oat milk · Extra shot · Iced");
    assert.equal(plain.unitPrice, 475);
    assert.equal(plain.optionsLabel, "", "defaults (Regular, Whole milk) aren't shown to the kitchen");
    assert.equal(croissant.optionsLabel, "Warmed");
    assert.equal(croissant.note, "cut in half");
    assert.equal(order.total, 2 * 685 + 475 + 350);
    assert.equal(order.createdBy, "Sam");
  });

  it("rejects options an item doesn't have, unknown choices and bad shapes", async () => {
    const { shop } = await makeShop();
    const make = (item: object) => () => shop.orders.create({ type: "takeaway", items: [item as never] });
    assert.throws(make({ itemId: "espresso", quantity: 1, options: { milk: "oat" } }), /doesn't have "milk"/);
    assert.throws(make(latte({ size: "venti" })), /Unknown size "venti"/);
    assert.throws(make(latte({ size: ["large"] })), /Pick one size/);
    assert.throws(make(latte({ "coffee-extras": ["extra-shot", "extra-shot"] })), /Invalid extras/);
    assert.throws(make(latte({ "coffee-extras": ["gold-flakes"] })), /Unknown option/);
  });

  it("validates option groups in shop.json", async () => {
    const good = (await loadShopConfig("bean-and-byte"))!;
    const bad = structuredClone(good);
    bad.optionGroups![0].choices.forEach((c) => (c.default = false));
    assert.throws(() => validateShopConfig(bad), /exactly one default/);
    const missing = structuredClone(good);
    missing.menu[0].options = ["nope"];
    assert.throws(() => validateShopConfig(missing), /unknown option group/);
  });
});

describe("payments", () => {
  it("takes cash at order time and works out the change", async () => {
    const { shop } = await makeShop();
    const order = shop.orders.create({ type: "takeaway", items: [latte()] }, { by, payment: { method: "cash", tendered: 1000 } });
    assert.equal(order.payment.status, "paid");
    assert.equal(order.payment.method, "cash");
    assert.equal(order.payment.change, 525);
    assert.equal(order.payment.paidBy, "Sam");
  });

  it("refuses short or absurd cash amounts", async () => {
    const { shop } = await makeShop();
    const pay = (tendered: number) => () =>
      shop.orders.create({ type: "takeaway", items: [latte()] }, { payment: { method: "cash", tendered } });
    assert.throws(pay(400), /less than the total/);
    assert.throws(pay(475 + 200_000), /looks wrong/);
    assert.equal(shop.orders.list().length, 0, "a failed payment creates no order");
  });

  it("lets a tab be paid later, by card, once", async () => {
    const { shop } = await makeShop();
    const tab = shop.orders.create({ type: "dine_in", tableId: "T4", items: [latte()] });
    assert.equal(tab.payment.status, "unpaid");

    const paid = shop.orders.pay(tab.id, { method: "card" }, { name: "Ana" });
    assert.equal(paid.payment.tendered, paid.total);
    assert.equal(paid.payment.change, 0);
    assert.throws(() => shop.orders.pay(tab.id, { method: "card" }), /already paid/);
  });

  it("won't cancel a paid order: it has to be refunded", async () => {
    const { shop } = await makeShop();
    const order = shop.orders.create({ type: "takeaway", items: [latte()] }, { payment: { method: "card" } });
    assert.throws(() => shop.orders.setStatus(order.id, "cancelled"), /needs to refund/);

    assert.throws(() => shop.orders.refund(order.id, "  "), /reason/);
    const refunded = shop.orders.refund(order.id, "Wrong order", { name: "Mia (manager)" });
    assert.equal(refunded.status, "cancelled");
    assert.equal(refunded.payment.status, "refunded");
    assert.equal(refunded.payment.refundedBy, "Mia (manager)");
    assert.throws(() => shop.orders.refund(order.id, "again"), /Only paid orders/);
  });

  it("returns the same order when a till retries with the same clientRef", async () => {
    const { shop } = await makeShop();
    const input = { type: "takeaway" as const, items: [latte()] };
    const first = shop.orders.create(input, { clientRef: "till-1-0f8a2c1b", payment: { method: "card" } });
    const retry = shop.orders.create(input, { clientRef: "till-1-0f8a2c1b", payment: { method: "card" } });
    assert.equal(retry.id, first.id);
    assert.equal(shop.orders.list().length, 1);
    assert.throws(() => shop.orders.create(input, { clientRef: "bad ref!" }), /clientRef/);
  });

  it("summarises the day and builds an end-of-day report", async () => {
    const { shop } = await makeShop();
    shop.orders.create({ type: "takeaway", items: [latte({}, 2)] }, { payment: { method: "cash", tendered: 1000 } });
    shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] }, { payment: { method: "card" } });
    shop.orders.create({ type: "dine_in", tableId: "T1", items: [{ itemId: "espresso", quantity: 1 }] });
    const refunded = shop.orders.create({ type: "takeaway", items: [{ itemId: "chai", quantity: 1 }] }, { payment: { method: "card" } });
    shop.orders.refund(refunded.id, "Customer changed mind");

    const s = shop.orders.summary();
    assert.deepEqual(
      { sales: s.sales, cash: s.cash, card: s.card, unpaid: s.unpaid, unpaidTotal: s.unpaidTotal, refunds: s.refunds, orders: s.orders },
      { sales: 950 + 525, cash: 950, card: 525, unpaid: 1, unpaidTotal: 300, refunds: 475, orders: 3 },
    );

    const report = shop.orders.report();
    assert.deepEqual(
      report.items.map((i) => [i.name, i.quantity, i.sales]),
      [
        ["Caffè Latte", 2, 950],
        ["Mocha", 1, 525],
      ],
    );
    assert.equal(report.averageOrder, Math.round((950 + 525) / 2));
    assert.deepEqual(report.hours, [{ hour: 10, orders: 2, sales: 1475 }]);
    assert.equal(report.refunds[0].reason, "Customer changed mind");
  });
});

describe("staff accounts", () => {
  it("creates accounts with hashed PINs and checks them", async () => {
    const { shop } = await makeShop();
    const sam = await shop.staff.create({ username: "Sam", name: "Sam Lee", role: "staff", pin: "4826" });
    assert.equal(sam.username, "sam");
    assert.ok(!("pin_hash" in sam) && !("pin" in sam), "the PIN never leaves the database");

    assert.equal((await shop.staff.authenticate("SAM", "4826"))?.id, sam.id);
    assert.equal(await shop.staff.authenticate("sam", "4827"), null);
    assert.equal(await shop.staff.authenticate("nobody", "4826"), null);
  });

  it("rejects weak PINs, bad usernames and duplicates", async () => {
    const { shop } = await makeShop();
    for (const pin of ["1234", "0000", "9876", "12", "abcd"]) assert.throws(() => assertPin(pin), /PIN/);
    assertPin("4826");
    await assert.rejects(shop.staff.create({ username: "owner", name: "X", role: "staff", pin: "4826" }), /reserved/);
    await assert.rejects(shop.staff.create({ username: "a b", name: "X", role: "staff", pin: "4826" }), /Username/);
    await shop.staff.create({ username: "sam", name: "Sam", role: "staff", pin: "4826" });
    await assert.rejects(shop.staff.create({ username: "sam", name: "Sam 2", role: "staff", pin: "5937" }), /already used/);
  });

  it("locks an account for 5 minutes after 5 wrong PINs", async () => {
    let now = new Date("2026-11-13T15:00:00Z");
    const { shop, setNow } = await makeShop(now);
    await shop.staff.create({ username: "sam", name: "Sam", role: "staff", pin: "4826" });
    for (let i = 0; i < 5; i++) assert.equal(await shop.staff.authenticate("sam", "0001"), null);
    assert.equal(await shop.staff.authenticate("sam", "4826"), null, "locked, even with the right PIN");

    now = new Date(now.getTime() + 5 * 60_000 + 1000);
    setNow(now);
    assert.ok(await shop.staff.authenticate("sam", "4826"));
  });

  it("deactivated accounts can't log in, and the last manager can't be removed", async () => {
    const { shop } = await makeShop();
    const boss = await shop.staff.create({ username: "mia", name: "Mia", role: "manager", pin: "5937" });
    const sam = await shop.staff.create({ username: "sam", name: "Sam", role: "staff", pin: "4826" });

    await shop.staff.update(sam.id, { active: false });
    assert.equal(await shop.staff.authenticate("sam", "4826"), null);

    await assert.rejects(shop.staff.update(boss.id, { role: "staff" }), /at least one active manager/);
    await assert.rejects(shop.staff.update(boss.id, { active: false }), /at least one active manager/);
    await shop.staff.update(sam.id, { active: true, role: "manager" });
    assert.equal((await shop.staff.update(boss.id, { role: "staff" })).role, "staff");
  });

  it("a PIN reset replaces the old PIN and clears a lockout", async () => {
    const { shop } = await makeShop();
    const sam = await shop.staff.create({ username: "sam", name: "Sam", role: "staff", pin: "4826" });
    for (let i = 0; i < 5; i++) await shop.staff.authenticate("sam", "0001");
    await shop.staff.update(sam.id, { pin: "7351" });
    assert.ok(await shop.staff.authenticate("sam", "7351"));
    assert.equal(await shop.staff.authenticate("sam", "4826"), null);
  });
});
