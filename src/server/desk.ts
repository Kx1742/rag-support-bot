import type { IncomingMessage, ServerResponse } from "node:http";
import { BOOKING_STATUSES, type BookingStatus } from "../shop/bookings.ts";
import { ORDER_STATUSES, type OrderInput, type OrderStatus } from "../shop/orders.ts";
import type { Shop, ShopChange } from "../shop/shop.ts";
import { isDate } from "../shop/time.ts";
import { assertValidTenantId } from "../tenant.ts";
import type { StaffAuth, StaffSession } from "./auth.ts";
import {
  clientIp,
  HttpError,
  idParam,
  parseCookies,
  readObject,
  sendJson,
  sendSse,
  startSse,
} from "./httpUtil.ts";
import type { RateLimiter } from "./rateLimit.ts";

export const SESSION_COOKIE = "desk_session";

export interface DeskDeps {
  getShop(tenantId: string): Promise<Shop | null>;
  staffAuth: StaffAuth;
  loginLimiter: RateLimiter;
  trustProxy?: boolean;
  /** Add "; Secure" to the cookie (set when served over HTTPS). */
  secureCookies?: boolean;
  /** Heartbeat interval for the live events stream. */
  heartbeatMs?: number;
}

/** Handles /api/desk/* routes. Returns false when the path isn't a desk route. */
export async function handleDesk(req: IncomingMessage, res: ServerResponse, url: URL, deps: DeskDeps): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/desk/")) return false;
  const route = `${req.method} ${path.slice("/api/desk".length)}`;

  if (route === "POST /login") {
    await login(req, res, deps);
    return true;
  }
  if (route === "POST /logout") {
    deps.staffAuth.logout(parseCookies(req)[SESSION_COOKIE]);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie("", 0, deps) });
    return true;
  }

  // Everything below needs a logged-in staff member.
  const session = deps.staffAuth.verify(parseCookies(req)[SESSION_COOKIE]);
  if (!session) throw new HttpError(401, "Please log in");
  const shop = await deps.getShop(session.tenantId);
  if (!shop) throw new HttpError(404, "This business has no shop features");

  const date = url.searchParams.get("date") ?? undefined;
  if (date !== undefined && !isDate(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  let match: RegExpExecArray | null;

  switch (route) {
    case "GET /me":
      return ok(res, deskInfo(shop, session));
    case "GET /events":
      liveEvents(req, res, shop, deps.heartbeatMs ?? 25_000);
      return true;
    case "GET /bookings":
      return ok(res, { bookings: shop.bookings.list(date ?? shop.bookings.today().date) });
    case "POST /bookings": {
      const b = await readObject(req);
      const booking = shop.bookings.create(
        {
          date: String(b.date ?? ""),
          time: String(b.time ?? ""),
          partySize: Number(b.partySize),
          name: String(b.name ?? ""),
          phone: String(b.phone ?? ""),
          notes: String(b.notes ?? ""),
          tableId: b.tableId ? String(b.tableId) : undefined,
        },
        "staff",
      );
      return ok(res, { booking }, 201);
    }
    case "GET /availability": {
      const partySize = Number(url.searchParams.get("partySize") ?? 2);
      return ok(res, shop.bookings.availableTimes(date ?? shop.bookings.today().date, partySize, { staff: true }));
    }
    case "GET /menu":
      return ok(res, { menu: shop.menu.list() });
    case "GET /orders":
      return ok(res, { orders: shop.orders.list(date), summary: shop.orders.summary(date) });
    case "POST /orders": {
      const body = await readObject(req);
      const order = shop.orders.create({
        type: body.type as OrderInput["type"],
        tableId: body.tableId ? String(body.tableId) : null,
        customerName: String(body.customerName ?? ""),
        notes: String(body.notes ?? ""),
        items: Array.isArray(body.items)
          ? body.items.map((i: { itemId?: unknown; quantity?: unknown; note?: unknown }) => ({
              itemId: String(i?.itemId ?? ""),
              quantity: Number(i?.quantity),
              note: String(i?.note ?? ""),
            }))
          : [],
      });
      return ok(res, { order }, 201);
    }
  }

  if (req.method === "PATCH" && (match = /^\/bookings\/(\d+)$/.exec(path.slice(9)))) {
    const status = String((await readObject(req)).status) as BookingStatus;
    if (!BOOKING_STATUSES.includes(status)) throw new HttpError(400, "Unknown booking status");
    return ok(res, { booking: shop.bookings.setStatus(idParam(match[1]), status) });
  }
  if (req.method === "PATCH" && (match = /^\/orders\/(\d+)$/.exec(path.slice(9)))) {
    const status = String((await readObject(req)).status) as OrderStatus;
    if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, "Unknown order status");
    return ok(res, { order: shop.orders.setStatus(idParam(match[1]), status) });
  }
  if (req.method === "PATCH" && (match = /^\/menu\/([a-z0-9-]+)$/.exec(path.slice(9)))) {
    const body = await readObject(req);
    if (typeof body.available !== "boolean") throw new HttpError(400, "available must be true or false");
    return ok(res, { item: shop.menu.setAvailable(match[1], body.available) });
  }

  throw new HttpError(404, "Not found");
}

