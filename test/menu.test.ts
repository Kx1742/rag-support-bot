import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Assistant } from "../src/rag/assistant.ts";
import { buildIndex } from "../src/rag/indexer.ts";
import { VectorStore } from "../src/rag/vectorStore.ts";
import { createBookingTools, liveMenu, soldOutNotices } from "../src/shop/chatTools.ts";
import type { TenantConfig } from "../src/types.ts";
import { FakeChat, FakeEmbedder } from "./fakes.ts";
import { makeShop } from "./helpers.ts";

const croissants = (quantity: number) => ({ type: "takeaway" as const, items: [{ itemId: "croissant", quantity }] });

describe("menu editing", () => {
  it("keeps desk edits and desk-added items when shop.json changes", async () => {
    const { shop } = await makeShop();
    shop.menu.update("latte", { name: "House Latte", category: "Coffee", price: 495, options: ["size", "milk"] });
    const pie = shop.menu.create({ name: "Apple Pie", category: "Food", price: 450 });
    assert.equal(pie.id, "apple-pie");

    // shop.json changes the latte price and drops the espresso.
    shop.menu.sync(shop.config.menu.filter((m) => m.id !== "espresso").map((m) => (m.id === "latte" ? { ...m, price: 999 } : m)));

    const latte = shop.menu.get("latte")!;
    assert.equal(latte.name, "House Latte");
    assert.equal(latte.price, 495, "the desk edit wins over shop.json");
    assert.deepEqual(latte.options, ["size", "milk"]);
    assert.equal(shop.menu.get("apple-pie")?.hidden, false, "desk-added items stay");
    assert.equal(shop.menu.get("espresso")?.hidden, true, "removed file items are hidden");
  });

  it("validates items and makes unique ids", async () => {
    const { shop } = await makeShop();
    assert.throws(() => shop.menu.create({ name: "", category: "Food", price: 100 }), /Name/);
    assert.throws(() => shop.menu.create({ name: "Tea", category: "Drinks", price: -1 }), /Price/);
    assert.throws(() => shop.menu.create({ name: "Tea", category: "Drinks", price: 300, options: ["sprinkles"] }), /Unknown option group/);
    assert.equal(shop.menu.create({ name: "Mocha", category: "Coffee", price: 500 }).id, "mocha-2");
  });

  it("prices desk-added items with their options", async () => {
    const { shop } = await makeShop();
    shop.menu.create({ name: "Iced Spanish Latte", category: "Coffee", price: 550, options: ["size", "milk"] });
    const order = shop.orders.create({
      type: "takeaway",
      items: [{ itemId: "iced-spanish-latte", quantity: 1, options: { size: "large", milk: "oat" } }],
    });
    assert.equal(order.total, 550 + 70 + 60);
    assert.throws(
      () => shop.orders.create({ type: "takeaway", items: [{ itemId: "iced-spanish-latte", quantity: 1, options: { "coffee-extras": ["iced"] } }] }),
      /doesn't have/,
    );
  });

  it("hidden items can't be ordered and can be brought back", async () => {
    const { shop } = await makeShop();
    shop.menu.setHidden("mocha", true);
    assert.ok(!shop.menu.list().some((m) => m.id === "mocha"));
    assert.ok(shop.menu.list({ includeHidden: true }).some((m) => m.id === "mocha"));
    assert.throws(() => shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] }), /Unknown menu item/);
    shop.menu.setHidden("mocha", false);
    assert.ok(shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] }));
  });
});

describe("stock counts", () => {
  it("counts down, sells out at zero and refuses to oversell", async () => {
    const { shop } = await makeShop();
    const events: unknown[] = [];
    shop.events.on("change", (e) => events.push(e));
    shop.menu.setStock("croissant", 3);

    shop.orders.create(croissants(2));
    assert.equal(shop.menu.get("croissant")!.stock, 1);
    assert.throws(() => shop.orders.create(croissants(2)), /Only 1 Butter Croissant left/);
    assert.equal(shop.orders.list().length, 1, "the failed order wasn't saved");

    shop.orders.create(croissants(1));
    const item = shop.menu.get("croissant")!;
    assert.equal(item.stock, 0);
    assert.equal(item.available, false, "sold out automatically");
    assert.throws(() => shop.orders.create(croissants(1)), /sold out/);
    assert.ok(events.some((e) => (e as { kind: string }).kind === "menu"), "the desk is told the menu changed");
  });

  it("adds up the same item across lines", async () => {
    const { shop } = await makeShop();
    shop.menu.setStock("croissant", 3);
    assert.throws(
      () =>
        shop.orders.create({
          type: "takeaway",
          items: [
            { itemId: "croissant", quantity: 2 },
            { itemId: "croissant", quantity: 2, options: { "food-extras": ["warmed"] } },
          ],
        }),
      /Only 3/,
    );
  });

  it("puts stock back when an order is cancelled or refunded", async () => {
    const { shop } = await makeShop();
    shop.menu.setStock("croissant", 2);
    const unpaid = shop.orders.create(croissants(2));
    assert.equal(shop.menu.get("croissant")!.available, false);

    shop.orders.setStatus(unpaid.id, "cancelled");
    assert.deepEqual([shop.menu.get("croissant")!.stock, shop.menu.get("croissant")!.available], [2, true]);

    const paid = shop.orders.create(croissants(1), { payment: { method: "card" } });
    shop.orders.refund(paid.id, "Dropped it");
    assert.equal(shop.menu.get("croissant")!.stock, 2);
  });

  it("switching a sold-out item back on stops counting it", async () => {
    const { shop } = await makeShop();
    shop.menu.setStock("croissant", 0);
    assert.equal(shop.menu.get("croissant")!.available, false);
    const item = shop.menu.setAvailable("croissant", true);
    assert.deepEqual([item.available, item.stock], [true, null]);
    assert.throws(() => shop.menu.setStock("croissant", -1), /Stock/);
  });
});

