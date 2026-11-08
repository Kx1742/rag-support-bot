import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AnswerEvent } from "../src/rag/assistant.ts";
import { StaffAuth } from "../src/server/auth.ts";
import { createAppServer, type ChatAssistant } from "../src/server/http.ts";
import { DailyCap, RateLimiter } from "../src/server/rateLimit.ts";
import type { TenantConfig } from "../src/types.ts";
import { makeShop } from "./helpers.ts";

describe("production hardening", async () => {
  const { shop } = await makeShop();
  const tenant: TenantConfig = { id: "bean-and-byte", name: "Bean & Byte Café", assistantName: "Byte", tone: "", fallbackContact: "" };
  const assistant: ChatAssistant = {
    tenant,
    async *askStream(): AsyncIterable<AnswerEvent> {
      yield { type: "done", usedFallback: true };
      throw new Error("never reached");
    },
  };
  const logs: string[] = [];
  let shopBroken = false;
  let base = "";
  const server = createAppServer({
    getAssistant: async (id) => (id === tenant.id ? assistant : null),
    getShop: async () => {
      if (shopBroken) throw new Error("disk gone");
      return shop;
    },
    staffAuth: new StaffAuth({ passwordFor: () => "correct-horse-battery" }),
    loginLimiter: new RateLimiter({ capacity: 20, perMinute: 20 }),
    publicDir: resolve(import.meta.dirname, "..", "public"),
    defaultTenant: tenant.id,
    limiter: new RateLimiter({ capacity: 100, perMinute: 100 }),
    dailyCap: new DailyCap({ limit: 1000 }),
    secureCookies: true,
    logRequests: true,
    version: "9.9.9",
    log: (m) => logs.push(m),
  });
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reports health, version and whether the database answers", async () => {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.version, "9.9.9");
    assert.equal(body.database, "ok");
    assert.equal(typeof body.uptimeSeconds, "number");

    shopBroken = true;
    const down = await fetch(`${base}/api/health`);
    shopBroken = false;
    assert.equal(down.status, 503, "the host can see the app is unhealthy");
    assert.equal((await down.json()).database, "error");
  });

  it("sends security headers, HSTS on HTTPS and a request id on every response", async () => {
    for (const path of ["/", "/api/config", "/api/nope"]) {
      const res = await fetch(`${base}${path}`);
      assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=31536000/, path);
      assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/, path);
      assert.match(res.headers.get("x-request-id") ?? "", /^[0-9a-f]{8}$/, path);
    }
  });

  it("logs API requests without query strings (no phone numbers in logs)", async () => {
    logs.length = 0;
    await fetch(`${base}/api/desk/loyalty?phone=5550109999`);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(logs.some((l) => /^GET \/api\/desk\/loyalty 401 \d+ms \[[0-9a-f]{8}\]$/.test(l)), logs.join("\n"));
    assert.ok(!logs.join("\n").includes("5550109999"));
  });

  it("gives visitors a request id for unexpected errors, and logs the details", async () => {
    logs.length = 0;
    const original = shop.orders.pickupBoard.bind(shop.orders);
    shop.orders.pickupBoard = () => {
      throw new Error("kaboom: secret internals");
    };
    try {
      const res = await fetch(`${base}/api/tenants/${tenant.id}/pickup`);
      const body = await res.json();
      assert.equal(res.status, 500);
      assert.equal(body.error, "Something went wrong");
      assert.equal(body.requestId, res.headers.get("x-request-id"));
      assert.ok(!JSON.stringify(body).includes("kaboom"));
      assert.ok(logs.some((l) => l.includes(body.requestId) && l.includes("kaboom")));
    } finally {
      shop.orders.pickupBoard = original;
    }
  });
});
