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

  it("checks the owner password and issues sessions that expire", () => {
    let now = 0;
    const auth = new StaffAuth({ passwordFor: () => PASSWORD, ttlMs: 1000, now: () => now });
    assert.equal(auth.checkOwner("t", "wrong"), false);
    assert.equal(auth.checkOwner("t", PASSWORD), true);
    const token = auth.start({ tenantId: "t", staffId: null, username: "owner", name: "Owner", role: "manager" });
    assert.equal(auth.verify(token)?.role, "manager");
    now = 1000;
    assert.equal(auth.verify(token), null);
  });

  it("can sign one person out everywhere", () => {
    const auth = new StaffAuth({ passwordFor: () => PASSWORD });
    const sam = { tenantId: "t", staffId: 7, username: "sam", name: "Sam", role: "staff" as const };
    const a = auth.start(sam);
    const b = auth.start(sam);
    const other = auth.start({ ...sam, staffId: 8, username: "ana" });
    auth.endSessionsFor("t", 7);
    assert.equal(auth.verify(a), null);
    assert.equal(auth.verify(b), null);
    assert.ok(auth.verify(other));
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
    loginLimiter: new RateLimiter({ capacity: 20, perMinute: 1 }),
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

  // ----- roles -----

  const login = async (body: object) => {
    const res = await desk("/login", { method: "POST", body: { tenantId: tenant.id, ...body }, cookie: "" });
    return { res, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "", me: await res.json() };
  };
  let managerCookie = "";
  let staffCookie = "";
  let staffId = 0;

  it("owner adds a manager and a staff member", async () => {
    const owner = await login({ username: "owner", pin: PASSWORD });
    assert.equal(owner.me.user.role, "manager");

    const add = (body: object) => desk("/staff", { method: "POST", body, cookie: owner.cookie });
    assert.equal((await add({ username: "mia", name: "Mia", role: "manager", pin: "5937" })).status, 201);
    const sam = await add({ username: "sam", name: "Sam", role: "staff", pin: "4826" });
    assert.equal(sam.status, 201);
    staffId = (await sam.json()).member.id;
    assert.equal((await add({ username: "weak", name: "Weak", role: "staff", pin: "1111" })).status, 400);

    const list = await (await desk("/staff", { cookie: owner.cookie })).json();
    assert.deepEqual(list.staff.map((s: { username: string }) => s.username).sort(), ["mia", "sam"]);
    assert.ok(!JSON.stringify(list).includes("scrypt"), "PIN hashes never leave the server");
    assert.ok(list.rolePermissions.manager.includes("staff.manage"));
  });

  it("staff log in with their own PIN and get a limited role", async () => {
    assert.equal((await login({ username: "sam", pin: "0000" })).res.status, 401);
    const sam = await login({ username: "sam", pin: "4826" });
    assert.equal(sam.res.status, 200);
    assert.equal(sam.me.user.role, "staff");
    assert.ok(!sam.me.permissions.includes("payments.refund"));
    staffCookie = sam.cookie;
    managerCookie = (await login({ username: "mia", pin: "5937" })).cookie;
  });

  it("staff can ring up and take payment, but can't see sales, refund or manage people", async () => {
    const as = (cookie: string) => (path: string, init: { method?: string; body?: unknown } = {}) => desk(path, { ...init, cookie });
    const staff = as(staffCookie);
    const manager = as(managerCookie);

    const created = await staff("/orders", {
      method: "POST",
      body: {
        type: "takeaway",
        clientRef: "till-test-0001",
        items: [{ itemId: "latte", quantity: 1, options: { size: "large", milk: "oat" } }],
        payment: { method: "cash", tendered: 1000 },
      },
    });
    assert.equal(created.status, 201);
    const { order } = await created.json();
    assert.equal(order.total, 475 + 70 + 60);
    assert.equal(order.payment.change, 1000 - 605);
    assert.equal(order.createdBy, "Sam");

    const summary = (await (await staff("/orders")).json()).summary;
    assert.equal(summary.sales, undefined, "staff don't see money totals");
    assert.ok((await (await manager("/orders")).json()).summary.sales >= 605);

    for (const [path, init] of [
      ["/report", {}],
      ["/staff", {}],
      [`/orders/${order.id}/refund`, { method: "POST", body: { reason: "test" } }],
      ["/staff", { method: "POST", body: { username: "x", name: "X", role: "manager", pin: "5937" } }],
    ] as const) {
      const res = await staff(path, init);
      assert.equal(res.status, 403, `${path} should be managers only`);
      assert.match((await res.json()).error, /Only managers/);
    }

    const cancel = await staff(`/orders/${order.id}`, { method: "PATCH", body: { status: "cancelled" } });
    assert.equal(cancel.status, 409, "paid orders can't be cancelled, only refunded");

    const refund = await manager(`/orders/${order.id}/refund`, { method: "POST", body: { reason: "Wrong milk" } });
    assert.equal(refund.status, 200);
    assert.equal((await refund.json()).order.payment.refundedBy, "Mia");

    const report = await (await manager("/report")).json();
    assert.equal(report.refunds[0].reason, "Wrong milk");
  });

  it("deactivating someone signs them out immediately", async () => {
    assert.equal((await desk("/me", { cookie: staffCookie })).status, 200);
    const off = await desk(`/staff/${staffId}`, { method: "PATCH", body: { active: false }, cookie: managerCookie });
    assert.equal(off.status, 200);
    const me = await desk("/me", { cookie: staffCookie });
    assert.equal(me.status, 401);
    assert.equal((await login({ username: "sam", pin: "4826" })).res.status, 401);
  });

  it("managers can't lock themselves out", async () => {
    const me = await (await desk("/me", { cookie: managerCookie })).json();
    const list = await (await desk("/staff", { cookie: managerCookie })).json();
    const mia = list.staff.find((s: { username: string }) => s.username === me.user.username);
    const res = await desk(`/staff/${mia.id}`, { method: "PATCH", body: { active: false }, cookie: managerCookie });
    assert.equal(res.status, 400);
  });

  it("staff set stock counts; only managers edit the menu", async () => {
    await desk("/staff", { method: "POST", body: { username: "leo", name: "Leo", role: "staff", pin: "6284" }, cookie: managerCookie });
    const leo = (await login({ username: "leo", pin: "6284" })).cookie;

    const stock = await desk("/menu/croissant", { method: "PATCH", body: { stock: 12 }, cookie: leo });
    assert.equal(stock.status, 200);
    assert.equal((await stock.json()).item.stock, 12);

    for (const body of [{ name: "X", category: "Food", price: 1 }, { hidden: true }]) {
      assert.equal((await desk("/menu/croissant", { method: "PATCH", body, cookie: leo })).status, 403);
    }
    assert.equal((await desk("/menu", { method: "POST", body: { name: "Pie", category: "Food", price: 450 }, cookie: leo })).status, 403);

    const added = await desk("/menu", { method: "POST", body: { name: "Apple Pie", category: "Food", price: 450, stock: 6 }, cookie: managerCookie });
    assert.equal(added.status, 201);
    await desk("/menu/apple-pie", { method: "PATCH", body: { hidden: true }, cookie: managerCookie });
    const staffMenu = (await (await desk("/menu", { cookie: leo })).json()).menu;
    const managerMenu = (await (await desk("/menu", { cookie: managerCookie })).json()).menu;
    assert.ok(!staffMenu.some((m: { id: string }) => m.id === "apple-pie"), "staff don't see hidden items");
    assert.ok(managerMenu.some((m: { id: string; hidden: boolean }) => m.id === "apple-pie" && m.hidden));

    const oversell = await desk("/orders", { method: "POST", body: { type: "takeaway", items: [{ itemId: "croissant", quantity: 13 }] }, cookie: leo });
    assert.equal(oversell.status, 409);
    assert.match((await oversell.json()).error, /Only 12/);
  });

  it("the public pickup screen gets order numbers only", async () => {
    const res = await fetch(`${base}/api/tenants/${tenant.id}/pickup`);
    assert.equal(res.status, 200);
    const board = await res.json();
    assert.deepEqual(Object.keys(board).sort(), ["name", "preparing", "ready"]);
    assert.ok(board.preparing.every((n: unknown) => typeof n === "number"));
    assert.ok(!JSON.stringify(board).includes("Ben"), "no customer names");
    assert.equal((await fetch(`${base}/display`)).status, 200);
  });

  it("staff add loyalty members and redeem rewards at the till", async () => {
    const leo = (await login({ username: "leo", pin: "6284" })).cookie;
    assert.equal((await desk("/loyalty?phone=5550108888", { cookie: leo })).status, 404);

    const joined = await desk("/loyalty", { method: "POST", body: { phone: "555 010 8888", name: "Robin" }, cookie: leo });
    assert.equal(joined.status, 201);
    const { member } = await joined.json();
    shop.loyalty.change(member.id, 60, "Test bonus");

    const order = await desk("/orders", {
      method: "POST",
      cookie: leo,
      body: { type: "takeaway", items: [{ itemId: "banana-bread", quantity: 1 }], memberId: member.id, rewardId: "pastry", payment: { method: "card" } },
    });
    assert.equal(order.status, 201);
    const o = (await order.json()).order;
    assert.deepEqual([o.total, o.discount, o.reward.name], [0, 375, "Free pastry"]);

    const lookup = await (await desk("/loyalty?phone=5550108888", { cookie: leo })).json();
    assert.equal(lookup.summary.points, 10);
    assert.ok(lookup.history.some((h: { reason: string }) => h.reason.startsWith("Redeemed Free pastry")));

    const broke = await desk("/orders", {
      method: "POST",
      cookie: leo,
      body: { type: "takeaway", items: [{ itemId: "banana-bread", quantity: 1 }], memberId: member.id, rewardId: "pastry" },
    });
    assert.equal(broke.status, 409);
  });

  it("customers order ahead and check points without seeing anyone's details", async () => {
    const post = (path: string, body: object) =>
      fetch(`${base}/api/tenants/${tenant.id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const menu = await (await fetch(`${base}/api/tenants/${tenant.id}/menu`)).json();
    assert.ok(menu.menu.length > 5 && menu.ordering.open);
    assert.ok(menu.menu.every((m: { available?: boolean; stock?: unknown }) => !("stock" in m)), "exact stock isn't public");

    const placed = await post("orders", {
      name: "Robin",
      phone: "5550108888",
      pickupTime: "asap",
      items: [{ itemId: "latte", quantity: 1, options: { size: "large" } }],
    });
    assert.equal(placed.status, 201);
    const { order } = await placed.json();
    assert.equal(order.total, 545);
    assert.equal(order.memberPoints, true);
    assert.deepEqual(Object.keys(order).sort(), ["items", "memberPoints", "number", "pickupTime", "status", "total", "trackingToken"]);

    const desks = await (await desk("/orders", { cookie: managerCookie })).json();
    const seen = desks.orders.find((x: { number: number }) => x.number === order.number);
    assert.equal(seen.source, "online");
    assert.equal(seen.customerPhone, "5550108888");

    const points = await post("loyalty", { phone: "555-010-8888" });
    const body = await points.json();
    assert.equal(body.points, 10);
    assert.ok(!JSON.stringify(body).includes("Robin"), "no name in the public answer");
    assert.equal((await post("loyalty", { phone: "5550100001" })).status, 404);

    const info = await (await fetch(`${base}/api/tenants/${tenant.id}`)).json();
    assert.equal(info.orderAhead, true);
    assert.deepEqual(info.loyalty, { name: "Byte Points" });
  });

  it("customers can look up and cancel only their own booking", async () => {
    const post = (path: string, body: object) =>
      fetch(`${base}/api/tenants/${tenant.id}/bookings/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const made = await (
      await fetch(`${base}/api/tenants/${tenant.id}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: "2026-11-15", time: "10:00", partySize: 2, name: "Lee", phone: "555 010 5555" }),
      })
    ).json();
    const ref = made.booking.reference;

    const wrong = await post("lookup", { reference: ref, phone: "555 010 0000" });
    const missing = await post("lookup", { reference: "BB-ZZZZZ", phone: "555 010 5555" });
    assert.equal(wrong.status, 404);
    assert.deepEqual(await wrong.json(), await missing.json(), "same answer, so references can't be probed");

    const found = await (await post("lookup", { reference: ref.toLowerCase(), phone: "(555) 010-5555" })).json();
    assert.equal(found.booking.name, "Lee");
    assert.ok(!("phone" in found.booking));

    const cancelled = await (await post("cancel", { reference: ref, phone: "5550105555" })).json();
    assert.equal(cancelled.booking.status, "cancelled");
    assert.equal((await post("cancel", { reference: ref, phone: "5550105555" })).status, 409);
  });

  it("logs out", async () => {
    await desk("/logout", { method: "POST" });
    assert.equal((await desk("/me")).status, 401);
  });

  it("rate limits login attempts", async () => {
    let res: Response | undefined;
    for (let i = 0; i < 30; i++) {
      res = await desk("/login", { method: "POST", body: { tenantId: tenant.id, password: "guess" }, cookie: "" });
      if (res.status === 429) break;
    }
    assert.equal(res!.status, 429);
  });
});
