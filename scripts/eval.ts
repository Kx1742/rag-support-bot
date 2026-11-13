// Answer-quality check: asks each café's test questions (tenants/<id>/eval.json) and scores the answers.
//   npm run eval            offline (keyword search, no AI): fast, free, runs in CI
//   npm run eval -- --live  with the configured AI provider (needs GEMINI_API_KEY)
// Fails (exit code 1) when a café scores below its minScore, so a change that makes answers
// worse is caught before it ships.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistant, createProviders, loadEnv } from "../src/app.ts";
import { ExtractiveChat, LocalEmbedder } from "../src/llm/offline.ts";
import { Assistant } from "../src/rag/assistant.ts";
import { buildIndex } from "../src/rag/indexer.ts";
import { VectorStore } from "../src/rag/vectorStore.ts";
import { loadTenant, tenantsDir } from "../src/tenant.ts";

interface EvalCase {
  question: string;
  /** Document that should answer it (checked against the top 3 sources). */
  source?: string;
  /** Text the answer must contain (case-insensitive regular expression). */
  expect?: string;
  /** True for questions the documents can't answer: the assistant must say so, not guess. */
  unanswerable?: boolean;
}

interface EvalFile {
  /** Lowest acceptable score, 0-100. */
  minScore: number;
  cases: EvalCase[];
}

loadEnv();
const live = process.argv.includes("--live");
const tenants = readdirSync(tenantsDir()).filter((id) => existsSync(join(tenantsDir(), id, "eval.json")));
let failed = false;

for (const tenantId of tenants) {
  const file = JSON.parse(readFileSync(join(tenantsDir(), tenantId, "eval.json"), "utf8")) as EvalFile;
  const assistant = live ? await createAssistant(tenantId, createProviders()) : await offlineAssistant(tenantId);

  console.log(`\n${tenantId} (${live ? "live AI" : "offline"}), ${file.cases.length} questions`);
  let passed = 0;
  let top1 = 0;
  let top3 = 0;
  let answerable = 0;
  for (const c of file.cases) {
    const answer = await assistant.ask(c.question);
    const docs = answer.sources.map((s) => s.docId);
    const problems: string[] = [];
    if (c.unanswerable) {
      if (answer.answered) problems.push("answered a question the documents can't answer");
    } else {
      answerable++;
      if (c.source && docs[0] === c.source) top1++;
      if (c.source && docs.slice(0, 3).includes(c.source)) top3++;
      else if (c.source) problems.push(`expected source ${c.source}, got ${docs.slice(0, 3).join(", ") || "none"}`);
      if (!answer.answered) problems.push("said it couldn't answer");
      if (c.expect && !new RegExp(c.expect, "i").test(answer.text)) problems.push(`answer doesn't mention /${c.expect}/`);
    }
    if (!problems.length) passed++;
    console.log(`  ${problems.length ? "✖" : "✔"} ${c.question}${problems.length ? `\n      ${problems.join("; ")}` : ""}`);
  }

  const score = Math.round((passed / file.cases.length) * 100);
  const pct = (n: number) => (answerable ? `${Math.round((n / answerable) * 100)}%` : "n/a");
  console.log(`  Score ${score}% (minimum ${file.minScore}%) · right document first ${pct(top1)}, in top 3 ${pct(top3)}`);
  if (score < file.minScore) {
    console.log(`  ✖ ${tenantId} is below its minimum score`);
    failed = true;
  }
}

if (!tenants.length) console.log("No tenants/<id>/eval.json files found.");
process.exitCode = failed ? 1 : 0;

/** Same setup as offline mode in the app, with the index built in memory. */
async function offlineAssistant(tenantId: string): Promise<Assistant> {
  const { config, docs } = await loadTenant(tenantId);
  const embedder = new LocalEmbedder();
  const index = await buildIndex(config.id, docs, embedder);
  return new Assistant({
    tenant: config,
    store: new VectorStore(index.chunks),
    embedder,
    chat: new ExtractiveChat({ delayMs: 0 }),
    options: { minScore: createProviders({ LLM_PROVIDER: "offline" }).defaultMinScore },
  });
}
