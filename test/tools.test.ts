import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GeminiClient } from "../src/llm/gemini.ts";
import { Assistant } from "../src/rag/assistant.ts";
import { buildIndex } from "../src/rag/indexer.ts";
import { VectorStore } from "../src/rag/vectorStore.ts";
import { createBookingTools } from "../src/shop/chatTools.ts";
import type { ChatProvider, ChatRequest, TenantConfig, ToolCallRecord, ToolRunner } from "../src/types.ts";
import { FakeEmbedder } from "./fakes.ts";
import { makeShop } from "./helpers.ts";

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

describe("Gemini function calling", () => {
  it("runs requested tools, sends results back, and returns the final text", async () => {
    const bodies: any[] = [];
    const replies = [
      json({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "check_availability", args: { date: "2026-11-14", party_size: 2 } }, thoughtSignature: "sig" }],
            },
          },
        ],
      }),
      json({ candidates: [{ content: { parts: [{ text: "We have 10:00 free." }] } }] }),
    ];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return replies.shift()!;
    }) as typeof fetch;
    const client = new GeminiClient({ apiKey: "k", fetchImpl });

    const ran: unknown[] = [];
    const runner: ToolRunner = {
      definitions: [{ name: "check_availability", description: "d", parameters: { type: "object", properties: {} } }],
      run: async (call) => {
        ran.push(call);
        return { times: ["10:00"] };
      },
    };
    const result = await client.chatWithTools({ system: "S", messages: [{ role: "user", text: "Table Saturday?" }] }, runner);

    assert.equal(result.text, "We have 10:00 free.");
    assert.deepEqual(ran, [{ name: "check_availability", args: { date: "2026-11-14", party_size: 2 } }]);
    assert.deepEqual(result.calls[0].result, { times: ["10:00"] });
    assert.deepEqual(bodies[0].tools, [{ functionDeclarations: runner.definitions }]);

    const second = bodies[1].contents;
    assert.equal(second[1].role, "model");
    assert.equal(second[1].parts[0].thoughtSignature, "sig", "model turn is sent back unchanged");
    assert.deepEqual(second[2], {
      role: "user",
      parts: [{ functionResponse: { name: "check_availability", response: { result: { times: ["10:00"] } } } }],
    });
  });

  it("turns a crashing tool into an error result instead of failing the chat", async () => {
    const replies = [
      json({ candidates: [{ content: { parts: [{ functionCall: { name: "boom", args: {} } }] } }] }),
      json({ candidates: [{ content: { parts: [{ text: "Sorry, something went wrong." }] } }] }),
    ];
    const client = new GeminiClient({ apiKey: "k", fetchImpl: (async () => replies.shift()!) as typeof fetch });
    const result = await client.chatWithTools(
      { system: "", messages: [{ role: "user", text: "hi" }] },
      { definitions: [], run: async () => Promise.reject(new Error("db down")) },
    );
    assert.deepEqual(result.calls[0].result, { error: "db down" });
  });

  it("stops a model that never stops calling tools", async () => {
    const client = new GeminiClient({
      apiKey: "k",
      fetchImpl: (async () => json({ candidates: [{ content: { parts: [{ functionCall: { name: "x", args: {} } }] } }] })) as typeof fetch,
    });
    await assert.rejects(
      client.chatWithTools({ system: "", messages: [{ role: "user", text: "hi" }] }, { definitions: [], run: async () => ({}) }, 3),
      /kept calling tools/,
    );
  });
});

describe("booking tools", () => {
  it("checks, books and cancels through the shop's rules", async () => {
    const { shop } = await makeShop();
    const tools = createBookingTools(shop);
    const run = (name: string, args: Record<string, unknown>) => tools.runner.run({ name, args });

    const check = (await run("check_availability", { date: "2026-11-14", party_size: 4, time: "10:00" })) as { available: boolean };
    assert.equal(check.available, true);

    const created = (await run("create_booking", {
      date: "2026-11-14",
      time: "10:00",
      party_size: 4,
      name: "Amy",
      phone: "555 010 1111",
    })) as { booked: boolean; booking: { reference: string } };
    assert.equal(created.booked, true);

    const action = tools.toAction!({ name: "create_booking", args: {}, result: created });
    assert.equal(action?.name, "booking_created");

    const tooBig = await run("create_booking", { date: "2026-11-14", time: "10:00", party_size: 20, name: "X", phone: "5550100000" });
    assert.match((tooBig as { error: string }).error, /up to 6 people/, "rule errors go back to the model");

    const cancelled = await run("cancel_booking", { reference: created.booking.reference, phone: "5550101111" });
    assert.equal((cancelled as { cancelled: boolean }).cancelled, true);
  });

  it("tells the model today's date and the booking rules", async () => {
    const { shop } = await makeShop();
    const text = createBookingTools(shop).instructions();
    assert.match(text, /Today is Friday, 13 November 2026, the time is 10:00/);
    assert.match(text, /sat 2026-11-14 \(tomorrow\)/);
    assert.match(text, /clear "yes"/);
  });
});

describe("Assistant with tools", () => {
  const tenant: TenantConfig = { id: "t", name: "Shop", assistantName: "Bot", tone: "nice", fallbackContact: "c" };

  class FakeToolChat implements ChatProvider {
    readonly model = "fake-tools";
    requests: ChatRequest[] = [];
    async generate(): Promise<string> {
      throw new Error("should use chatWithTools");
    }
    async chatWithTools(request: ChatRequest, tools: ToolRunner) {
      this.requests.push(request);
      const args = { date: "2026-11-14", time: "10:00", party_size: 2, name: "Amy", phone: "5550101111" };
      const result = await tools.run({ name: "create_booking", args });
      return { text: "Booked!", calls: [{ name: "create_booking", args, result }] as ToolCallRecord[] };
    }
  }

  it("calls the model even when no documents match, and reports the booking", async () => {
    const { shop } = await makeShop();
    const embedder = new FakeEmbedder();
    const index = await buildIndex("t", [{ docId: "faq.md", text: "# FAQ\nWe sell coffee." }], embedder);
    const chat = new FakeToolChat();
    const assistant = new Assistant({
      tenant,
      store: new VectorStore(index.chunks),
      embedder,
      chat,
      options: { minScore: 0.9 },
      tools: createBookingTools(shop),
    });

    const events = [];
    for await (const e of assistant.askStream("table for two tomorrow at 10")) events.push(e);

    assert.deepEqual(
      events.map((e) => e.type),
      ["sources", "action", "delta", "done"],
    );
    assert.equal((events[1] as { name: string }).name, "booking_created");
    assert.match(chat.requests[0].system, /Table bookings:/);
    assert.match(chat.requests[0].system, /no matching documents/);
    assert.equal(shop.bookings.list("2026-11-14").length, 1);
  });

  it("ignores tools when the model can't call functions (offline mode)", async () => {
    const { shop } = await makeShop();
    const embedder = new FakeEmbedder();
    const index = await buildIndex("t", [{ docId: "faq.md", text: "# FAQ\nWe sell coffee." }], embedder);
    const assistant = new Assistant({
      tenant,
      store: new VectorStore(index.chunks),
      embedder,
      chat: { model: "plain", generate: async () => "x" },
      tools: createBookingTools(shop),
    });
    assert.equal(assistant.canUseTools, false);
  });
});
