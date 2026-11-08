import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewardDiscount } from "../src/shop/loyalty.ts";
import { FRIDAY_10AM, makeShop } from "./helpers.ts";

const latte = (options = {}, quantity = 1) => ({ itemId: "latte", quantity, options });
const DRINK = { id: "drink", name: "Free drink", points: 100, parts: [{ label: "drink", categories: ["Coffee", "Not Coffee"] }] };
const COMBO = {
  id: "combo",
  name: "Combo",
  points: 250,
  parts: [
    { label: "coffee", categories: ["Coffee"] },
    { label: "food item", categories: ["Food"] },
  ],
};

describe("reward maths", () => {
  const line = (itemId: string, category: string, unitPrice: number, quantity = 1) => ({ itemId, name: itemId, category, unitPrice, quantity });

  it("makes the most expensive matching item free", () => {
    const { discount, freeItems } = rewardDiscount(DRINK, [line("espresso", "Coffee", 300), line("latte", "Coffee", 685), line("croissant", "Food", 350)]);
    assert.equal(discount, 685);
    assert.deepEqual(freeItems, ["latte"]);
  });

  it("needs every part of a combo, using different units", () => {
    assert.equal(rewardDiscount(COMBO, [line("latte", "Coffee", 475), line("bagel", "Food", 800)]).discount, 1275);
    assert.throws(() => rewardDiscount(COMBO, [line("latte", "Coffee", 475, 2)]), /Add a food item/);
  });
});

describe("loyalty members", () => {
  it("joins by phone number and finds the member however the number is typed", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("(555) 010-7777", "Kim");
    assert.equal(shop.loyalty.find("555 010 7777")?.id, m.id);
    assert.throws(() => shop.loyalty.join("5550107777"), /already a member/);
    assert.throws(() => shop.loyalty.join("call me"), /valid phone/);
  });

  it("earns 1 point per whole dollar paid, at payment time", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("5550107777");
    const order = shop.orders.create({ type: "takeaway", items: [latte({}, 3)], memberId: m.id }); // $14.25, unpaid
    assert.equal(shop.loyalty.get(m.id)!.points, 0, "nothing until it's paid");
    const paid = shop.orders.pay(order.id, { method: "card" });
    assert.equal(paid.pointsEarned, 14);
    assert.equal(shop.loyalty.get(m.id)!.points, 14);
    assert.equal(shop.loyalty.history(m.id)[0].reason, `Earned on order #${order.number}`);
  });

  it("redeems a reward: discount on the order, points taken in the same step", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("5550107777");
    shop.loyalty.change(m.id, 120, "Welcome bonus");

    const order = shop.orders.create(
      { type: "takeaway", items: [latte({ size: "large", milk: "oat" }), { itemId: "croissant", quantity: 1 }], memberId: m.id, rewardId: "drink" },
      { payment: { method: "card" } },
    );
    assert.equal(order.subtotal, 605 + 350);
    assert.equal(order.discount, 605, "the large oat latte is free");
    assert.equal(order.total, 350);
    assert.equal(order.reward?.name, "Free drink (any size)");
    assert.equal(order.pointsEarned, 3);
    assert.equal(shop.loyalty.get(m.id)!.points, 120 - 100 + 3);
  });

  it("refuses a reward without enough points and saves nothing", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("5550107777");
    shop.loyalty.change(m.id, 40, "Bonus");
    assert.throws(
      () => shop.orders.create({ type: "takeaway", items: [{ itemId: "croissant", quantity: 1 }], memberId: m.id, rewardId: "pastry" }),
      /Not enough points: 40/,
    );
    assert.equal(shop.orders.list().length, 0);
    assert.equal(shop.loyalty.get(m.id)!.points, 40);
    assert.throws(() => shop.orders.create({ type: "takeaway", items: [latte()], rewardId: "drink" }), /Add a loyalty member/);
    assert.throws(() => shop.orders.create({ type: "takeaway", items: [latte()], memberId: m.id, rewardId: "pastry" }), /Add a pastry/);
  });

  it("gives points back when an order is cancelled or refunded", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("5550107777");
    shop.loyalty.change(m.id, 100, "Bonus");

    const unpaid = shop.orders.create({ type: "takeaway", items: [latte()], memberId: m.id, rewardId: "drink" });
    assert.equal(shop.loyalty.get(m.id)!.points, 0);
    shop.orders.setStatus(unpaid.id, "cancelled");
    assert.equal(shop.loyalty.get(m.id)!.points, 100, "reward points returned");

    const paid = shop.orders.create({ type: "takeaway", items: [latte({}, 4)], memberId: m.id }, { payment: { method: "card" } });
    assert.equal(shop.loyalty.get(m.id)!.points, 119);
    shop.orders.refund(paid.id, "Wrong order");
    assert.equal(shop.loyalty.get(m.id)!.points, 100, "earned points taken back");
  });

  it("taking back earned points never goes below zero", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("5550107777");
    const paid = shop.orders.create({ type: "takeaway", items: [latte({}, 20)], memberId: m.id }, { payment: { method: "card" } }); // 95 pts
    shop.loyalty.change(m.id, -90, "Spent elsewhere");
    shop.orders.refund(paid.id, "Mistake");
    assert.equal(shop.loyalty.get(m.id)!.points, 0);
  });

  it("points expire after 12 months without activity", async () => {
    const { shop, setNow } = await makeShop();
    const m = shop.loyalty.join("5550107777");
    shop.loyalty.change(m.id, 80, "Bonus");
    setNow(new Date("2027-11-14T15:00:00Z"));
    assert.equal(shop.loyalty.get(m.id)!.points, 0);
    assert.match(shop.loyalty.history(m.id)[0].reason, /Expired/);
  });

  it("summarises affordable rewards and the next goal", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("5550107777");
    shop.loyalty.change(m.id, 60, "Bonus");
    const s = shop.loyalty.summary(shop.loyalty.get(m.id)!);
    assert.deepEqual(
      s.rewards.map((r) => [r.id, r.affordable]),
      [
        ["pastry", true],
        ["drink", false],
        ["combo", false],
      ],
    );
    assert.deepEqual(s.nextReward, { name: "Free drink (any size)", pointsNeeded: 40 });
  });
});

