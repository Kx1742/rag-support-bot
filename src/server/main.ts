// Usage: npm start (or npm run start:demo for the public demo)   (then open http://localhost:3000, staff desk at /desk, pickup screen at /display)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAssistant, createProviders, loadEnv } from "../app.ts";
import type { Assistant } from "../rag/assistant.ts";
import { DEMO_ACCOUNTS, seedDemo } from "../shop/demo.ts";
import { openShop, type Shop } from "../shop/shop.ts";
import { zonedNow } from "../shop/time.ts";
import { dataDir, tenantsDir } from "../tenant.ts";
import { passwordFromEnv, StaffAuth } from "./auth.ts";
import { createAppServer } from "./http.ts";
import { DailyCap, RateLimiter } from "./rateLimit.ts";

loadEnv();
const env = process.env;
const providers = createProviders(env);
const port = Number(env.PORT ?? 3000);
const defaultTenant = env.DEFAULT_TENANT ?? "bean-and-byte";
const demo = env.DEMO_MODE === "1" || process.argv.includes("--demo");
const DEMO_RESET_HOUR = Number(env.DEMO_RESET_HOUR ?? 4);
const backupEveryHours = Number(env.BACKUP_EVERY_HOURS ?? 24);

function tenantExists(tenantId: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantId) && existsSync(join(tenantsDir(), tenantId, "tenant.json"));
}

/** Businesses with shop features (a shop.json), default business first. */
function shopTenants(): string[] {
  const ids = readdirSync(tenantsDir()).filter((id) => tenantExists(id) && existsSync(join(tenantsDir(), id, "shop.json")));
  return [defaultTenant, ...ids.filter((id) => id !== defaultTenant).sort()].filter((id) => ids.includes(id));
}

/**
 * Caches one promise per tenant; a failed load is forgotten so the next request retries.
 * refresh() builds a new value in the background and swaps it in once ready, so requests
 * keep using the current one meanwhile.
 */
function cached<T>(load: (tenantId: string) => Promise<T>) {
  const cache = new Map<string, Promise<T>>();
  const versions = new Map<string, number>();
  const get = (tenantId: string): Promise<T> => {
    let pending = cache.get(tenantId);
    if (!pending) {
      pending = load(tenantId);
      cache.set(tenantId, pending);
      pending.catch(() => cache.delete(tenantId));
    }
    return pending;
  };
  get.refresh = (tenantId: string) => {
    if (!cache.has(tenantId)) return; // not loaded yet: the first request loads the latest
    const version = (versions.get(tenantId) ?? 0) + 1;
    versions.set(tenantId, version);
    load(tenantId).then(
      (value) => versions.get(tenantId) === version && cache.set(tenantId, Promise.resolve(value)),
      (err) => console.error(`Could not reload ${tenantId}:`, err),
    );
  };
  return get;
}

const openShops = new Set<Shop>();
const loadShop = cached(async (tenantId) => {
  const shop = await openShop(tenantId);
  if (shop) {
    openShops.add(shop);
    // Answers added on the desk: rebuild this café's assistant so the chat uses them right away.
    shop.events.on("change", (change: { kind: string }) => change.kind === "answers" && loadAssistant.refresh(tenantId));
  }
  return shop;
});
const getShop = async (tenantId: string): Promise<Shop | null> => (tenantExists(tenantId) ? loadShop(tenantId) : null);

const loadAssistant = cached(async (tenantId) => createAssistant(tenantId, providers, await getShop(tenantId)));
const getAssistant = async (tenantId: string): Promise<Assistant | null> => (tenantExists(tenantId) ? loadAssistant(tenantId) : null);

const staffAuth = new StaffAuth({ passwordFor: passwordFromEnv(env) });

