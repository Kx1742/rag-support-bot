import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeminiClient } from "../src/llm/gemini.ts";

type Call = { url: string; init: RequestInit; body: any };

function fakeFetch(responses: (Response | ((body: any) => Response))[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), init: init!, body });
    const next = responses.shift();
    if (!next) throw new Error("No more fake responses");
    return typeof next === "function" ? next(body) : next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("GeminiClient", () => {
  it("requires an API key", () => {
    assert.throws(() => new GeminiClient({ apiKey: "" }), /GEMINI_API_KEY/);
  });

  it("sends chat requests with the key in a header and maps roles", async () => {
    const { impl, calls } = fakeFetch([json({ candidates: [{ content: { parts: [{ text: "Hi " }, { text: "there" }] } }] })]);
    const client = new GeminiClient({ apiKey: "secret", fetchImpl: impl, chatModel: "test-model" });

    const text = await client.generate({
      system: "SYS",
      messages: [
        { role: "user", text: "q1" },
        { role: "assistant", text: "a1" },
        { role: "user", text: "q2" },
      ],
    });

    assert.equal(text, "Hi there");
    assert.ok(calls[0].url.endsWith("/models/test-model:generateContent"));
    assert.ok(!calls[0].url.includes("secret"), "API key must not be in the URL");
    assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "secret");
    assert.equal(calls[0].body.systemInstruction.parts[0].text, "SYS");
    assert.deepEqual(
      calls[0].body.contents.map((c: any) => c.role),
      ["user", "model", "user"],
    );
  });

  it("batches embeddings in groups of 100 and sets the task type", async () => {
    const reply = (body: any) => json({ embeddings: body.requests.map(() => ({ values: [1, 2] })) });
    const { impl, calls } = fakeFetch([reply, reply]);
    const client = new GeminiClient({ apiKey: "k", fetchImpl: impl });

    const vectors = await client.embed(Array(150).fill("text"), "query");

    assert.equal(vectors.length, 150);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.requests.length, 100);
    assert.equal(calls[1].body.requests.length, 50);
    assert.equal(calls[0].body.requests[0].taskType, "RETRIEVAL_QUERY");
    assert.equal(calls[0].body.requests[0].outputDimensionality, 768);
  });

  it("retries on rate limits, then succeeds", async () => {
    const limited = () => new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } });
    const { impl, calls } = fakeFetch([limited(), json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] })]);
    const client = new GeminiClient({ apiKey: "k", fetchImpl: impl });

    assert.equal(await client.generate({ system: "", messages: [{ role: "user", text: "hi" }] }), "ok");
    assert.equal(calls.length, 2);
  });

  it("does not retry client errors and reports the status", async () => {
    const { impl, calls } = fakeFetch([new Response("bad key", { status: 400 })]);
    const client = new GeminiClient({ apiKey: "k", fetchImpl: impl });

    await assert.rejects(client.generate({ system: "", messages: [{ role: "user", text: "hi" }] }), /Gemini API error 400.*bad key/);
    assert.equal(calls.length, 1);
  });

  it("reports blocked prompts and empty replies", async () => {
    const { impl } = fakeFetch([json({ promptFeedback: { blockReason: "SAFETY" } }), json({ candidates: [{ finishReason: "MAX_TOKENS" }] })]);
    const client = new GeminiClient({ apiKey: "k", fetchImpl: impl });
    const req = { system: "", messages: [{ role: "user" as const, text: "hi" }] };

    await assert.rejects(client.generate(req), /blocked.*SAFETY/);
    await assert.rejects(client.generate(req), /no text.*MAX_TOKENS/);
  });

  it("records model and size so a changed config triggers re-indexing", () => {
    const a = new GeminiClient({ apiKey: "k", embedDimensions: 768 });
    const b = new GeminiClient({ apiKey: "k", embedDimensions: 1536 });
    assert.notEqual(a.model, b.model);
  });
});
