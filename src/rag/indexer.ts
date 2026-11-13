import { createHash } from "node:crypto";
import type { EmbeddingProvider, SourceDocument } from "../types.ts";
import { chunkDocument } from "./chunker.ts";
import type { IndexFile } from "./vectorStore.ts";

export function hashDocs(docs: SourceDocument[]): string {
  const hash = createHash("sha256");
  for (const doc of docs) hash.update(doc.docId).update("\0").update(doc.text).update("\0");
  return hash.digest("hex");
}

/**
 * Chunks every document and embeds the chunks. Chunks whose text is unchanged since `previous`
 * (same embedding model) keep their embedding, so adding one answer doesn't re-embed (and with a
 * paid API, re-pay for) every document.
 */
export async function buildIndex(
  tenantId: string,
  docs: SourceDocument[],
  embedder: EmbeddingProvider,
  previous: IndexFile | null = null,
): Promise<IndexFile> {
  const chunks = docs.flatMap((doc) => chunkDocument(doc));
  if (chunks.length === 0) throw new Error(`Tenant "${tenantId}" has no document content to index.`);

  const known = new Map(previous?.embeddingModel === embedder.model ? previous.chunks.map((c) => [c.text, c.embedding]) : []);
  const missing = chunks.filter((c) => !known.has(c.text));
  const fresh = missing.length ? await embedder.embed(missing.map((c) => c.text), "document") : [];
  if (fresh.length !== missing.length) {
    throw new Error(`Expected ${missing.length} embeddings, got ${fresh.length}`);
  }
  missing.forEach((c, i) => known.set(c.text, fresh[i]));
  const embeddings = chunks.map((c) => known.get(c.text)!);

  return {
    tenantId,
    embeddingModel: embedder.model,
    docsHash: hashDocs(docs),
    createdAt: new Date().toISOString(),
    chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] })),
  };
}

/** True when an existing index can be reused instead of re-embedding everything. */
export function isIndexFresh(index: IndexFile | null, docs: SourceDocument[], embedder: EmbeddingProvider): boolean {
  return !!index && index.embeddingModel === embedder.model && index.docsHash === hashDocs(docs);
}
