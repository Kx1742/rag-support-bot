import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AnswerEvent } from "../src/rag/assistant.ts";
import { StaffAuth } from "../src/server/auth.ts";
import { createAppServer, type ChatAssistant } from "../src/server/http.ts";
import { DailyCap, RateLimiter } from "../src/server/rateLimit.ts";
import { loadShopConfig, validateShopConfig } from "../src/shop/config.ts";
import type { TenantConfig } from "../src/types.ts";
import { makeShop } from "./helpers.ts";

describe("receipts", () => {
  it("lists lines, reward, totals and the cash payment", async () => {
    const { shop } = await makeShop();
    const member = shop.loyalty.join("5550107777", "Kim");
    shop.loyalty.change(member.id, 100, "Bonus");
    const order = shop.orders.create(
      {
        type: "dine_in",
        tableId: "T4",
        customerName: "Kim",
        memberId: member.id,
        rewardId: "drink",
        items: [
          { itemId: "latte", quantity: 2, options: { size: "large", milk: "oat" } },
          { itemId: "croissant", quantity: 1 },
        ],
      },
      { by: { name: "Sam" }, payment: { method: "cash", tendered: 1000 } },
    );

    const r = shop.orders.receipt(order, "Bean & Byte Café");
    assert.equal(r.business.name, "Bean & Byte Café");
    assert.match(r.business.address, /Circuit Lane/);
    assert.equal(r.table, "Table 4");
    assert.equal(r.time, "10:00");
    assert.deepEqual(
      r.lines.map((l) => [l.quantity, l.name, l.optionsLabel, l.lineTotal]),
      [
        [2, "Caffè Latte", "Large · Oat milk", 1210],
        [1, "Butter Croissant", "", 350],
      ],
    );
    assert.deepEqual([r.subtotal, r.discount, r.total], [1560, 605, 955]);
    assert.equal(r.reward, "Free drink (any size)");
    assert.deepEqual(r.payment, { status: "paid", method: "cash", methodName: "Cash", tendered: 1000, change: 45, rounding: 0, amount: 955 });
    assert.deepEqual(r.charges, []);
    assert.equal(r.pointsEarned, 9);
    assert.equal(r.servedBy, "Sam");
  });

  it("validates receipt settings", async () => {
    const good = (await loadShopConfig("bean-and-byte"))!;
    assert.throws(() => validateShopConfig({ ...good, receipt: { footer: "x".repeat(201) } }), /receipt.footer/);
  });
});

describe("receipts and app files over HTTP", async () => {
  const { shop } = await makeShop();
  const tenant: TenantConfig = { id: "bean-and-byte", name: "Bean & Byte Café", assistantName: "Byte", tone: "", fallbackContact: "" };
  const assistant: ChatAssistant = {
    tenant,
    async *askStream(): AsyncIterable<AnswerEvent> {
      yield { type: "done", usedFallback: true, answered: false };
    },
  };
  let base = "";
  const server = createAppServer({
    getAssistant: async (id) => (id === tenant.id ? assistant : null),
    getShop: async () => shop,
    staffAuth: new StaffAuth({ passwordFor: () => "correct-horse-battery" }),
    loginLimiter: new RateLimiter({ capacity: 20, perMinute: 20 }),
    publicDir: resolve(import.meta.dirname, "..", "public"),
    defaultTenant: tenant.id,
    limiter: new RateLimiter({ capacity: 100, perMinute: 100 }),
    dailyCap: new DailyCap({ limit: 1000 }),
    log: () => {},
  });
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("prints a receipt at the desk with the business name", async () => {
    const login = await fetch(`${base}/api/desk/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenant.id, username: "owner", pin: "correct-horse-battery" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const order = shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] }, { payment: { method: "card" } });

    const res = await fetch(`${base}/api/desk/orders/${order.id}/receipt`, { headers: { Cookie: cookie } });
    const { receipt } = await res.json();
    assert.equal(receipt.business.name, "Bean & Byte Café");
    assert.equal(receipt.total, 525);
    assert.equal((await fetch(`${base}/api/desk/orders/99999/receipt`, { headers: { Cookie: cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/desk/orders/${order.id}/receipt`)).status, 401, "staff only");
  });

  it("gives the online customer a receipt once they've paid", async () => {
    const online = shop.orders.createOnline({ name: "Jo", phone: "5550104444", pickupTime: "asap", items: [{ itemId: "latte", quantity: 1 }] });
    const track = () => fetch(`${base}/api/tenants/${tenant.id}/orders/track?token=${online.trackingToken}`).then((r) => r.json());

    assert.equal((await track()).receipt, null, "no receipt before paying");
    shop.orders.pay(online.id, { method: "card" });
    const { receipt } = await track();
    assert.equal(receipt.payment.status, "paid");
    assert.equal(receipt.lines[0].name, "Caffè Latte");
    assert.ok(!JSON.stringify(receipt).includes("5550104444"), "no phone number on the receipt");
  });

  it("serves the installable-app files", async () => {
    for (const [path, type] of [
      ["/sw.js", /javascript/],
      ["/icon.svg", /image\/svg\+xml/],
      ["/app.webmanifest", /manifest\+json/],
      ["/desk.webmanifest", /manifest\+json/],
    ] as const) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type")!, type, path);
    }
    const manifest = await (await fetch(`${base}/desk.webmanifest`)).json();
    assert.equal(manifest.start_url, "/desk");
    assert.equal(manifest.display, "standalone");
  });

  it("never caches API data in the service worker", () => {
    const sw = readFileSync(resolve(import.meta.dirname, "..", "public", "sw.js"), "utf8");
    assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\)\) return;/);
    assert.match(sw, /event\.request\.method !== "GET"/);
  });
});
