import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProviders } from "../src/app.ts";
import { ExtractiveChat, LocalEmbedder } from "../src/llm/offline.ts";
import { Assistant } from "../src/rag/assistant.ts";
import { buildIndex } from "../src/rag/indexer.ts";
import { VectorStore } from "../src/rag/vectorStore.ts";
import { loadTenant } from "../src/tenant.ts";
import { unwrapLines } from "../src/text.ts";

describe("unwrapLines", () => {
  it("joins wrapped lines but keeps paragraphs and list items", () => {
    assert.equal(unwrapLines("one\ntwo\n\nthree"), "one two\n\nthree");
    assert.equal(unwrapLines("Intro:\n- a\n  more a\n- b"), "Intro:\n- a more a\n- b");
    assert.equal(unwrapLines("a\n\n\n\nb"), "a\n\nb");
  });
});

describe("offline mode", () => {
  it("is chosen automatically when no API key is set", () => {
    assert.equal(createProviders({ LLM_PROVIDER: "offline" }).name, "offline");
    assert.equal(createProviders({ GEMINI_API_KEY: "k" }).name, "gemini");
    assert.throws(() => createProviders({ LLM_PROVIDER: "gpt" }), /Unknown LLM_PROVIDER/);
  });

  it("answers demo questions from the right café document", async () => {
    const { config, docs } = await loadTenant("bean-and-byte");
    const embedder = new LocalEmbedder();
    const index = await buildIndex(config.id, docs, embedder);
    const assistant = new Assistant({
      tenant: config,
      store: new VectorStore(index.chunks),
      embedder,
      chat: new ExtractiveChat({ delayMs: 0 }),
      options: { minScore: 0.15 },
    });

    const cases: [string, string, RegExp][] = [
      ["Do you have oat milk?", "menu.md", /Oat, almond and soy milk/],
      ["Can I get a refund on a gift card?", "refund-policy.md", /Gift cards cannot be refunded/],
      ["What time do you open on Sunday?", "hours-and-location.md", /Sunday: 9:00 AM/],
      ["Do you cater for 30 people?", "catering.md", /10 to 150 people|Packages|Ordering/],
    ];
    for (const [question, docId, expected] of cases) {
      const answer = await assistant.ask(question);
      assert.equal(answer.sources[0]?.docId, docId, question);
      assert.match(answer.text, expected, question);
      assert.ok(answer.sources[0].excerpt.length > 0);
    }

    const unrelated = await assistant.ask("quantum physics homework");
    assert.equal(unrelated.usedFallback, true);

    // A follow-up still finds the earlier topic...
    const giftCardTurn = [
      { role: "user" as const, text: "Can I get a refund on a gift card?" },
      { role: "assistant" as const, text: "No." },
    ];
    const followUp = await assistant.ask("what about lost gift cards?", giftCardTurn);
    assert.match(followUp.text, /Lost gift cards can be replaced/);

    // ...but an unrelated new question must not repeat the previous answer.
    const offTopic = await assistant.ask("what is the weather in Paris?", giftCardTurn);
    assert.doesNotMatch(offTopic.text, /Gift cards/);

    // ...and a real question after the off-topic one still works.
    const sunday = await assistant.ask("What time do you open on Sunday?", [
      ...giftCardTurn,
      { role: "user", text: "what is the weather in Paris?" },
      { role: "assistant", text: offTopic.text },
    ]);
    assert.match(sunday.text, /Sunday: 9:00 AM/);
  });
});