async function login(req: IncomingMessage, res: ServerResponse, deps: DeskDeps): Promise<void> {
  const limit = deps.loginLimiter.take(clientIp(req, deps.trustProxy));
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    throw new HttpError(429, `Too many login attempts. Try again in ${limit.retryAfterSec} seconds.`);
  }
  const body = await readObject(req);
  const tenantId = String(body.tenantId ?? "");
  try {
    assertValidTenantId(tenantId);
  } catch {
    throw new HttpError(401, "Wrong business or password");
  }
  if (!deps.staffAuth.isEnabled(tenantId) || !(await deps.getShop(tenantId))) {
    throw new HttpError(401, "Wrong business or password");
  }
  const token = deps.staffAuth.login(tenantId, String(body.password ?? ""));
  if (!token) throw new HttpError(401, "Wrong business or password");

  const shop = (await deps.getShop(tenantId))!;
  sendJson(res, 200, deskInfo(shop, deps.staffAuth.verify(token)!), { "Set-Cookie": cookie(token, 12 * 60 * 60, deps) });
}

function deskInfo(shop: Shop, session: StaffSession) {
  return {
    tenantId: session.tenantId,
    timezone: shop.config.timezone,
    currency: shop.config.currency,
    today: shop.bookings.today().date,
    tables: shop.config.tables,
    bookingStatuses: BOOKING_STATUSES,
    orderStatuses: ORDER_STATUSES,
  };
}

/** Pushes a "change" event to the desk whenever bookings, orders or the menu change. */
function liveEvents(req: IncomingMessage, res: ServerResponse, shop: Shop, heartbeatMs: number): void {
  startSse(res);
  sendSse(res, "ready", { ok: true });
  const onChange = (change: ShopChange) => {
    // New bookings carry a short summary so the desk can announce them whatever date it shows.
    const booking = change.kind === "booking" && change.action === "created" ? shop.bookings.get(Number(change.id)) : null;
    const summary = booking && { name: booking.name, date: booking.date, time: booking.time, partySize: booking.partySize, source: booking.source };
    sendSse(res, "change", summary ? { ...change, booking: summary } : change);
  };
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
  shop.events.on("change", onChange);
  req.on("close", () => {
    clearInterval(heartbeat);
    shop.events.off("change", onChange);
  });
}

function cookie(token: string, maxAgeSec: number, deps: DeskDeps): string {
  const secure = deps.secureCookies ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/desk; Max-Age=${maxAgeSec}${secure}`;
}

function ok(res: ServerResponse, data: unknown, status = 200): true {
  sendJson(res, status, data);
  return true;
}