describe("order ahead", () => {
  const online = (over: Record<string, unknown> = {}) => ({
    name: "Jo",
    phone: "555 010 4444",
    pickupTime: "asap",
    items: [latte({ milk: "oat" })],
    ...over,
  });

  it("creates an unpaid takeaway order marked online", async () => {
    const { shop } = await makeShop();
    const order = shop.orders.createOnline(online(), "web-order-0001");
    assert.equal(order.source, "online");
    assert.equal(order.type, "takeaway");
    assert.equal(order.payment.status, "unpaid");
    assert.equal(order.customerPhone, "5550104444");
    assert.equal(order.createdBy, "Online");
    assert.equal(order.total, 535);
    assert.deepEqual(shop.orders.toPublic(order).items, [{ name: "Caffè Latte", quantity: 1, optionsLabel: "Oat milk" }]);
    assert.equal(shop.orders.createOnline(online(), "web-order-0001").id, order.id, "retries don't duplicate");
  });

  it("only accepts pickup times while open, after prep time, before the kitchen closes", async () => {
    const { shop } = await makeShop(); // Friday 10:00, open 07:00-18:00, prep 10 min
    assert.equal(shop.orders.createOnline(online({ pickupTime: "10:15" })).pickupTime, "10:15");
    assert.throws(() => shop.orders.createOnline(online({ pickupTime: "10:05" })), /between 10:10 and 17:30/);
    assert.throws(() => shop.orders.createOnline(online({ pickupTime: "17:45" })), /between 10:10 and 17:30/);
    assert.throws(() => shop.orders.createOnline(online({ pickupTime: "soon" })), /asap/);

    const slots = shop.orders.pickupSlots();
    assert.equal(slots.slots[0], "10:15");
    assert.equal(slots.slots.at(-1), "17:30");
  });

  it("refuses orders when closed", async () => {
    const { shop } = await makeShop(new Date("2026-11-13T23:30:00Z")); // Friday 18:30
    assert.throws(() => shop.orders.createOnline(online()), /stopped taking orders/);
    assert.equal(shop.orders.pickupSlots().open, false);
  });

  it("limits order size and open orders per phone", async () => {
    const { shop } = await makeShop();
    assert.throws(() => shop.orders.createOnline(online({ items: [latte({}, 21)] })), /up to 20 items/);
    for (let i = 0; i < 3; i++) shop.orders.createOnline(online());
    assert.throws(() => shop.orders.createOnline(online()), /maximum number of open orders/);
    assert.ok(shop.orders.createOnline(online({ phone: "5550105555" })), "other customers can still order");
  });

  it("links a member with the same phone, who earns points when paying at pickup", async () => {
    const { shop } = await makeShop();
    const m = shop.loyalty.join("5550104444", "Jo");
    const order = shop.orders.createOnline(online({ items: [latte({}, 2)] }));
    assert.equal(order.member?.id, m.id);
    assert.equal(shop.orders.toPublic(order).memberPoints, true);
    shop.orders.pay(order.id, { method: "cash", tendered: 1000 });
    assert.equal(shop.loyalty.get(m.id)!.points, 9);
  });

  it("counts online orders and reward value in the summary", async () => {
    const { shop } = await makeShop(FRIDAY_10AM);
    const m = shop.loyalty.join("5550107777");
    shop.loyalty.change(m.id, 50, "Bonus");
    shop.orders.create({ type: "takeaway", items: [{ itemId: "croissant", quantity: 1 }], memberId: m.id, rewardId: "pastry" }, { payment: { method: "card" } });
    shop.orders.createOnline(online());
    const s = shop.orders.summary();
    assert.equal(s.rewards, 350);
    assert.equal(s.online, 1);
  });
});
