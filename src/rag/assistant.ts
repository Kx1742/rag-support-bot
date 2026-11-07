import type { ChatMessage, ChatProvider, EmbeddingProvider, TenantConfig } from "../types.ts";
import { buildSystemPrompt, fallbackAnswer } from "./prompt.ts";
import type { VectorStore } from "./vectorStore.ts";

export interface AssistantOptions {
  topK?: number;
  /** Chunks scoring below this cosine similarity are ignored. */
  minScore?: number;
  /** How many previous messages to send for follow-up questions. */
  historyLimit?: number;
}

export interface Answer {
  text: string;
  sources: { n: number; docId: string; heading: string; score: number }[];
  /** True when nothing relevant was found and the LLM was not called. */
  usedFallback: boolean;
}

/**
 * The channel-independent "brain". Web chat, WhatsApp, etc. all call ask().
 */
export class Assistant {
  private readonly tenant: TenantConfig;
  private readonly store: VectorStore;
  private readonly embedder: EmbeddingProvider;
  private readonly chat: ChatProvider;
  private readonly options: Required<AssistantOptions>;

  constructor(deps: {
    tenant: TenantConfig;
    store: VectorStore;
    embedder: EmbeddingProvider;
    chat: ChatProvider;
    options?: AssistantOptions;
  }) {
    this.tenant = deps.tenant;
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.chat = deps.chat;
    this.options = { topK: 4, minScore: 0.5, historyLimit: 6, ...deps.options };
  }

  async ask(question: string, history: ChatMessage[] = []): Promise<Answer> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("Question is empty");

    const recent = history.slice(-this.options.historyLimit);
    // Include the last user turn so follow-ups like "and on Sunday?" retrieve the right chunks.
    const lastUser = [...recent].reverse().find((m) => m.role === "user");
    const searchText = lastUser ? `${lastUser.text}\n${trimmed}` : trimmed;

    const [queryEmbedding] = await this.embedder.embed([searchText], "query");
    const sources = this.store.search(queryEmbedding, this.options.topK, this.options.minScore);

    if (sources.length === 0) {
      return { text: fallbackAnswer(this.tenant), sources: [], usedFallback: true };
    }

    const text = await this.chat.generate({
      system: buildSystemPrompt(this.tenant, sources),
      messages: [...recent, { role: "user", text: trimmed }],
    });

    return {
      text,
      sources: sources.map((s, i) => ({
        n: i + 1,
        docId: s.docId,
        heading: s.heading,
        score: Math.round(s.score * 1000) / 1000,
      })),
      usedFallback: false,
    };
  }
}
