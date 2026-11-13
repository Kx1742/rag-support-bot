import assert from "node:assert/strict";
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

const online = { name: "Jo", phone: "555 010 4444", pickupTime: "asap", items: [{ itemId: "latte", quantity: 1 }, { itemId: "croissant", quantity: 1 }] };

describe("order tracking tokens", () => {
  it("gives online orders a private token, and till orders none", async () => {
    const { shop } = await makeShop();
    const web = shop.orders.createOnline(online);
    const till = shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] });

    assert.match(web.trackingToken!, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(till.trackingToken, null);
    assert.equal(shop.orders.byTrackingToken(web.trackingToken!)?.id, web.id);
    assert.equal(shop.orders.byTrackingToken("not-a-real-token-at-all"), null);
    assert.equal(shop.orders.byTrackingToken("x' OR 1=1 --"), null);
  });

  it("only hands the token out when asked (right after ordering)", async () => {
    const { shop } = await makeShop();
    const order = shop.orders.createOnline(online);
    assert.equal(shop.orders.toPublic(order).trackingToken, undefined);
    assert.equal(shop.orders.toPublic(order, { withToken: true }).trackingToken, order.trackingToken);
  });

  it("records each line's category for the bar and kitchen screens", async () => {
    const { shop } = await makeShop();
    const order = shop.orders.createOnline(online);
    assert.deepEqual(
      order.items.map((l) => l.category),
      ["Coffee", "Food"],
    );
  });

  it("validates stations in shop.json", async () => {
    const good = (await loadShopConfig("bean-and-byte"))!;
    assert.deepEqual(
      good.stations?.map((s) => s.id),
      ["bar", "kitchen"],
    );
    assert.throws(() => validateShopConfig({ ...good, stations: [{ id: "bar", name: "Bar", categories: [] }] }), /at least one category/);
  });
});

describe("order tracking over HTTP", async () => {
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
    getAssistant: async () => assistant,
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

  it("the customer follows their order live, from placed to ready", async () => {
    const placed = await fetch(`${base}/api/tenants/${tenant.id}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(online),
    });
    const { order } = await placed.json();
    assert.ok(order.trackingToken, "the customer gets the token once");

    const track = await (await fetch(`${base}/api/tenants/${tenant.id}/orders/track?token=${order.trackingToken}`)).json();
    assert.equal(track.order.number, order.number);
    assert.equal(track.order.status, "new");
    assert.equal(track.order.trackingToken, undefined, "and it isn't echoed back later");
    assert.equal((await fetch(`${base}/api/tenants/${tenant.id}/orders/track?token=AAAAAAAAAAAAAAAAAAAAAAAA`)).status, 404);

    const events = await fetch(`${base}/api/tenants/${tenant.id}/orders/track/events?token=${order.trackingToken}`);
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = "";
    const waitFor = async (text: string) => {
      while (!received.includes(text)) received += (await reader.read()).value ?? "";
    };
    await waitFor('"status":"new"');

    const id = shop.orders.byTrackingToken(order.trackingToken)!.id;
    shop.orders.create({ type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] }); // someone else's order: no event
    shop.orders.setStatus(id, "preparing");
    await waitFor('"status":"preparing"');
    shop.orders.setStatus(id, "ready");
    await waitFor('"status":"ready"');
    await reader.cancel();
    assert.equal((received.match(/event: status/g) ?? []).length, 3, "only this order's changes are sent");
  });

  it("tells the desk about its stations", async () => {
    const login = await fetch(`${base}/api/desk/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenant.id, username: "owner", pin: "correct-horse-battery" }),
    });
    const me = await login.json();
    assert.deepEqual(
      me.stations.map((s: { name: string }) => s.name),
      ["Bar", "Kitchen"],
    );
  });
});