describe("chatbot and the live menu", () => {
  it("get_menu reports prices, sold-out items and low stock", async () => {
    const { shop } = await makeShop();
    shop.menu.setAvailable("mocha", false);
    shop.menu.setStock("croissant", 4);
    const menu = liveMenu(shop);
    const mocha = menu.items.find((i) => i.name === "Mocha")!;
    const croissant = menu.items.find((i) => i.name === "Butter Croissant")!;
    assert.equal(mocha.available, false);
    assert.equal(croissant.onlyLeft, 4);
    assert.equal(menu.items.find((i) => i.name === "Caffè Latte")!.price, "$4.75");
    assert.ok(menu.items.find((i) => i.name === "Caffè Latte")!.options.some((o) => o.includes("Large (+$0.70)")));

    const viaTool = (await createBookingTools(shop).runner.run({ name: "get_menu", args: {} })) as typeof menu;
    assert.equal(viaTool.items.length, menu.items.length);
    assert.match(createBookingTools(shop).instructions(), /call get_menu/);
  });

  it("warns about sold-out items the customer asks about", async () => {
    const { shop } = await makeShop();
    const notices = soldOutNotices(shop);
    assert.deepEqual(notices("Do you have almond croissants?"), []);

    shop.menu.setAvailable("almond-croissant", false);
    assert.deepEqual(notices("Do you have almond croissants?"), ["Heads up: Almond Croissant is sold out today."]);
    assert.deepEqual(notices("any croissants left?"), ["Heads up: Almond Croissant is sold out today."]);
    assert.deepEqual(notices("What time do you open?"), []);
  });

  it("shows the notice before the answer when the model has no tools", async () => {
    const { shop } = await makeShop();
    shop.menu.setAvailable("mocha", false);
    const tenant: TenantConfig = { id: "t", name: "Shop", assistantName: "Bot", tone: "", fallbackContact: "c" };
    const embedder = new FakeEmbedder();
    const index = await buildIndex("t", [{ docId: "menu.md", text: "# Menu\nMocha costs $5.25." }], embedder);
    const assistant = new Assistant({
      tenant,
      store: new VectorStore(index.chunks),
      embedder,
      chat: new FakeChat(),
      options: { minScore: 0.1 },
      notices: soldOutNotices(shop),
    });
    const answer = await assistant.ask("How much is a mocha?");
    assert.match(answer.text, /^Heads up: Mocha is sold out today\.\n\nFake answer/);
  });
});

describe("pickup board", () => {
  it("lists only order numbers, split into preparing and ready", async () => {
    const { shop } = await makeShop();
    const a = shop.orders.create({ type: "takeaway", customerName: "Secret Name", items: [{ itemId: "latte", quantity: 1 }] });
    const b = shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] });
    const c = shop.orders.create({ type: "takeaway", items: [{ itemId: "chai", quantity: 1 }] });
    shop.orders.setStatus(b.id, "ready");
    shop.orders.setStatus(c.id, "cancelled");

    const board = shop.orders.pickupBoard();
    assert.deepEqual(board, { preparing: [a.number], ready: [b.number] });
    assert.ok(!JSON.stringify(board).includes("Secret"));
  });

  it("puts the most recently called order first", async () => {
    const { shop, setNow } = await makeShop();
    const first = shop.orders.create({ type: "takeaway", items: [{ itemId: "latte", quantity: 1 }] });
    const second = shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] });
    shop.orders.setStatus(second.id, "ready");
    setNow(new Date("2026-11-13T15:01:00Z"));
    shop.orders.setStatus(first.id, "ready"); // called a minute later
    assert.deepEqual(shop.orders.pickupBoard().ready, [first.number, second.number]);
  });
});
