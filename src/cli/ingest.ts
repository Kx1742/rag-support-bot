// Usage: npm run ingest -- <tenant-id> [--force]
import { ingestTenant, loadEnv } from "../app.ts";

loadEnv();
const args = process.argv.slice(2);
const tenantId = args.find((a) => !a.startsWith("--")) ?? "bean-and-byte";
const force = args.includes("--force");

try {
  const { index, path, skipped } = await ingestTenant(tenantId, { force });
  if (skipped) {
    console.log(`Index for "${tenantId}" is up to date (${index.chunks.length} chunks). Use --force to rebuild.`);
  } else {
    const files = new Set(index.chunks.map((c) => c.docId)).size;
    console.log(`Indexed ${files} documents into ${index.chunks.length} chunks -> ${path}`);
  }
} catch (err) {
  console.error(`Ingest failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
