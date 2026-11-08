import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AnswerEvent } from "../src/rag/assistant.ts";
import { createAppServer, type ChatAssistant, publicTenantInfo } from "../src/server/http.ts";
import { DailyCap, RateLimiter } from "../src/server/rateLimit.ts";
import { parseChatBody, ValidationError } from "../src/server/validate.ts";
import type { ChatMessage, TenantConfig } from "../src/types.ts";

describe("RateLimiter", () => {
  it("allows a burst, blocks, then refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, perMinute: 6, now: () => now }); // 1 token / 10s

    assert.equal(limiter.take("ip").allowed, true);
    assert.equal(limiter.take("ip").allowed, true);
    const blocked = limiter.take("ip");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSec, 10);

    assert.equal(limiter.take("other-ip").allowed, true, "buckets are per key");

    now = 10_000;
    assert.equal(limiter.take("ip").allowed, true);
    assert.equal(limiter.take("ip").allowed, false);
  });
});

describe("DailyCap", () => {
  it("caps requests per UTC day and resets the next day", () => {
    let now = Date.UTC(2026, 0, 1, 23, 0);
    const cap = new DailyCap({ limit: 2, now: () => now });
    assert.deepEqual([cap.take(), cap.take(), cap.take()], [true, true, false]);
    now = Date.UTC(2026, 0, 2, 0, 1);
    assert.equal(cap.take(), true);
  });
});

describe("parseChatBody", () => {
  it("accepts a valid body and trims the message", () => {
    const body = parseChatBody({ message: "  hi  ", history: [{ role: "user", text: "a" }] });
    assert.deepEqual(body, { message: "hi", history: [{ role: "user", text: "a" }] });
  });

  it("rejects bad input", () => {
    assert.throws(() => parseChatBody(null), ValidationError);
    assert.throws(() => parseChatBody({ message: "" }), /required/);
    assert.throws(() => parseChatBody({ message: "x".repeat(1001) }), /too long/);
    assert.throws(() => parseChatBody({ message: "hi", history: "nope" }), /array/);
    assert.throws(() => parseChatBody({ message: "hi", history: [{ role: "system", text: "x" }] }), /history\[0\]/);
  });

  it("keeps only the most recent history", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: "user", text: String(i) }));
    const parsed = parseChatBody({ message: "hi", history });
    assert.equal(parsed.history.length, 10);
    assert.equal(parsed.history[0].text, "20");
  });
});

describe("publicTenantInfo", () => {
  it("exposes only safe fields and rejects invalid colors", () => {
    const info = publicTenantInfo({
      id: "x",
      name: "X",
      assistantName: "Bot",
      tone: "secret internal tone",
      fallbackContact: "c",
      brandColor: "red; background:url(evil)",
    });
    assert.equal(info.brandColor, null);
    assert.ok(!("tone" in info));
    assert.ok(!("fallbackContact" in info));
  });
});

describe("HTTP server", () => {
  const tenant: TenantConfig = {
    id: "demo",
    name: "Demo Shop",
    assistantName: "Bot",
    tone: "friendly",
    fallbackContact: "c",
    suggestedQuestions: ["Hours?"],
  };
  let received: { message: string; history: ChatMessage[] }[] = [];
  let failNext = false;

  const fakeAssistant: ChatAssistant = {
    tenant,
    async *askStream(message: string, history: ChatMessage[] = []): AsyncIterable<AnswerEvent> {
      received.push({ message, history });
      yield { type: "sources", sources: [{ n: 1, docId: "hours.md", heading: "Hours", score: 0.9, excerpt: "9-5" }] };
      if (failNext) {
        failNext = false;
        throw new Error("upstream exploded with secret details");
      }
      yield { type: "delta", text: "We open " };
      yield { type: "delta", text: "at 9 [1]." };
      yield { type: "done", usedFallback: false };
    },
  };

  let base = "";
  let logs: string[] = [];
  const server = createAppServer({
    getAssistant: async (id) => (id === "demo" ? fakeAssistant : null),
    publicDir: resolve(import.meta.dirname, "..", "public"),
    defaultTenant: "demo",
    limiter: new RateLimiter({ capacity: 5, perMinute: 1 }),
    dailyCap: new DailyCap({ limit: 1000 }),
    mode: "offline",
    log: (m) => logs.push(m),
  });

  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const chat = (body: unknown, tenantId = "demo") =>
    fetch(`${base}/api/tenants/${tenantId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  function parseSse(text: string) {
    return text
      .trim()
      .split("\n\n")
      .map((block) => {
        const event = /^event: (.*)$/m.exec(block)![1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
        return { event, data };
      });
  }

  it("serves the chat page with security headers", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /text\/html/);
    assert.match(res.headers.get("content-security-policy")!, /default-src 'self'/);
    assert.match(await res.text(), /<script src="\/app.js"/);
  });

  it("does not serve files outside the allow-list", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/index.html.bak", "/.env"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
  });

  it("returns public tenant info, and 404 for unknown tenants", async () => {
    const res = await fetch(`${base}/api/tenants/demo`);
    assert.deepEqual(await res.json(), {
      id: "demo",
      name: "Demo Shop",
      assistantName: "Bot",
      fictional: false,
      suggestedQuestions: ["Hours?"],
      chatBookings: false,
      brandColor: null,
      orderAhead: false,
      loyalty: null,
      booking: null,
    });
    assert.equal((await fetch(`${base}/api/tenants/nope`)).status, 404);
  });

  it("streams sources, answer pieces and done as Server-Sent Events", async () => {
    received = [];
    const res = await chat({ message: "When do you open?", history: [{ role: "user", text: "hi" }] });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /text\/event-stream/);

    const events = parseSse(await res.text());
    assert.deepEqual(
      events.map((e) => e.event),
      ["sources", "delta", "delta", "done"],
    );
    assert.equal(events.filter((e) => e.event === "delta").map((e) => e.data.text).join(""), "We open at 9 [1].");
    assert.deepEqual(received[0], { message: "When do you open?", history: [{ role: "user", text: "hi" }] });
  });

  it("hides internal error details from the browser", async () => {
    failNext = true;
    const events = parseSse(await (await chat({ message: "hi" })).text());
    const error = events.find((e) => e.event === "error")!;
    assert.match(error.data.error, /having trouble/);
    assert.ok(!JSON.stringify(events).includes("secret details"));
    assert.ok(logs.some((l) => l.includes("secret details")), "details are logged on the server");
  });

  it("rejects invalid requests with clear errors", async () => {
    const empty = await chat({ message: "" });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /required/);

    const notJson = await fetch(`${base}/api/tenants/demo/chat`, { method: "POST", body: "hi" });
    assert.equal(notJson.status, 415);
  });

  it("rate limits each visitor", async () => {
    // Keep sending until the burst (5) runs out; earlier tests may have used some of it.
    let res = await chat({ message: "again" });
    for (let i = 0; i < 6 && res.status !== 429; i++) {
      await res.body?.cancel();
      res = await chat({ message: "again" });
    }
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.match((await res.json()).error, /Too many messages/);
  });
});
