import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { ExtractiveChat, LocalEmbedder } from "../src/llm/offline.ts";
import { Assistant, type AnswerEvent } from "../src/rag/assistant.ts";
import { buildIndex } from "../src/rag/indexer.ts";
import { VectorStore } from "../src/rag/vectorStore.ts";
import { StaffAuth } from "../src/server/auth.ts";
import { type ChatAssistant, createAppServer } from "../src/server/http.ts";
import { DailyCap, RateLimiter } from "../src/server/rateLimit.ts";
import { maskPersonalData, topicKey } from "../src/shop/questions.ts";
import { loadTenant } from "../src/tenant.ts";
import type { ChatProvider, TenantConfig } from "../src/types.ts";
import { FRIDAY_10AM, makeShop } from "./helpers.ts";

describe("question log", () => {
  it("masks phone numbers and emails before storing anything", () => {
    assert.equal(maskPersonalData("call me on 012-345 6789 or mail a.b@mail.example"), "call me on [number] or mail [email]");
    assert.equal(maskPersonalData("table for 4 at 10:30"), "table for 4 at 10:30");
  });

  it("groups different wordings of the same question and skips small talk", () => {
    assert.equal(topicKey("Do you have parking?"), topicKey("Is parking available?"));
    assert.equal(topicKey("hi!"), "");
    assert.equal(topicKey("Thanks so much"), "");
    assert.notEqual(topicKey("Do you have a kids menu?"), topicKey("Do you have parking?"));
  });

  it("reports the answer rate and unanswered topics, most asked first", async () => {
    const { shop } = await makeShop();
    const q = shop.questions;
    q.record("Do you have parking?", false);
    q.record("Is parking available?", false);
    q.record("parking near the cafe?", false);
    q.record("Do you have a kids menu?", false);
    q.record("Do you have oat milk?", true);
    q.record("What time do you open on Sunday?", true);
    assert.equal(q.record("hi", false), false); // small talk isn't counted

    const s = q.summary(30);
    assert.deepEqual([s.total, s.answered, s.answerRate], [6, 2, 33]);
    assert.deepEqual(
      s.unanswered.map((t) => [t.question, t.count]),
      [
        ["parking near the cafe?", 3],
        ["Do you have a kids menu?", 1],
      ],
    );
  });

  it("joins a question to a topic that differs by one word", async () => {
    const { shop } = await makeShop();
    shop.questions.record("Do you have a kids menu?", false);
    shop.questions.record("Is there a kids menu for my son?", false);
    shop.questions.record("Do you have a menu?", true); // answered questions don't join unanswered topics
    assert.deepEqual(
      shop.questions.summary().unanswered.map((t) => [t.key, t.count]),
      [[topicKey("kids menu"), 2]],
    );
  });

  it("hides a topic once handled, but shows it again if people keep asking", async () => {
    const { shop, setNow } = await makeShop();
    shop.questions.record("Do you have parking?", false);
    const key = shop.questions.summary().unanswered[0].key;
    assert.equal(shop.questions.markHandled(key), 1);
    assert.equal(shop.questions.summary().unanswered.length, 0);
    assert.throws(() => shop.questions.markHandled(key), /isn't in the list/);

    setNow(new Date(FRIDAY_10AM.getTime() + 3_600_000));
    shop.questions.record("Is there parking?", false);
    assert.equal(shop.questions.summary().unanswered[0].count, 1);
  });

  it("forgets questions after 90 days", async () => {
    const { shop, setNow } = await makeShop();
    shop.questions.record("Do you have parking?", false);
    setNow(new Date(FRIDAY_10AM.getTime() + 91 * 86_400_000));
    shop.questions.record("Do you have a kids menu?", false);
    assert.equal(shop.questions.summary(90).total, 1);
    assert.throws(() => shop.questions.summary(365), /Days must be/);
  });
});

describe("the assistant says when it couldn't answer", () => {
  it("offline: a matching document answers, an unrelated question doesn't", async () => {
    const { config, docs } = await loadTenant("bean-and-byte");
    const embedder = new LocalEmbedder();
    const assistant = new Assistant({
      tenant: config,
      store: new VectorStore((await buildIndex(config.id, docs, embedder)).chunks),
      embedder,
      chat: new ExtractiveChat({ delayMs: 0 }),
      options: { minScore: 0.15 },
    });
    const answered = async (q: string) => {
      for await (const e of assistant.askStream(q)) if (e.type === "done") return e.answered;
    };
    assert.equal(await answered("Do you have oat milk?"), true);
    assert.equal(await answered("quantum physics homework"), false);
  });

  it("with AI: an answer that hands over the café's contact details counts as not answered", async () => {
    const { config, docs } = await loadTenant("bean-and-byte");
    const embedder = new LocalEmbedder();
    const reply = (text: string): ChatProvider => ({ model: "fake", generate: async () => text });
    const ask = async (text: string) => {
      const assistant = new Assistant({
        tenant: config,
        store: new VectorStore((await buildIndex(config.id, docs, embedder)).chunks),
        embedder,
        chat: reply(text),
        options: { minScore: 0.15 },
      });
      for await (const e of assistant.askStream("Do you have oat milk?")) if (e.type === "done") return e.answered;
    };
    assert.equal(await ask("Yes, oat milk is +$0.60 [1]."), true);
    assert.equal(await ask("I'm not sure. Please contact hello@beanandbyte.example or (555) 010-2040."), false);
  });
});

describe("question report over HTTP", async () => {
  const { shop } = await makeShop();
  const tenant: TenantConfig = {
    id: "bean-and-byte",
    name: "Bean & Byte Café",
    assistantName: "Byte",
    tone: "",
    fallbackContact: "hello@beanandbyte.example",
  };
  const assistant: ChatAssistant = {
    tenant,
    async *askStream(): AsyncIterable<AnswerEvent> {
      yield { type: "delta", text: "Sorry, I don't know." };
      yield { type: "done", usedFallback: true, answered: false };
    },
  };
  let base = "";
  const server = createAppServer({
    getAssistant: async (id) => (id === tenant.id ? assistant : null),
    getShop: async (id) => (id === tenant.id ? shop : null),
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

  const login = async (username: string, pin: string) => {
    const res = await fetch(`${base}/api/desk/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: tenant.id, username, pin }),
    });
    assert.equal(res.status, 200);
    return res.headers.get("set-cookie")!.split(";")[0];
  };

  it("records chat questions (masked) and shows them to managers only", async () => {
    const chat = await fetch(`${base}/api/tenants/${tenant.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Can you deliver to 012-345 6789?" }),
    });
    await chat.text(); // read the whole stream
    const owner = await login("owner", "correct-horse-battery");
    const res = await fetch(`${base}/api/desk/questions?days=30`, { headers: { Cookie: owner } });
    const report = await res.json();
    assert.deepEqual([report.total, report.answerRate], [1, 0]);
    assert.equal(report.unanswered[0].question, "Can you deliver to [number]?");

    const handled = await fetch(`${base}/api/desk/questions/handled`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: owner },
      body: JSON.stringify({ key: report.unanswered[0].key }),
    });
    assert.equal(handled.status, 200);

    await shop.staff.create({ username: "sam", name: "Sam", role: "staff", pin: "4826" });
    const barista = await login("sam", "4826");
    assert.equal((await fetch(`${base}/api/desk/questions`, { headers: { Cookie: barista } })).status, 403);
  });
});
