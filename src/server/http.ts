import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Assistant } from "../rag/assistant.ts";
import type { Shop, ShopChange } from "../shop/shop.ts";
import { isDate } from "../shop/time.ts";
import type { TenantConfig } from "../types.ts";
import type { StaffAuth } from "./auth.ts";
import { handleDesk } from "./desk.ts";
import {
  clientIp,
  HttpError,
  readObject,
  SECURITY_HEADERS,
  sendJson,
  sendSse,
  startSse,
  statusFor,
} from "./httpUtil.ts";
import { DailyCap, RateLimiter } from "./rateLimit.ts";
import { parseChatBody } from "./validate.ts";

/** The part of Assistant the server needs (makes it easy to fake in tests). */
export type ChatAssistant = Pick<Assistant, "tenant" | "askStream"> & { canUseTools?: boolean };

export interface ServerDeps {
  /** Returns null when the tenant doesn't exist. */
  getAssistant(tenantId: string): Promise<ChatAssistant | null>;
  /** Returns null when the tenant has no shop (bookings/till) features. */
  getShop?(tenantId: string): Promise<Shop | null>;
  staffAuth?: StaffAuth;
  publicDir: string;
  defaultTenant: string;
  limiter: RateLimiter;
  dailyCap: DailyCap;
  loginLimiter?: RateLimiter;
  /** Read the client IP from X-Forwarded-For (only behind a trusted proxy). */
  trustProxy?: boolean;
  secureCookies?: boolean;
  mode?: string;
  log?: (message: string) => void;
  /** Public demo settings shown to visitors (demo logins, reset time). */
  demo?: { accounts: { username: string; pin: string; role: string }[]; resetsAt: string } | null;
  /** Log one line per API request (method, path, status, time). */
  logRequests?: boolean;
  /** App version shown by /api/health. */
  version?: string;
}

/** Only these files are served, so no path tricks can reach anything else. */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/i18n.js": { file: "i18n.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/desk": { file: "desk.html", type: "text/html; charset=utf-8" },
  "/desk.js": { file: "desk.js", type: "text/javascript; charset=utf-8" },
  "/desk.css": { file: "desk.css", type: "text/css; charset=utf-8" },
  "/display": { file: "display.html", type: "text/html; charset=utf-8" },
  "/display.js": { file: "display.js", type: "text/javascript; charset=utf-8" },
  "/display.css": { file: "display.css", type: "text/css; charset=utf-8" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/app.webmanifest": { file: "app.webmanifest", type: "application/manifest+json" },
  "/desk.webmanifest": { file: "desk.webmanifest", type: "application/manifest+json" },
};

/** Public live streams (pickup screens) are capped so nobody can hog connections. */
const MAX_PUBLIC_STREAMS = 50;
let publicStreams = 0;

