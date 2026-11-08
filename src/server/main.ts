// Usage: npm start   (then open http://localhost:3000, staff desk at /desk)
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistant, createProviders, loadEnv } from "../app.ts";
import type { Assistant } from "../rag/assistant.ts";
import { openShop, type Shop } from "../shop/shop.ts";
import { TENANTS_DIR } from "../tenant.ts";
import { passwordFromEnv, StaffAuth } from "./auth.ts";
import { createAppServer } from "./http.ts";
import { DailyCap, RateLimiter } from "./rateLimit.ts";

loadEnv();
const env = process.env;
const providers = createProviders(env);
const port = Number(env.PORT ?? 3000);

function tenantExists(tenantId: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantId) && existsSync(join(TENANTS_DIR, tenantId, "tenant.json"));
}

/** Caches one promise per tenant; a failed load is forgotten so the next request retries. */
function cached<T>(load: (tenantId: string) => Promise<T>) {
  const cache = new Map<string, Promise<T>>();
  return (tenantId: string): Promise<T> => {
    let pending = cache.get(tenantId);
    if (!pending) {
      pending = load(tenantId);
      cache.set(tenantId, pending);
      pending.catch(() => cache.delete(tenantId));
    }
    return pending;
  };
}

const loadShop = cached((tenantId) => openShop(tenantId));
const getShop = async (tenantId: string): Promise<Shop | null> => (tenantExists(tenantId) ? loadShop(tenantId) : null);

const loadAssistant = cached(async (tenantId) => createAssistant(tenantId, providers, await getShop(tenantId)));
const getAssistant = async (tenantId: string): Promise<Assistant | null> => (tenantExists(tenantId) ? loadAssistant(tenantId) : null);

const staffAuth = new StaffAuth({ passwordFor: passwordFromEnv(env) });

const server = createAppServer({
  getAssistant,
  getShop,
  staffAuth,
  publicDir: resolve(import.meta.dirname, "..", "..", "public"),
  defaultTenant: env.DEFAULT_TENANT ?? "bean-and-byte",
  limiter: new RateLimiter({
    capacity: Number(env.RATE_LIMIT_BURST ?? 5),
    perMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 10),
  }),
  dailyCap: new DailyCap({ limit: Number(env.DAILY_MESSAGE_LIMIT ?? 500) }),
  loginLimiter: new RateLimiter({ capacity: 5, perMinute: 5 }),
  trustProxy: env.TRUST_PROXY === "1",
  secureCookies: env.COOKIE_SECURE === "1",
  mode: providers.name,
});

server.listen(port, () => {
  console.log(`Support bot running in ${providers.name.toUpperCase()} mode at http://localhost:${port}`);
  console.log(`Staff desk: http://localhost:${port}/desk`);
  if (!staffAuth.ownerEnabled(env.DEFAULT_TENANT ?? "bean-and-byte")) {
    console.log("No owner password: set STAFF_PASSWORD (8+ characters) in .env to log in as \"owner\" and add staff accounts.");
  }
  if (providers.name === "offline") console.log("Chat bookings need Gemini; in offline mode customers use the booking form.");
});
