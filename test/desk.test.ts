import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AnswerEvent } from "../src/rag/assistant.ts";
import { passwordFromEnv, StaffAuth } from "../src/server/auth.ts";
import { createAppServer, type ChatAssistant } from "../src/server/http.ts";
import { DailyCap, RateLimiter } from "../src/server/rateLimit.ts";
import type { TenantConfig } from "../src/types.ts";
import { makeShop } from "./helpers.ts";

const PASSWORD = "correct-horse-battery";

describe("StaffAuth", () => {
  it("reads per-tenant passwords and ignores short ones", () => {
    const lookup = passwordFromEnv({ STAFF_PASSWORD: "shared-password", STAFF_PASSWORD_BEAN_AND_BYTE: "cafe-password" });
    assert.equal(lookup("bean-and-byte"), "cafe-password");
    assert.equal(lookup("other-shop"), "shared-password");
    assert.equal(passwordFromEnv({ STAFF_PASSWORD: "short" })("x"), undefined);
  });

  it("issues sessions that expire", () => {
    let now = 0;
    const auth = new StaffAuth({ passwordFor: () => PASSWORD, ttlMs: 1000, now: () => now });
    assert.equal(auth.login("t", "wrong"), null);
    const token = auth.login("t", PASSWORD)!;
    assert.equal(auth.verify(token)?.tenantId, "t");
    now = 1000;
    assert.equal(auth.verify(token), null);
  });
});

describe("desk and booking HTTP API", async () => {
  const { shop } = await makeShop();
  const tenant: TenantConfig = { id: "bean-and-byte", name: "Bean & Byte Café", assistantName: "Byte", tone: "", fallbackContact: "" };
  const assistant: ChatAssistant = {
    tenant,
    async *askStream(): AsyncIterable<AnswerEvent> {
      yield { type: "done", usedFallback: true };
    },
  };

  let base = "";
  const server = createAppServer({
    getAssistant: async (id) => (id === tenant.id ? assistant : null),
    getShop: async (id) => (id === tenant.id ? shop : null),
    staffAuth: new StaffAuth({ passwordFor: (id) => (id === tenant.id ? PASSWORD : undefined) }),
    loginLimiter: new RateLimiter({ capacity: 3, perMinute: 1 }),
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

  let cookie = "";
  const desk = (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) =>
    fetch(`${base}/api/desk${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...((init.cookie ?? cookie) ? { Cookie: init.cookie ?? cookie } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

  it("rejects desk requests without a session", async () => {
    assert.equal((await desk("/bookings", { cookie: "" })).status, 401);
    assert.equal((await desk("/me", { cookie: "desk_session=forged" })).status, 401);
  });

  it("rejects wrong passwords and unknown businesses with the same message", async () => {
    const wrong = await desk("/login", { method: "POST", body: { tenantId: tenant.id, password: "nope" } });
    const unknown = await desk("/login", { method: "POST", body: { tenantId: "other", password: PASSWORD } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), await unknown.json());
  });

  it("logs in with a locked-down session cookie", async () => {
    const res = await desk("/login", { method: "POST", body: { tenantId: tenant.id, password: PASSWORD } });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/api\/desk/);
    cookie = setCookie.split(";")[0];
    const me = await res.json();
    assert.equal(me.today, "2026-11-13");
    assert.equal(me.tables.length, 6);
  });

  it("serves the desk page", async () => {
    const res = await fetch(`${base}/desk`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /desk\.js/);
  });

  it("takes orders at the till and moves them through the kitchen", async () => {
    const created = await desk("/orders", {
      method: "POST",
      body: { type: "takeaway", customerName: "Ben", items: [{ itemId: "latte", quantity: 2 }], total: 1 },
    });
    assert.equal(created.status, 201);
    const { order } = await created.json();
    assert.equal(order.total, 950, "server ignores the client's total and uses menu prices");

    const moved = await desk(`/orders/${order.id}`, { method: "PATCH", body: { status: "preparing" } });
    assert.equal((await moved.json()).order.status, "preparing");

    const bad = await desk(`/orders/${order.id}`, { method: "PATCH", body: { status: "teleported" } });
    assert.equal(bad.status, 400);

    const list = await (await desk("/orders")).json();
    assert.equal(list.summary.open, 1);
  });

  it("marks menu items sold out", async () => {
    const res = await desk("/menu/mocha", { method: "PATCH", body: { available: false } });
    assert.equal((await res.json()).item.available, false);
    const order = await desk("/orders", { method: "POST", body: { type: "takeaway", items: [{ itemId: "mocha", quantity: 1 }] } });
    assert.equal(order.status, 409);
    assert.match((await order.json()).error, /sold out/);
  });

  it("lets customers book online without exposing staff data", async () => {
    const avail = await (await fetch(`${base}/api/tenants/${tenant.id}/availability?date=2026-11-14&partySize=4`)).json();
    assert.ok(avail.times.includes("10:00"));

    const res = await fetch(`${base}/api/tenants/${tenant.id}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-11-14", time: "10:00", partySize: 4, name: "Amy", phone: "555 010 1111" }),
    });
    assert.equal(res.status, 201);
    const { booking } = await res.json();
    assert.match(booking.reference, /^BB-/);
    assert.ok(!("phone" in booking) && !("tableId" in booking), "public response hides phone and table");

    const info = await (await fetch(`${base}/api/tenants/${tenant.id}`)).json();
    assert.deepEqual(info.booking, { today: "2026-11-13", maxPartySize: 6, maxDaysAhead: 30 });
  });

  it("explains why a booking can't be made", async () => {
    const res = await fetch(`${base}/api/tenants/${tenant.id}/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-11-14", time: "10:00", partySize: 9, name: "Big group", phone: "5550102222" }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /up to 6 people/);
  });

  it("shows bookings on the desk and pushes live changes", async () => {
    const events = await desk("/events");
    assert.match(events.headers.get("content-type")!, /text\/event-stream/);
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
    let received = "";
    const waitFor = async (text: string) => {
      while (!received.includes(text)) received += (await reader.read()).value ?? "";
    };
    await waitFor("event: ready");

    const created = await desk("/bookings", {
      method: "POST",
      body: { date: "2026-11-13", time: "10:00", partySize: 2, name: "Walk-in", tableId: "T3" },
    });
    assert.equal(created.status, 201, "staff can seat walk-ins now, without a phone");
    await waitFor('"kind":"booking"');
    await reader.cancel();

    const { bookings } = await (await desk("/bookings?date=2026-11-14")).json();
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].phone, "5550101111", "staff can see the phone number");

    const seated = await desk(`/bookings/${bookings[0].id}`, { method: "PATCH", body: { status: "seated" } });
    assert.equal((await seated.json()).booking.status, "seated");
  });

  it("logs out", async () => {
    await desk("/logout", { method: "POST" });
    assert.equal((await desk("/me")).status, 401);
  });

  it("rate limits login attempts", async () => {
    let res: Response | undefined;
    for (let i = 0; i < 5; i++) {
      res = await desk("/login", { method: "POST", body: { tenantId: tenant.id, password: "guess" }, cookie: "" });
      if (res.status === 429) break;
    }
    assert.equal(res!.status, 429);
  });
});
