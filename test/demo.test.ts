import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AnswerEvent } from "../src/rag/assistant.ts";
import { StaffAuth } from "../src/server/auth.ts";
import { createAppServer, type ChatAssistant } from "../src/server/http.ts";
import { DailyCap, RateLimiter } from "../src/server/rateLimit.ts";
import { DEMO_ACCOUNTS, DEMO_MEMBER_PHONE, seedDemo } from "../src/shop/demo.ts";
import { openDatabase } from "../src/shop/db.ts";
import type { TenantConfig } from "../src/types.ts";
import { makeShop } from "./helpers.ts";

describe("demo data", () => {
  it("seeds a believable shift through the normal rules", async () => {
    const { shop } = await makeShop(); // Friday 10:00
    await seedDemo(shop);

    assert.deepEqual(
      shop.staff.list().map((s) => s.username).sort(),
      ["demo-barista", "demo-manager"],
    );
    for (const a of DEMO_ACCOUNTS) assert.ok(await shop.staff.authenticate(a.username, a.pin), `${a.username} can log in`);

    const statuses = shop.orders.list().map((o) => o.status);
    for (const s of ["new", "preparing", "ready", "completed"]) assert.ok(statuses.includes(s as never), `has a ${s} order`);
    assert.ok(shop.orders.list().some((o) => o.source === "online"));

    const member = shop.loyalty.find(DEMO_MEMBER_PHONE)!;
    assert.ok(member.points >= 120, "enough points to try a reward");
    assert.equal(shop.menu.get("croissant")!.stock, 7, "8 counted, 1 sold");

    assert.ok(shop.bookings.list("2026-11-13").length >= 1, "bookings today");
    assert.ok(shop.bookings.list("2026-11-13").some((b) => b.status === "seated"));
    assert.equal(shop.bookings.list("2026-11-14").length, 2, "bookings tomorrow");
  });

  it("resets cleanly and can be seeded again", async () => {
    const { shop } = await makeShop();
    await seedDemo(shop);
    shop.menu.create({ name: "Visitor's Pie", category: "Food", price: 100 });
    shop.menu.update("latte", { name: "Silly Latte", category: "Coffee", price: 1, options: [] });

    const events: unknown[] = [];
    shop.events.on("change", (e) => events.push(e));
    shop.resetData();
    assert.equal(shop.orders.list().length, 0);
    assert.equal(shop.staff.count(), 0);
    assert.equal(shop.menu.get("visitor-s-pie"), null, "desk-added items are gone");
    assert.equal(shop.menu.get("latte")!.name, "Caffè Latte", "desk edits are undone");
    assert.equal(shop.menu.get("latte")!.price, 475);
    assert.equal(events.length, 3, "open desks are told to refresh");

    await seedDemo(shop);
    assert.equal(shop.staff.count(), 2);
  });
});

describe("backups", () => {
  it("writes a consistent copy and keeps only the newest ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shop-backup-"));
    try {
      const { shop } = await makeShop();
      shop.orders.create({ type: "takeaway", items: [{ itemId: "latte", quantity: 1 }] });
      for (const old of ["shop-20200101-000000.db", "shop-20200102-000000.db", "notes.txt"]) writeFileSync(join(dir, old), "x");

      const file = shop.backup(dir, 2);
      assert.ok(existsSync(file));
      assert.deepEqual(readdirSync(dir).sort(), ["notes.txt", "shop-20200102-000000.db", file.split(/[\\/]/).at(-1)].sort());

      const copy = openDatabase(file);
      const { n } = copy.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number };
      copy.close();
      assert.equal(n, 1, "the backup has the data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("demo mode over HTTP", async () => {
  const { shop } = await makeShop();
  await seedDemo(shop);
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
    staffAuth: new StaffAuth({ passwordFor: () => undefined }),
    loginLimiter: new RateLimiter({ capacity: 20, perMinute: 20 }),
    publicDir: resolve(import.meta.dirname, "..", "public"),
    defaultTenant: tenant.id,
    limiter: new RateLimiter({ capacity: 100, perMinute: 100 }),
    dailyCap: new DailyCap({ limit: 1000 }),
    demo: { accounts: DEMO_ACCOUNTS.map(({ username, pin, role }) => ({ username, pin, role })), resetsAt: "04:00" },
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

  it("tells visitors the demo logins", async () => {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.demo.resetsAt, "04:00");
    assert.deepEqual(
      config.demo.accounts.map((a: { username: string }) => a.username),
      ["demo-barista", "demo-manager"],
    );
  });

  it("won't let a visitor change or lock the shared demo accounts", async () => {
    const login = await fetch(`${base}/api/desk/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenant.id, username: "demo-manager", pin: "1357" }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const desk = (path: string, init: { method?: string; body?: unknown } = {}) =>
      fetch(`${base}/api/desk${path}`, {
        method: init.method ?? "GET",
        headers: { Cookie: cookie, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });

    const barista = shop.staff.list().find((s) => s.username === "demo-barista")!;
    for (const body of [{ pin: "9182" }, { active: false }, { role: "manager" }]) {
      const res = await desk(`/staff/${barista.id}`, { method: "PATCH", body });
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /public demo/);
    }

    // Visitors can still try staff management on accounts they add themselves.
    const added = await desk("/staff", { method: "POST", body: { username: "my-test", name: "My Test", role: "staff", pin: "4826" } });
    assert.equal(added.status, 201);
    const { member } = await added.json();
    assert.equal((await desk(`/staff/${member.id}`, { method: "PATCH", body: { active: false } })).status, 200);
  });
});
