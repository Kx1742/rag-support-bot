// Usage: npm start   (then open http://localhost:3000)
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistant, createProviders, loadEnv } from "../app.ts";
import type { Assistant } from "../rag/assistant.ts";
import { TENANTS_DIR } from "../tenant.ts";
import { createAppServer } from "./http.ts";
import { DailyCap, RateLimiter } from "./rateLimit.ts";

loadEnv();
const env = process.env;
const providers = createProviders(env);
const port = Number(env.PORT ?? 3000);

/** One assistant per tenant, created on first use. Failed loads are retried next time. */
const assistants = new Map<string, Promise<Assistant>>();

async function getAssistant(tenantId: string): Promise<Assistant | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantId)) return null;
  if (!existsSync(join(TENANTS_DIR, tenantId, "tenant.json"))) return null;

  let pending = assistants.get(tenantId);
  if (!pending) {
    pending = createAssistant(tenantId, providers);
    assistants.set(tenantId, pending);
    pending.catch(() => assistants.delete(tenantId));
  }
  return pending;
}

const server = createAppServer({
  getAssistant,
  publicDir: resolve(import.meta.dirname, "..", "..", "public"),
  defaultTenant: env.DEFAULT_TENANT ?? "bean-and-byte",
  limiter: new RateLimiter({
    capacity: Number(env.RATE_LIMIT_BURST ?? 5),
    perMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 10),
  }),
  dailyCap: new DailyCap({ limit: Number(env.DAILY_MESSAGE_LIMIT ?? 500) }),
  trustProxy: env.TRUST_PROXY === "1",
  mode: providers.name,
});

server.listen(port, () => {
  console.log(`Support bot running in ${providers.name.toUpperCase()} mode at http://localhost:${port}`);
});
