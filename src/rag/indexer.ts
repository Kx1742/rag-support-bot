import { createHash } from "node:crypto";
import type { EmbeddingProvider, SourceDocument } from "../types.ts";
import { chunkDocument } from "./chunker.ts";
import type { IndexFile } from "./vectorStore.ts";

export function hashDocs(docs: SourceDocument[]): string {
  const hash = createHash("sha256");
  for (const doc of docs) hash.update(doc.docId).update("\0").update(doc.text).update("\0");
  return hash.digest("hex");
}

/** Chunks every document and embeds the chunks. */
export async function buildIndex(
  tenantId: string,
  docs: SourceDocument[],
  embedder: EmbeddingProvider,
): Promise<IndexFile> {
  const chunks = docs.flatMap((doc) => chunkDocument(doc));
  if (chunks.length === 0) throw new Error(`Tenant "${tenantId}" has no document content to index.`);

  const embeddings = await embedder.embed(
    chunks.map((c) => c.text),
    "document",
  );
  if (embeddings.length !== chunks.length) {
    throw new Error(`Expected ${chunks.length} embeddings, got ${embeddings.length}`);
  }

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
