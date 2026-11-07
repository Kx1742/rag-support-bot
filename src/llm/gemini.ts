import type { ChatProvider, ChatRequest, EmbedKind, EmbeddingProvider } from "../types.ts";

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

function assertNotBlocked(json: GenerateResponse): void {
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
  }
}

function textOf(json: GenerateResponse): string {
  return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

/** Yields the `data:` payload of each Server-Sent Event in a byte stream. */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (dataLines.length) yield dataLines.join("\n");
        dataLines = [];
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  const rest = buffer.replace(/\r$/, "");
  if (rest.startsWith("data:")) dataLines.push(rest.slice(5).trimStart());
  if (dataLines.length) yield dataLines.join("\n");
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_BATCH = 100;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface GeminiOptions {
  apiKey: string;
  chatModel?: string;
  embedModel?: string;
  /** Smaller vectors = smaller index files. gemini-embedding-001 supports 768, 1536, 3072. */
  embedDimensions?: number;
  temperature?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

/** Gemini API client using plain REST calls (no SDK dependency). */
export class GeminiClient implements ChatProvider, EmbeddingProvider {
  readonly model: string;
  readonly chatModel: string;
  readonly embedModel: string;
  private readonly apiKey: string;
  private readonly embedDimensions: number;
  private readonly temperature: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiOptions) {
    if (!options.apiKey) {
      throw new Error("GEMINI_API_KEY is missing. Get a free key at https://aistudio.google.com/apikey");
    }
    this.apiKey = options.apiKey;
    this.chatModel = options.chatModel ?? "gemini-2.5-flash";
    this.embedModel = options.embedModel ?? "gemini-embedding-001";
    this.embedDimensions = options.embedDimensions ?? 768;
    this.temperature = options.temperature ?? 0.2;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Index files record this, so changing model or size forces a re-index.
    this.model = `${this.embedModel}@${this.embedDimensions}`;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GeminiClient {
    return new GeminiClient({
      apiKey: env.GEMINI_API_KEY ?? "",
      chatModel: env.GEMINI_CHAT_MODEL || undefined,
      embedModel: env.GEMINI_EMBED_MODEL || undefined,
      embedDimensions: env.GEMINI_EMBED_DIMENSIONS ? Number(env.GEMINI_EMBED_DIMENSIONS) : undefined,
    });
  }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    const taskType = kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      const body = {
        requests: batch.map((text) => ({
          model: `models/${this.embedModel}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: this.embedDimensions,
        })),
      };
      const json = (await this.post(`models/${this.embedModel}:batchEmbedContents`, body)) as {
        embeddings?: { values: number[] }[];
      };
      if (!json.embeddings || json.embeddings.length !== batch.length) {
        throw new Error("Gemini returned an unexpected number of embeddings");
      }
      results.push(...json.embeddings.map((e) => e.values));
    }
    return results;
  }

  async generate(request: ChatRequest): Promise<string> {
    const json = (await this.post(`models/${this.chatModel}:generateContent`, this.chatBody(request))) as GenerateResponse;
    assertNotBlocked(json);
    const text = textOf(json).trim();
    if (!text) {
      throw new Error(`Gemini returned no text (finishReason: ${json.candidates?.[0]?.finishReason ?? "unknown"})`);
    }
    return text;
  }

  /** Streams the reply using Server-Sent Events (streamGenerateContent?alt=sse). */
  async *stream(request: ChatRequest): AsyncIterable<string> {
    const res = await this.request(`models/${this.chatModel}:streamGenerateContent?alt=sse`, this.chatBody(request));
    if (!res.body) throw new Error("Gemini returned an empty stream");

    let gotText = false;
    let lastFinish = "unknown";
    for await (const data of readSseData(res.body)) {
      const json = JSON.parse(data) as GenerateResponse;
      assertNotBlocked(json);
      lastFinish = json.candidates?.[0]?.finishReason ?? lastFinish;
      const text = textOf(json);
      if (text) {
        gotText = true;
        yield text;
      }
    }
    if (!gotText) throw new Error(`Gemini returned no text (finishReason: ${lastFinish})`);
  }

  private chatBody(request: ChatRequest) {
    return {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.text }],
      })),
      generationConfig: { temperature: this.temperature },
    };
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    return (await this.request(path, body)).json();
  }

  /** POSTs with retries on rate limits / server errors. Returns the OK response. */
  private async request(path: string, body: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${API_BASE}/${path}`, {
        method: "POST",
        // Key goes in a header, never in the URL, so it doesn't end up in logs.
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;

      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini API error ${res.status} on ${path}: ${detail.slice(0, 500)}`);
    }
  }
}
