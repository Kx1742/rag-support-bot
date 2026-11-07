import { unwrapLines } from "../text.ts";
import type { ChatProvider, ChatRequest, EmbedKind, EmbeddingProvider } from "../types.ts";

const STOP_WORDS = new Set(
  "a an and are as at be but by can do does for from have how i if in is it me my of on or our so that the this to us was we what when where which who will with you your".split(" "),
);
const DIMENSIONS = 512;

/**
 * Lowercased, stemmed content words. Skips filler words and bare numbers
 * ("7", "00"), which would match everything.
 */
export function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => !STOP_WORDS.has(w) && !/^\d+$/.test(w) && w.length >= 2)
    .map(stem);
}

/** Very small stemmer: "opening" -> "open", "hours" -> "hour", "catered" -> "cater". */
export function stem(word: string): string {
  if (word.length <= 4) return word;
  return word.replace(/(ings|ing|ies|ed|es|s)$/, (suffix) => (suffix === "ies" ? "y" : ""));
}

/**
 * Keyword-based embedder that runs locally with no API key.
 * Hashes words into a fixed-size vector, so texts sharing words score as similar.
 * Much weaker than real embeddings: for development, tests and demos only.
 */
export class LocalEmbedder implements EmbeddingProvider {
  readonly model = `local-hash@${DIMENSIONS}`;

  async embed(texts: string[], _kind: EmbedKind): Promise<number[][]> {
    return texts.map((text) => {
      const counts = new Map<number, number>();
      for (const word of keywords(text)) {
        let h = 2166136261;
        for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
        counts.set(h % DIMENSIONS, (counts.get(h % DIMENSIONS) ?? 0) + 1);
      }
      const v = new Array<number>(DIMENSIONS).fill(0);
      // 1 + ln(count): repeated words ("AM", "PM") count, but don't dominate.
      for (const [i, c] of counts) v[i] = 1 + Math.log(c);
      return v;
    });
  }
}

/**
 * "Chat model" that needs no API key: replies with the best-matching source text.
 * Lets you try the whole app offline; answers are excerpts, not generated prose.
 */
export class ExtractiveChat implements ChatProvider {
  readonly model = "offline-extractive";
  private readonly delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.delayMs = options.delayMs ?? 15;
  }

  async generate(request: ChatRequest): Promise<string> {
    const notFound = "(Offline mode) I couldn't find anything about that in the documents.";
    const match = /<source id="1"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(request.system);
    if (!match) return notFound;

    // Retrieval also uses the previous question (for follow-ups), so check that this
    // source actually relates to the *current* question before showing it.
    const question = request.messages.at(-1)?.text ?? "";
    const sourceWords = new Set(keywords(match[1]));
    if (!keywords(question).some((w) => sourceWords.has(w))) return notFound;

    // Drop the heading-path line that the chunker prepends.
    const body = unwrapLines(match[1].split("\n").slice(1).join("\n")) || match[1].trim();
    return `(Offline mode: showing the most relevant text, no AI.)\n\n${body} [1]`;
  }

  async *stream(request: ChatRequest): AsyncIterable<string> {
    const text = await this.generate(request);
    for (const word of text.match(/\S+\s*/g) ?? []) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      yield word;
    }
  }
}
