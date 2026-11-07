import { unwrapLines } from "../text.ts";
import type {
  ChatMessage,
  ChatProvider,
  EmbeddingProvider,
  ScoredChunk,
  TenantConfig,
  ToolCallRecord,
  ToolRunner,
} from "../types.ts";
import { buildSystemPrompt, fallbackAnswer } from "./prompt.ts";
import type { VectorStore } from "./vectorStore.ts";

export interface AssistantOptions {
  topK?: number;
  /** Chunks scoring below this cosine similarity are ignored. */
  minScore?: number;
  /** How many previous messages to send for follow-up questions. */
  historyLimit?: number;
}

export interface SourceRef {
  n: number;
  docId: string;
  heading: string;
  score: number;
  /** Short excerpt so the UI can show where the answer came from. */
  excerpt: string;
}

export interface Answer {
  text: string;
  sources: SourceRef[];
  /** True when nothing relevant was found and the LLM was not called. */
  usedFallback: boolean;
}

export type AnswerEvent =
  | { type: "sources"; sources: SourceRef[] }
  | { type: "delta"; text: string }
  /** Something happened through a tool, e.g. a booking was made. The UI can show a card. */
  | { type: "action"; name: string; data: unknown }
  | { type: "done"; usedFallback: boolean };

/** Optional actions (like bookings) the assistant can take through function calling. */
export interface AssistantTools {
  /** Extra system-prompt text, e.g. today's date and booking rules. Called per question. */
  instructions(): string;
  runner: ToolRunner;
  /** Turns a finished tool call into a UI event, or null to show nothing. */
  toAction?(call: ToolCallRecord): { name: string; data: unknown } | null;
}

/**
 * The channel-independent "brain". Web chat, WhatsApp, etc. all call ask() or askStream().
 */
export class Assistant {
  readonly tenant: TenantConfig;
  private readonly store: VectorStore;
  private readonly embedder: EmbeddingProvider;
  private readonly chat: ChatProvider;
  private readonly options: Required<AssistantOptions>;
  private readonly tools?: AssistantTools;

  constructor(deps: {
    tenant: TenantConfig;
    store: VectorStore;
    embedder: EmbeddingProvider;
    chat: ChatProvider;
    options?: AssistantOptions;
    tools?: AssistantTools;
  }) {
    this.tenant = deps.tenant;
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.chat = deps.chat;
    this.options = { topK: 4, minScore: 0.5, historyLimit: 6, ...deps.options };
    // Tools only work with a model that supports function calling.
    this.tools = deps.chat.chatWithTools ? deps.tools : undefined;
  }

  /** True when the assistant can take actions such as bookings. */
  get canUseTools(): boolean {
    return !!this.tools;
  }

  async ask(question: string, history: ChatMessage[] = []): Promise<Answer> {
    let text = "";
    let sources: SourceRef[] = [];
    let usedFallback = false;
    for await (const event of this.askStream(question, history)) {
      if (event.type === "sources") sources = event.sources;
      else if (event.type === "delta") text += event.text;
      else if (event.type === "done") usedFallback = event.usedFallback;
    }
    return { text: text.trim(), sources, usedFallback };
  }

  /** Yields sources first, then the answer piece by piece, then "done". */
  async *askStream(question: string, history: ChatMessage[] = []): AsyncIterable<AnswerEvent> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error("Question is empty");

    const recent = history.slice(-this.options.historyLimit);
    const found = await this.retrieve(trimmed, recent);
    const sources = found.map(toSourceRef);
    yield { type: "sources", sources };

    const messages = [...recent, { role: "user" as const, text: trimmed }];

    if (this.tools) {
      // With tools the model must always run: "table for 4 on Saturday" matches no FAQ text.
      const { text, calls } = await this.chat.chatWithTools!(
        { system: buildSystemPrompt(this.tenant, found, this.tools.instructions()), messages },
        this.tools.runner,
      );
      for (const call of calls) {
        const action = this.tools.toAction?.(call);
        if (action) yield { type: "action", ...action };
      }
      yield { type: "delta", text };
      yield { type: "done", usedFallback: false };
      return;
    }

    if (found.length === 0) {
      yield { type: "delta", text: fallbackAnswer(this.tenant) };
      yield { type: "done", usedFallback: true };
      return;
    }

    const request = { system: buildSystemPrompt(this.tenant, found), messages };
    if (this.chat.stream) {
      for await (const text of this.chat.stream(request)) yield { type: "delta", text };
    } else {
      yield { type: "delta", text: await this.chat.generate(request) };
    }
    yield { type: "done", usedFallback: false };
  }

  /**
   * Searches with the question alone AND combined with the previous question, keeping
   * each chunk's best score. The combined search handles follow-ups ("and on Sunday?");
   * the solo search stops an unrelated earlier question from drowning out a new topic.
   */
  private async retrieve(question: string, recent: ChatMessage[]): Promise<ScoredChunk[]> {
    const { topK, minScore } = this.options;
    const lastUser = [...recent].reverse().find((m) => m.role === "user");
    const queries = lastUser ? [question, `${lastUser.text}\n${question}`] : [question];
    const embeddings = await this.embedder.embed(queries, "query");

    const best = new Map<string, ScoredChunk>();
    for (const embedding of embeddings) {
      for (const hit of this.store.search(embedding, topK, minScore)) {
        if ((best.get(hit.id)?.score ?? -Infinity) < hit.score) best.set(hit.id, hit);
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  }
}

function toSourceRef(s: ScoredChunk, i: number): SourceRef {
  const body = unwrapLines(s.heading && s.text.startsWith(s.heading) ? s.text.slice(s.heading.length) : s.text);
  return {
    n: i + 1,
    docId: s.docId,
    heading: s.heading,
    score: Math.round(s.score * 1000) / 1000,
    excerpt: body.length > 280 ? `${body.slice(0, 277)}...` : body,
  };
}