export function createAppServer(deps: ServerDeps): Server {
  const log = deps.log ?? ((m: string) => console.log(m));

  return createServer(async (req, res) => {
    // A short id on every response, so a visitor's error report can be matched to the log.
    const requestId = randomUUID().slice(0, 8);
    const started = performance.now();
    // Only the path is ever logged: query strings can hold phone numbers (e.g. loyalty lookups).
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("X-Request-Id", requestId);
    if (deps.secureCookies) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (deps.logRequests && path.startsWith("/api/") && path !== "/api/health") {
      res.on("close", () => log(`${req.method} ${path} ${res.statusCode} ${Math.round(performance.now() - started)}ms [${requestId}]`));
    }

    try {
      await route(req, res, deps);
    } catch (err) {
      const status = statusFor(err);
      if (status === 500) log(`Error [${requestId}] on ${req.method} ${path}: ${(err as Error).stack ?? err}`);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, status, status === 500 ? { error: "Something went wrong", requestId } : { error: (err as Error).message });
      }
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const getShop = deps.getShop ?? (async () => null);

  if (req.method === "GET" && STATIC_FILES[path]) {
    const { file, type } = STATIC_FILES[path];
    const content = await readFile(join(deps.publicDir, file));
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(content);
    return;
  }

  // Health check for the host: also proves the main database answers.
  if (req.method === "GET" && path === "/api/health") {
    let database = "none";
    try {
      const shop = await getShop(deps.defaultTenant);
      if (shop) {
        shop.ping();
        database = "ok";
      }
    } catch {
      database = "error";
    }
    const ok = database !== "error";
    sendJson(res, ok ? 200 : 503, {
      ok,
      mode: deps.mode ?? "unknown",
      version: deps.version ?? "dev",
      uptimeSeconds: Math.round(process.uptime()),
      database,
    });
    return;
  }

  if (req.method === "GET" && path === "/api/config") {
    sendJson(res, 200, { defaultTenant: deps.defaultTenant, mode: deps.mode ?? "unknown", demo: deps.demo ?? null });
    return;
  }

  if (deps.staffAuth && deps.loginLimiter) {
    const handled = await handleDesk(req, res, url, {
      getShop,
      staffAuth: deps.staffAuth,
      loginLimiter: deps.loginLimiter,
      trustProxy: deps.trustProxy,
      secureCookies: deps.secureCookies,
      demo: !!deps.demo,
      businessName: async (tenantId) => (await deps.getAssistant(tenantId))?.tenant.name,
    });
    if (handled) return;
  }

  const tenantMatch =
    /^\/api\/tenants\/([^/]+)(?:\/(chat|availability|bookings|bookings\/lookup|bookings\/cancel|pickup|pickup\/events|menu|orders|orders\/track|orders\/track\/events|loyalty))?$/.exec(path);
  if (tenantMatch) {
    const tenantId = decodeURIComponent(tenantMatch[1]);
    const assistant = await deps.getAssistant(tenantId);
    if (!assistant) throw new HttpError(404, "Business not found");
    const action = tenantMatch[2];

    if (!action && req.method === "GET") {
      sendJson(res, 200, publicTenantInfo(assistant.tenant, await getShop(tenantId), !!assistant.canUseTools));
      return;
    }
    if (action === "chat" && req.method === "POST") {
      await handleChat(req, res, assistant, deps);
      return;
    }

    const shop = await getShop(tenantId);
    if (!shop) throw new HttpError(404, "This business doesn't take bookings online");

    if (action === "availability" && req.method === "GET") {
      const date = url.searchParams.get("date") ?? "";
      if (!isDate(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
      const partySize = Number(url.searchParams.get("partySize") ?? 2);
      sendJson(res, 200, { date, partySize, ...shop.bookings.availableTimes(date, partySize) });
      return;
    }
    // Order ahead: the public menu (available items only) and today's pickup times.
    if (action === "menu" && req.method === "GET") {
      const menu = shop.menu
        .list()
        .filter((m) => m.available)
        .map(({ id, name, category, price, options, stock }) => ({ id, name, category, price, options, lowStock: stock !== null && stock <= 5 ? stock : null }));
      sendJson(res, 200, { menu, optionGroups: shop.menu.optionGroups(), ordering: shop.orders.pickupSlots() });
      return;
    }
    if (action === "orders" && req.method === "POST") {
      takeRateLimit(req, res, deps);
      const b = await readObject(req);
      const order = shop.orders.createOnline(
        {
          name: String(b.name ?? ""),
          phone: String(b.phone ?? ""),
          pickupTime: String(b.pickupTime ?? ""),
          notes: String(b.notes ?? ""),
          items: Array.isArray(b.items)
            ? b.items.map((i: { itemId?: unknown; quantity?: unknown; note?: unknown; options?: unknown }) => ({
                itemId: String(i?.itemId ?? ""),
                quantity: Number(i?.quantity),
                note: String(i?.note ?? ""),
                options: i?.options && typeof i.options === "object" && !Array.isArray(i.options) ? (i.options as Record<string, string | string[]>) : {},
              }))
            : [],
        },
        b.clientRef === undefined ? undefined : String(b.clientRef),
      );
      // The token is only ever sent here, to the customer who just placed the order.
      sendJson(res, 201, { order: shop.orders.toPublic(order, { withToken: true }) });
      return;
    }
    // Live order status for the customer who holds the private tracking token.
    if (action === "orders/track" && req.method === "GET") {
      const order = shop.orders.byTrackingToken(url.searchParams.get("token") ?? "");
      if (!order) throw new HttpError(404, "Order not found");
      // A receipt once there's a payment to show (the customer pays at pickup).
      const receipt = order.payment.status !== "unpaid" ? shop.orders.receipt(order, assistant.tenant.name) : null;
      sendJson(res, 200, { order: shop.orders.toPublic(order), receipt });
      return;
    }
    if (action === "orders/track/events" && req.method === "GET") {
      const order = shop.orders.byTrackingToken(url.searchParams.get("token") ?? "");
      if (!order) throw new HttpError(404, "Order not found");
      if (publicStreams >= MAX_PUBLIC_STREAMS) throw new HttpError(503, "Too many screens connected");
      publicStreams++;
      startSse(res);
      sendSse(res, "status", { status: order.status });
      const onChange = (change: ShopChange) => {
        if (change.kind !== "order" || Number(change.id) !== order.id) return;
        const now = shop.orders.get(order.id);
        if (now) sendSse(res, "status", { status: now.status });
      };
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
      shop.events.on("change", onChange);
      req.on("close", () => {
        publicStreams--;
        clearInterval(heartbeat);
        shop.events.off("change", onChange);
      });
      return;
    }
    // Loyalty balance: points and rewards only (no name or history), by phone number.
    if (action === "loyalty" && req.method === "POST") {
      takeRateLimit(req, res, deps);
      if (!shop.loyalty.enabled) throw new HttpError(404, "This business doesn't have a loyalty program.");
      const member = shop.loyalty.find(String((await readObject(req)).phone ?? ""));
      if (!member) throw new HttpError(404, "No member with that phone number. Ask at the counter to join, it's free.");
      sendJson(res, 200, shop.loyalty.summary(member));
      return;
    }

    // Pickup screen: order numbers only, no names or items.
    if (action === "pickup" && req.method === "GET") {
      sendJson(res, 200, { name: assistant.tenant.name, ...shop.orders.pickupBoard() });
      return;
    }
    if (action === "pickup/events" && req.method === "GET") {
      if (publicStreams >= MAX_PUBLIC_STREAMS) throw new HttpError(503, "Too many screens connected");
      publicStreams++;
      startSse(res);
      sendSse(res, "ready", { ok: true });
      const onChange = (change: ShopChange) => {
        if (change.kind === "order") sendSse(res, "change", { kind: "order" });
      };
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
      shop.events.on("change", onChange);
      req.on("close", () => {
        publicStreams--;
        clearInterval(heartbeat);
        shop.events.off("change", onChange);
      });
      return;
    }

    // Customers manage their own booking with the reference + phone they booked with.
    if ((action === "bookings/lookup" || action === "bookings/cancel") && req.method === "POST") {
      takeRateLimit(req, res, deps);
      const b = await readObject(req);
      const reference = String(b.reference ?? "");
      const phone = String(b.phone ?? "");
      const booking =
        action === "bookings/cancel" ? shop.bookings.cancelByReference(reference, phone) : shop.bookings.findForCustomer(reference, phone);
      sendJson(res, 200, { booking: shop.bookings.toPublic(booking) });
      return;
    }
    if (action === "bookings" && req.method === "POST") {
      takeRateLimit(req, res, deps);
      const b = await readObject(req);
      const booking = shop.bookings.create(
        {
          date: String(b.date ?? ""),
          time: String(b.time ?? ""),
          partySize: Number(b.partySize),
          name: String(b.name ?? ""),
          phone: String(b.phone ?? ""),
          notes: String(b.notes ?? ""),
        },
        "web",
      );
      sendJson(res, 201, { booking: shop.bookings.toPublic(booking) });
      return;
    }
    throw new HttpError(405, "Method not allowed");
  }

  throw new HttpError(404, "Not found");
}

function takeRateLimit(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): void {
  const limit = deps.limiter.take(clientIp(req, deps.trustProxy));
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    throw new HttpError(429, `Too many messages. Please wait ${limit.retryAfterSec} seconds.`);
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse, assistant: ChatAssistant, deps: ServerDeps) {
  takeRateLimit(req, res, deps);
  const { message, history } = parseChatBody(await readObject(req));
  if (!deps.dailyCap.take()) {
    throw new HttpError(503, "The demo has reached its daily message limit. Please try again tomorrow.");
  }

  startSse(res);
  let closed = false;
  res.on("close", () => (closed = true));

  try {
    for await (const event of assistant.askStream(message, history)) {
      if (closed) break; // visitor left: stop sending
      sendSse(res, event.type, event);
    }
  } catch (err) {
    (deps.log ?? console.log)(`Chat error for ${assistant.tenant.id}: ${(err as Error).message}`);
    if (!closed) {
      sendSse(res, "error", { type: "error", error: "Sorry, the assistant is having trouble right now. Please try again." });
    }
  }
  res.end();
}

/** Only the fields the browser needs (no internal settings). */
export function publicTenantInfo(t: TenantConfig, shop: Shop | null = null, canUseTools = false) {
  return {
    id: t.id,
    name: t.name,
    assistantName: t.assistantName,
    fictional: !!t.fictional,
    suggestedQuestions: (t.suggestedQuestions ?? []).slice(0, 6),
    /** True when the chat assistant itself can make and cancel bookings. */
    chatBookings: !!shop && canUseTools,
    brandColor: t.brandColor && /^#[0-9a-f]{6}$/i.test(t.brandColor) ? t.brandColor : null,
    orderAhead: !!shop?.config.orderAhead,
    loyalty: shop?.config.loyalty ? { name: shop.config.loyalty.name } : null,
    booking: shop
      ? {
          today: shop.bookings.today().date,
          maxPartySize: shop.bookings.maxPartySize,
          maxDaysAhead: shop.config.booking.maxDaysAhead,
        }
      : null,
  };
}
