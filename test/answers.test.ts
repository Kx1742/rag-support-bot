import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { createAssistant, createProviders } from "../src/app.ts";
import { LocalEmbedder } from "../src/llm/offline.ts";
import type { AnswerEvent } from "../src/rag/assistant.ts";
import { buildIndex } from "../src/rag/indexer.ts";
import { StaffAuth } from "../src/server/auth.ts";
import { type ChatAssistant, createAppServer } from "../src/server/http.ts";
import { DailyCap, RateLimiter } from "../src/server/rateLimit.ts";
import { ANSWERS_DOC_ID } from "../src/shop/answers.ts";
import type { EmbeddingProvider, TenantConfig } from "../src/types.ts";
import { makeShop } from "./helpers.ts";

describe("answers taught from the desk", () => {
  it("validates, edits and deletes answers, and tells listeners", async () => {
    const { shop } = await makeShop();
    let changes = 0;
    shop.events.on("change", (c) => c.kind === "answers" && changes++);

    assert.throws(() => shop.answers.create({ question: "?", answer: "Yes" }), /3-200/);
    assert.throws(() => shop.answers.create({ question: "Parking?", answer: "" }), /2-1500/);
    const a = shop.answers.create({ question: "  ## Is there   parking? ", answer: "Yes, behind the café.\n\n\n\n## Free after 6 PM." }, "Kim");
    assert.equal(a.question, "Is there parking?"); // one line, no Markdown heading marks
    assert.equal(a.answer, "Yes, behind the café.\n\nFree after 6 PM."); // can't start a new section
    assert.equal(a.updatedBy, "Kim");

    const edited = shop.answers.update(a.id, { question: "Is there parking?", answer: "Yes, 10 spaces behind the café." }, "Ana");
    assert.equal(edited.updatedBy, "Ana");
    shop.answers.remove(a.id);
    assert.throws(() => shop.answers.remove(a.id), /not found/);
    assert.equal(changes, 3);
  });

  it("becomes one Markdown document with a section per question", async () => {
    const { shop } = await makeShop();
    assert.equal(shop.answers.asDocument(), null);
    shop.answers.create({ question: "Is there parking?", answer: "Yes, behind the café." });
    shop.answers.create({ question: "Do you have a kids menu?", answer: "Yes: small pancakes and babyccinos." });
    assert.deepEqual(shop.answers.asDocument(), {
      docId: ANSWERS_DOC_ID,
      text: "# Answers from the team\n\n## Is there parking?\nYes, behind the café.\n\n## Do you have a kids menu?\nYes: small pancakes and babyccinos.\n",
    });
  });

  it("is cleared by the nightly demo reset", async () => {
    const { shop } = await makeShop();
    shop.answers.create({ question: "Is there parking?", answer: "Yes." });
    shop.resetData();
    assert.equal(shop.answers.list().length, 0);
  });
});

describe("re-indexing", () => {
  it("only embeds chunks whose text changed", async () => {
    let embedded = 0;
    const inner = new LocalEmbedder();
    const counting: EmbeddingProvider = {
      model: inner.model,
      embed: async (texts, kind) => {
        embedded += texts.length;
        return inner.embed(texts, kind);
      },
    };
    const docs = [
      { docId: "a.md", text: "# A\n\n## One\nFirst section.\n\n## Two\nSecond section." },
      { docId: "b.md", text: "# B\n\n## Three\nThird section." },
    ];
    const first = await buildIndex("t", docs, counting);
    const firstCount = embedded;
    embedded = 0;
    const answers = { docId: ANSWERS_DOC_ID, text: "# Answers from the team\n\n## Parking?\nYes." };
    const second = await buildIndex("t", [...docs, answers], counting, first);
    assert.equal(embedded, 1, "only the new answer is embedded");
    assert.equal(second.chunks.length, firstCount + 1);
  });
});

describe("the assistant uses answers from the desk", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "answers-"));
  const before = process.env.DATA_DIR;
  after(() => {
    process.env.DATA_DIR = before;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("answers a question its documents couldn't, citing the team's answer", async () => {
    process.env.DATA_DIR = dataDir;
    const { shop } = await makeShop();
    const offline = createProviders({ LLM_PROVIDER: "offline" });
    const question = "Is there a baby changing table?";

    const beforeAnswer = await (await createAssistant("bean-and-byte", offline, shop)).ask(question);
    assert.notEqual(beforeAnswer.sources[0]?.docId, ANSWERS_DOC_ID);

    shop.answers.create({ question, answer: "Yes, in the accessible restroom at the back." });
    const after = await (await createAssistant("bean-and-byte", offline, shop)).ask(question);
    assert.equal(after.sources[0]?.docId, ANSWERS_DOC_ID);
    assert.match(after.text, /accessible restroom/);
    assert.equal(after.answered, true);
  });
});

describe("answers over HTTP", async () => {
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
    return res.headers.get("set-cookie")!.split(";")[0];
  };
  const call = (cookie: string, path: string, method = "GET", body?: object) =>
    fetch(`${base}/api/desk${path}`, {
      method,
      headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  it("lets managers answer a reported question, which clears it from the report", async () => {
    shop.questions.record("Is there a baby changing table?", false);
    const topic = shop.questions.summary().unanswered[0].key;
    const owner = await login("owner", "correct-horse-battery");

    const created = await call(owner, "/answers", "POST", { question: "Is there a baby changing table?", answer: "Yes, in the restroom.", topic });
    assert.equal(created.status, 201);
    const { answer } = await created.json();
    assert.equal(answer.updatedBy, "Owner");
    assert.equal(shop.questions.summary().unanswered.length, 0);

    assert.equal((await call(owner, `/answers/${answer.id}`, "PATCH", { question: answer.question, answer: "Yes, with free wipes." })).status, 200);
    assert.equal((await (await call(owner, "/answers")).json()).answers[0].answer, "Yes, with free wipes.");
    assert.equal((await call(owner, `/answers/${answer.id}`, "DELETE")).status, 200);
    assert.equal((await call(owner, `/answers/${answer.id}`, "DELETE")).status, 404);
  });

  it("doesn't let baristas change what the assistant says", async () => {
    await shop.staff.create({ username: "sam", name: "Sam", role: "staff", pin: "4826" });
    const barista = await login("sam", "4826");
    assert.equal((await call(barista, "/answers")).status, 403);
    assert.equal((await call(barista, "/answers", "POST", { question: "Parking?", answer: "No." })).status, 403);
  });
});
