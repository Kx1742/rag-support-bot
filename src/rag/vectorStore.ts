import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EmbeddedChunk, ScoredChunk } from "../types.ts";

export interface IndexFile {
  tenantId: string;
  embeddingModel: string;
  /** Hash of all source docs, used to skip re-embedding unchanged content. */
  docsHash: string;
  createdAt: string;
  chunks: EmbeddedChunk[];
}

/**
 * Simple in-memory vector store with brute-force cosine similarity.
 * Fine for hundreds or a few thousand chunks per business. Swap for pgvector or
 * a hosted vector DB when a tenant has much more content.
 */
export class VectorStore {
  readonly chunks: EmbeddedChunk[];
  private readonly norms: number[];

  constructor(chunks: EmbeddedChunk[]) {
    this.chunks = chunks;
    this.norms = chunks.map((c) => norm(c.embedding));
  }

  search(queryEmbedding: number[], topK = 4, minScore = 0): ScoredChunk[] {
    const qNorm = norm(queryEmbedding);
    if (qNorm === 0) return [];

    return this.chunks
      .map((chunk, i) => ({
        ...chunk,
        score: this.norms[i] === 0 ? 0 : dot(queryEmbedding, chunk.embedding) / (qNorm * this.norms[i]),
      }))
      .filter((c) => c.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

export async function saveIndex(path: string, index: IndexFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index), "utf8");
}

export async function loadIndex(path: string): Promise<IndexFile | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as IndexFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding size mismatch: ${a.length} vs ${b.length}. Re-run ingest.`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}
