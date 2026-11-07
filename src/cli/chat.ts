// Usage: npm run chat -- [tenant-id]
import { createInterface } from "node:readline/promises";
import { createAssistant, loadEnv } from "../app.ts";
import type { ChatMessage } from "../types.ts";

loadEnv();
const tenantId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "bean-and-byte";

let assistant;
try {
  assistant = await createAssistant(tenantId);
} catch (err) {
  console.error(`Could not start: ${(err as Error).message}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const history: ChatMessage[] = [];
console.log(`Chatting with "${tenantId}". Type "exit" to quit.\n`);

while (true) {
  let question: string;
  try {
    question = (await rl.question("You: ")).trim();
  } catch {
    break; // stdin closed
  }
  if (!question) continue;
  if (["exit", "quit"].includes(question.toLowerCase())) break;

  try {
    const answer = await assistant.ask(question, history);
    console.log(`\nBot: ${answer.text}`);
    for (const s of answer.sources) {
      console.log(`  [${s.n}] ${s.docId} - ${s.heading} (score ${s.score})`);
    }
    console.log();
    history.push({ role: "user", text: question }, { role: "assistant", text: answer.text });
  } catch (err) {
    console.error(`\nError: ${(err as Error).message}\n`);
  }
}
rl.close();
