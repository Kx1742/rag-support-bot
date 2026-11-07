/** A business that uses the assistant. Each tenant has its own docs and settings. */
export interface TenantConfig {
  id: string;
  name: string;
  /** True for demo businesses that do not exist. */
  fictional?: boolean;
  assistantName: string;
  tone: string;
  /** Shown when the assistant cannot answer from the documents. */
  fallbackContact: string;
  /** "auto" = reply in the customer's language. */
  language?: string;
}

export interface SourceDocument {
  /** File name relative to the tenant's docs folder, e.g. "menu.md". */
  docId: string;
  text: string;
}

export interface Chunk {
  id: string;
  docId: string;
  /** Heading path, e.g. "Menu > Milk Options". */
  heading: string;
  text: string;
}

export interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

export interface ScoredChunk extends EmbeddedChunk {
  score: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export type EmbedKind = "document" | "query";

/** Anything that can turn text into vectors (Gemini, a fake for tests, ...). */
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

/** Anything that can generate a chat reply. */
export interface ChatProvider {
  readonly model: string;
  generate(request: { system: string; messages: ChatMessage[] }): Promise<string>;
}
