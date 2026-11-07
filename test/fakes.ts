import type { ChatMessage, ChatProvider, EmbedKind, EmbeddingProvider } from "../src/types.ts";

const STOP_WORDS = new Set(["the", "a", "an", "is", "are", "do", "you", "i", "can", "to", "of", "and", "on", "for", "what", "your", "we", "it"]);

/**
 * Deterministic offline embedder: hashes words into a fixed-size vector.
 * Texts that share words get similar vectors, which is enough to test retrieval.
 */
export class FakeEmbedder implements EmbeddingProvider {
  readonly model = "fake-embed@64";
  calls: { texts: string[]; kind: EmbedKind }[] = [];

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    this.calls.push({ texts, kind });
    return texts.map((t) => {
      const v = new Array(64).fill(0);
      for (const word of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (STOP_WORDS.has(word)) continue;
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 64] += 1;
      }
      return v;
    });
  }
}

export class FakeChat implements ChatProvider {
  readonly model = "fake-chat";
  calls: { system: string; messages: ChatMessage[] }[] = [];
  reply = "Fake answer [1]";

  async generate(request: { system: string; messages: ChatMessage[] }): Promise<string> {
    this.calls.push(request);
    return this.reply;
  }
}