const server = createAppServer({
  getAssistant,
  getShop,
  staffAuth,
  publicDir: resolve(import.meta.dirname, "..", "..", "public"),
  defaultTenant,
  limiter: new RateLimiter({
    capacity: Number(env.RATE_LIMIT_BURST ?? 5),
    perMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 10),
  }),
  dailyCap: new DailyCap({ limit: Number(env.DAILY_MESSAGE_LIMIT ?? 500) }),
  loginLimiter: new RateLimiter({ capacity: 5, perMinute: 5 }),
  trustProxy: env.TRUST_PROXY === "1",
  secureCookies: env.COOKIE_SECURE === "1",
  mode: providers.name,
  logRequests: env.LOG_REQUESTS ? env.LOG_REQUESTS === "1" : env.NODE_ENV === "production",
  version: packageVersion(),
  demo: demo
    ? {
        accounts: DEMO_ACCOUNTS.map(({ username, pin, role }) => ({ username, pin, role })),
        resetsAt: `${String(DEMO_RESET_HOUR).padStart(2, "0")}:00`,
        cafes: shopTenants().map((id) => ({
          id,
          name: (JSON.parse(readFileSync(join(tenantsDir(), id, "tenant.json"), "utf8")) as { name: string }).name,
        })),
      }
    : null,
});

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}

// ---------- Public demo: seed on first start, reset every night ----------

async function resetDemo(shop: Shop, reason: string): Promise<void> {
  shop.resetData();
  await seedDemo(shop);
  staffAuth.endAll(shop.tenantId); // demo account ids changed
  console.log(`Demo data ${reason} for ${shop.tenantId}.`);
}

function scheduleNightlyReset(shop: Shop): void {
  const { minutes } = zonedNow(shop.config.timezone, new Date());
  const minutesUntil = (DEMO_RESET_HOUR * 60 - minutes + 1440) % 1440 || 1440;
  setTimeout(async () => {
    try {
      await resetDemo(shop, "reset");
    } catch (err) {
      console.error("Demo reset failed:", err);
    }
    scheduleNightlyReset(shop);
  }, minutesUntil * 60_000).unref();
}

// ---------- Backups ----------

function backupAll(): void {
  for (const shop of openShops) {
    try {
      const file = shop.backup(join(dataDir(), shop.tenantId, "backups"));
      console.log(`Backup saved: ${file}`);
    } catch (err) {
      console.error(`Backup failed for ${shop.tenantId}:`, err);
    }
  }
}

// ---------- Start & stop ----------

server.listen(port, async () => {
  console.log(`Support bot running in ${providers.name.toUpperCase()} mode at http://localhost:${port}`);
  console.log(`Staff desk: http://localhost:${port}/desk · Pickup screen: http://localhost:${port}/display`);
  console.log(`Data folder: ${dataDir()}`);

  if (demo) {
    // Every demo café gets sample data, reset nightly in its own timezone.
    for (const tenantId of shopTenants()) {
      const shop = await getShop(tenantId);
      if (!shop) continue;
      if (shop.staff.count() === 0) await resetDemo(shop, "loaded");
      scheduleNightlyReset(shop);
      console.log(`Demo café ${tenantId}: data resets daily at ${String(DEMO_RESET_HOUR).padStart(2, "0")}:00 (${shop.config.timezone}).`);
    }
    console.log(`PUBLIC DEMO MODE: logins ${DEMO_ACCOUNTS.map((a) => `${a.username}/${a.pin}`).join(", ")}.`);
  } else if (!staffAuth.ownerEnabled(defaultTenant)) {
    console.log('No owner password: set STAFF_PASSWORD (8+ characters) in .env to log in as "owner" and add staff accounts.');
  }
  if (providers.name === "offline") console.log("Chat bookings need Gemini; in offline mode customers use the booking form.");

  if (backupEveryHours > 0) {
    await getShop(defaultTenant); // make sure the main shop is open so it gets backed up
    backupAll();
    setInterval(backupAll, backupEveryHours * 3_600_000).unref();
  }
});

/** Finish open requests and close the databases cleanly when the host stops the app. */
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    for (const shop of openShops) shop.close();
    process.exit(0);
  });
  server.closeAllConnections(); // live streams would otherwise keep it open
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
