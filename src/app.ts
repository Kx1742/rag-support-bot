import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GeminiClient } from "./llm/gemini.ts";
import { ExtractiveChat, LocalEmbedder } from "./llm/offline.ts";
import { Assistant } from "./rag/assistant.ts";
import { buildIndex, isIndexFresh } from "./rag/indexer.ts";
import { loadIndex, saveIndex, VectorStore } from "./rag/vectorStore.ts";
import { createBookingTools, soldOutNotices } from "./shop/chatTools.ts";
import type { Shop } from "./shop/shop.ts";
import { indexPath, loadTenant } from "./tenant.ts";
import type { ChatProvider, EmbeddingProvider } from "./types.ts";

/** Loads .env from the project root if it exists (Node's built-in loader). */
export function loadEnv(): void {
  const envFile = resolve(import.meta.dirname, "..", ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export interface Providers {
  name: "gemini" | "offline";
  embedder: EmbeddingProvider;
  chat: ChatProvider;
  /** Similarity threshold suited to this embedder. */
  defaultMinScore: number;
}

let warnedOffline = false;

/**
 * LLM_PROVIDER=gemini|offline. When unset: Gemini if GEMINI_API_KEY is set, otherwise offline.
 */
export function createProviders(env: NodeJS.ProcessEnv = process.env): Providers {
  const choice = env.LLM_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : "offline");
  if (choice === "gemini") {
    const client = GeminiClient.fromEnv(env);
    return { name: "gemini", embedder: client, chat: client, defaultMinScore: 0.5 };
  }
  if (choice === "offline") {
    if (!env.LLM_PROVIDER && !warnedOffline) {
      warnedOffline = true;
      console.warn("No GEMINI_API_KEY set: running in OFFLINE mode (keyword search, no AI answers).");
    }
    return { name: "offline", embedder: new LocalEmbedder(), chat: new ExtractiveChat(), defaultMinScore: 0.15 };
  }
  throw new Error(`Unknown LLM_PROVIDER "${choice}". Use "gemini" or "offline".`);
}

/** Embeds a tenant's docs and saves the index. Skips work if nothing changed. */
export async function ingestTenant(
  tenantId: string,
  opts: { force?: boolean; embedder?: EmbeddingProvider } = {},
) {
  const embedder = opts.embedder ?? createProviders().embedder;
  const { docs } = await loadTenant(tenantId);
  const path = indexPath(tenantId);
  const existing = await loadIndex(path);

  if (!opts.force && isIndexFresh(existing, docs, embedder)) {
    return { index: existing!, path, skipped: true };
  }
  const index = await buildIndex(tenantId, docs, embedder);
  await saveIndex(path, index);
  return { index, path, skipped: false };
}

/**
 * Builds a ready-to-use assistant for a tenant, indexing first if needed.
 * Pass the tenant's shop to let the assistant take bookings (needs a model with function calling).
 */
export async function createAssistant(tenantId: string, providers = createProviders(), shop: Shop | null = null): Promise<Assistant> {
  const { config } = await loadTenant(tenantId);
  const { index } = await ingestTenant(tenantId, { embedder: providers.embedder });
  const minScore = process.env.RAG_MIN_SCORE ? Number(process.env.RAG_MIN_SCORE) : providers.defaultMinScore;

  return new Assistant({
    tenant: config,
    store: new VectorStore(index.chunks),
    embedder: providers.embedder,
    chat: providers.chat,
    options: { minScore },
    tools: shop ? createBookingTools(shop) : undefined,
    notices: shop ? soldOutNotices(shop) : undefined,
  });
}
