import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExtractiveChat, keywords, LocalEmbedder } from "../src/llm/offline.ts";
import { Assistant } from "../src/rag/assistant.ts";
import { buildIndex } from "../src/rag/indexer.ts";
import { VectorStore } from "../src/rag/vectorStore.ts";
import { cashDue, chargesFor, loadShopConfig, type ShopConfig, validateShopConfig } from "../src/shop/config.ts";
import { seedDemo } from "../src/shop/demo.ts";
import { loadTenant } from "../src/tenant.ts";
import { makeShop } from "./helpers.ts";

/** Friday 13 November 2026, 10:00 in Kuala Lumpur (UTC+8). */
const KL_10AM = new Date("2026-11-13T02:00:00Z");

async function kopiShop() {
  const config = (await loadShopConfig("kopi-kita"))!;
  return { config, ...(await makeShop(KL_10AM, config)) };
}

describe("SST, service charge and cash rounding", () => {
  it("adds the service charge for dine-in only, then SST on top (the documented example)", async () => {
    const { config } = await kopiShop();
    assert.deepEqual(
      chargesFor(config, "dine_in", 1000).map((c) => [c.name, c.amount]),
      [
        ["Service charge 10%", 100],
        ["SST 6%", 66],
      ],
    );
    assert.deepEqual(
      chargesFor(config, "takeaway", 1000).map((c) => [c.name, c.amount]),
      [["SST 6%", 60]],
    );
    // A café without charges adds nothing.
    assert.deepEqual(chargesFor({}, "dine_in", 1000), []);
  });

  it("rounds cash to the nearest 5 sen", () => {
    const rule = { cashRounding: 5 };
    assert.deepEqual([1166, 1167, 1168, 1170, 1162, 1163].map((t) => cashDue(rule, t)), [1165, 1165, 1170, 1170, 1160, 1165]);
    assert.equal(cashDue({}, 1166), 1166);
  });

  it("charges a dine-in cash order, rounds it, and reports SST collected", async () => {
    const { shop } = await kopiShop();
    const order = shop.orders.create(
      { type: "dine_in", tableId: "M3", items: [{ itemId: "mee-goreng", quantity: 1 }] },
      { payment: { method: "cash", tendered: 2000 } },
    );
    // RM9.00 + RM0.90 service + RM0.59 SST = RM10.49, paid in cash as RM10.50.
    assert.deepEqual(
      order.charges.map((c) => c.amount),
      [90, 59],
    );
    assert.equal(order.total, 1049);
    assert.deepEqual([order.payment.rounding, order.payment.amount, order.payment.change], [1, 1050, 950]);

    const receipt = shop.orders.receipt(order, "Kopi Kita");
    assert.deepEqual(receipt.charges, [
      { name: "Service charge 10%", amount: 90 },
      { name: "SST 6%", amount: 59 },
    ]);
    assert.equal(receipt.payment.rounding, 1);

    const summary = shop.orders.summary();
    assert.equal(summary.sales, 1050);
    assert.equal(summary.cash, 1050);
    assert.equal(summary.rounding, 1);
    assert.deepEqual(summary.charges, [
      { name: "Service charge 10%", amount: 90 },
      { name: "SST 6%", amount: 59 },
    ]);
  });

  it("needs the rounded amount in cash, not more", async () => {
    const { shop } = await kopiShop();
    // Teh tarik takeaway: RM3.20 + RM0.19 SST = RM3.39 -> RM3.40 in cash.
    const order = shop.orders.create({ type: "takeaway", items: [{ itemId: "teh-tarik", quantity: 1 }] });
    assert.equal(order.total, 339);
    assert.throws(() => shop.orders.pay(order.id, { method: "cash", tendered: 339 }), /less than the total/);
    const paid = shop.orders.pay(order.id, { method: "cash", tendered: 340 });
    assert.deepEqual([paid.payment.amount, paid.payment.change], [340, 0]);
  });

  it("takes DuitNow QR for the exact amount, but only where the café accepts QR", async () => {
    const { shop } = await kopiShop();
    const order = shop.orders.create({ type: "takeaway", items: [{ itemId: "teh-tarik", quantity: 1 }] }, { payment: { method: "qr" } });
    assert.deepEqual([order.payment.method, order.payment.amount, order.payment.rounding], ["qr", 339, 0]);
    assert.equal(shop.orders.receipt(order, "Kopi Kita").payment.methodName, "DuitNow QR");
    assert.equal(shop.orders.summary().qr, 339);

    const bean = (await makeShop()).shop;
    const other = bean.orders.create({ type: "takeaway", items: [{ itemId: "latte", quantity: 1 }] });
    assert.throws(() => bean.orders.pay(other.id, { method: "qr" }), /cash or card/);
  });

  it("adds SST but no service charge to online orders (they're takeaway)", async () => {
    const { shop } = await kopiShop();
    const order = shop.orders.createOnline({ name: "Aina", phone: "0123456789", pickupTime: "asap", items: [{ itemId: "kopi", quantity: 2 }] });
    assert.deepEqual(
      order.charges.map((c) => [c.id, c.amount]),
      [["sst", 34]],
    );
    assert.equal(shop.orders.toPublic(order).total, 594);
  });

  it("validates charges, payment methods and rounding in shop.json", async () => {
    const { config } = await kopiShop();
    const bad = (patch: Partial<ShopConfig>) => () => validateShopConfig({ ...config, ...patch });
    assert.throws(bad({ charges: [{ id: "sst", name: "SST", percent: 0 }] }), /percent/);
    assert.throws(bad({ charges: [{ id: "a", name: "A", percent: 6 }, { id: "a", name: "B", percent: 6 }] }), /duplicate/);
    assert.throws(bad({ payments: { methods: ["cash", "cheque" as "cash"] } }), /payments.methods/);
    assert.throws(bad({ payments: { methods: [] } }), /payments.methods/);
    assert.throws(bad({ cashRounding: 3 }), /cashRounding/);
  });
});

