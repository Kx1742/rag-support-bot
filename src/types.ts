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
  /** Example questions shown as buttons in the chat UI. */
  suggestedQuestions?: string[];
  /** Brand color for the chat UI, e.g. "#7a4a2a". */
  brandColor?: string;
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

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
}

/** A function the model may call, described with a JSON-schema "parameters" object. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallRecord extends ToolCall {
  result: unknown;
}

/** The tools available in one conversation, and how to run them. */
export interface ToolRunner {
  definitions: ToolDefinition[];
  run(call: ToolCall): Promise<unknown>;
}

/** Anything that can generate a chat reply. */
export interface ChatProvider {
  readonly model: string;
  generate(request: ChatRequest): Promise<string>;
  /** Optional token-by-token streaming. Falls back to generate() when missing. */
  stream?(request: ChatRequest): AsyncIterable<string>;
  /** Optional function calling: loops until the model answers in text. */
  chatWithTools?(request: ChatRequest, tools: ToolRunner): Promise<{ text: string; calls: ToolCallRecord[] }>;
}
