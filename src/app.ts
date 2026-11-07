import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { GeminiClient } from "./llm/gemini.ts";
import { Assistant } from "./rag/assistant.ts";
import { buildIndex, isIndexFresh } from "./rag/indexer.ts";
import { loadIndex, saveIndex, VectorStore } from "./rag/vectorStore.ts";
import { indexPath, loadTenant } from "./tenant.ts";

/** Loads .env from the project root if it exists (Node's built-in loader). */
export function loadEnv(): void {
  const envFile = resolve(import.meta.dirname, "..", ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/** Embeds a tenant's docs and saves the index. Skips work if nothing changed. */
export async function ingestTenant(tenantId: string, opts: { force?: boolean; client?: GeminiClient } = {}) {
  const client = opts.client ?? GeminiClient.fromEnv();
  const { docs } = await loadTenant(tenantId);
  const path = indexPath(tenantId);
  const existing = await loadIndex(path);

  if (!opts.force && isIndexFresh(existing, docs, client)) {
    return { index: existing!, path, skipped: true };
  }
  const index = await buildIndex(tenantId, docs, client);
  await saveIndex(path, index);
  return { index, path, skipped: false };
}

/** Builds a ready-to-use assistant for a tenant, indexing first if needed. */
export async function createAssistant(tenantId: string): Promise<Assistant> {
  const client = GeminiClient.fromEnv();
  const { config } = await loadTenant(tenantId);
  const { index } = await ingestTenant(tenantId, { client });
  const minScore = process.env.RAG_MIN_SCORE ? Number(process.env.RAG_MIN_SCORE) : undefined;

  return new Assistant({
    tenant: config,
    store: new VectorStore(index.chunks),
    embedder: client,
    chat: client,
    options: minScore === undefined ? {} : { minScore },
  });
}