describe("the Malaysian demo café", () => {
  it("seeds believable demo data from its own menu", async () => {
    const { shop } = await kopiShop();
    await seedDemo(shop);
    const orders = shop.orders.list();
    assert.ok(orders.length >= 5, `expected demo orders, got ${orders.length}`);
    assert.ok(orders.some((o) => o.payment.method === "qr"), "one demo order is paid by DuitNow QR");
    assert.ok(orders.some((o) => o.type === "dine_in" && o.charges.some((c) => c.id === "service")));
    assert.ok(orders.every((o) => o.items.every((l) => shop.config.menu.some((m) => m.id === l.itemId))));
  });

  it("finds answers to Chinese and Malay questions offline", async () => {
    assert.deepEqual(keywords("营业时间"), ["营业", "业时", "时间"]);
    assert.deepEqual(keywords("Kopi O 好喝"), ["kopi", "好喝"]);

    const { config, docs } = await loadTenant("kopi-kita");
    const embedder = new LocalEmbedder();
    const assistant = new Assistant({
      tenant: config,
      store: new VectorStore((await buildIndex(config.id, docs, embedder)).chunks),
      embedder,
      chat: new ExtractiveChat({ delayMs: 0 }),
      options: { minScore: 0.15 },
    });
    const cases: [string, string, RegExp][] = [
      ["你们的营业时间是几点？", "faq-chinese.md", /早上7点/],
      ["有清真认证吗？", "faq-chinese.md", /JAKIM/],
      ["Boleh bayar guna DuitNow QR?", "faq-malay.md", /DuitNow QR/],
      ["Is your food halal?", "halal-and-dietary.md", /pork-free/],
      ["Do you charge service charge for takeaway?", "payments-and-charges.md", /takeaway/i],
    ];
    for (const [question, docId, expected] of cases) {
      const answer = await assistant.ask(question);
      assert.equal(answer.sources[0]?.docId, docId, question);
      assert.match(answer.text, expected, question);
    }
    // Every suggested question on the welcome screen gets a real answer, even offline.
    for (const question of config.suggestedQuestions ?? []) {
      const answer = await assistant.ask(question);
      assert.equal(answer.usedFallback, false, `no answer for suggested question "${question}"`);
    }
  });
});
