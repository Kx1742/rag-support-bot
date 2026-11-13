import type { IncomingMessage, ServerResponse } from "node:http";
import { BOOKING_STATUSES, type BookingStatus } from "../shop/bookings.ts";
import { paymentMethods } from "../shop/config.ts";
import { ORDER_STATUSES, type OrderInput, type OrderStatus, PAYMENT_METHODS, type PaymentInput } from "../shop/orders.ts";
import type { MenuItemInput } from "../shop/menu.ts";
import type { Shop, ShopChange } from "../shop/shop.ts";
import { isDemoAccount } from "../shop/demo.ts";
import { OWNER_USERNAME, ROLES, type Role } from "../shop/staff.ts";
import { isDate } from "../shop/time.ts";
import { assertValidTenantId } from "../tenant.ts";
import type { StaffAuth, StaffSession } from "./auth.ts";
import { clientIp, HttpError, idParam, parseCookies, readObject, sendJson, sendSse, startSse } from "./httpUtil.ts";
import { can, PERMISSIONS, type Permission, ROLE_PERMISSIONS } from "./permissions.ts";
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
  /** Public demo: the shared demo accounts can't be changed. */
  demo?: boolean;
  /** The business's display name, for receipts. */
  businessName?: (tenantId: string) => Promise<string | undefined>;
}

/** Handles /api/desk/* routes. Returns false when the path isn't a desk route. */
export async function handleDesk(req: IncomingMessage, res: ServerResponse, url: URL, deps: DeskDeps): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/desk/")) return false;
  const sub = path.slice("/api/desk".length);
  const route = `${req.method} ${sub}`;

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
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = deps.staffAuth.verify(token);
  if (!session) throw new HttpError(401, "Please log in");
  const shop = await deps.getShop(session.tenantId);
  if (!shop) throw new HttpError(404, "This business has no shop features");

  // Re-check the account on every request so deactivation and role changes apply immediately.
  const user = currentUser(session, shop);
  if (!user) {
    deps.staffAuth.logout(token);
    throw new HttpError(401, "Your account is no longer active. Please log in again.");
  }
  const need = (permission: Permission) => {
    if (!can(user.role, permission)) throw new HttpError(403, `Only managers can do that (${PERMISSIONS[permission].toLowerCase()}).`);
  };
  const actor = { name: user.name };

  const date = url.searchParams.get("date") ?? undefined;
  if (date !== undefined && !isDate(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  let match: RegExpExecArray | null;

  switch (route) {
    case "GET /me":
      return ok(res, deskInfo(shop, user));
    case "GET /events":
      liveEvents(req, res, shop, deps.heartbeatMs ?? 25_000);
      return true;

    // ----- bookings -----
    case "GET /bookings":
      need("bookings.manage");
      return ok(res, { bookings: shop.bookings.list(date ?? shop.bookings.today().date) });
    case "POST /bookings": {
      need("bookings.manage");
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
      need("bookings.manage");
      const partySize = Number(url.searchParams.get("partySize") ?? 2);
      const tableId = url.searchParams.get("tableId") || undefined;
      if (tableId && !shop.config.tables.some((t) => t.id === tableId)) throw new HttpError(400, "Unknown table");
      return ok(res, shop.bookings.availableTimes(date ?? shop.bookings.today().date, partySize, { staff: true, tableId }));
    }

    // ----- menu & orders -----
    case "GET /menu":
      // Managers also see hidden items so they can bring them back.
      return ok(res, { menu: shop.menu.list({ includeHidden: can(user.role, "menu.edit") }), optionGroups: shop.menu.optionGroups() });
    case "POST /menu": {
      need("menu.edit");
      return ok(res, { item: shop.menu.create(parseMenuItem(await readObject(req))) }, 201);
    }
    case "GET /orders": {
      const summary = shop.orders.summary(date);
      // Staff see workload numbers; money totals are for managers.
      const visible = can(user.role, "sales.view") ? summary : { orders: summary.orders, items: summary.items, open: summary.open, unpaid: summary.unpaid };
      return ok(res, { orders: shop.orders.list(date), summary: visible });
    }
    // ----- loyalty -----
    case "GET /loyalty": {
      need("loyalty.use");
      const member = shop.loyalty.find(url.searchParams.get("phone") ?? "");
      if (!member) throw new HttpError(404, "No member with that phone number.");
      return ok(res, { member, summary: shop.loyalty.summary(member), history: shop.loyalty.history(member.id, 10) });
    }
    case "POST /loyalty": {
      need("loyalty.use");
      const b = await readObject(req);
      const member = shop.loyalty.join(String(b.phone ?? ""), String(b.name ?? ""));
      return ok(res, { member, summary: shop.loyalty.summary(member), history: [] }, 201);
    }

    case "POST /orders": {
      need("till.use");
      const body = await readObject(req);
      const payment = body.payment ? parsePayment(body.payment) : undefined;
      if (payment) need("payments.take");
      if (body.memberId !== undefined && body.memberId !== null) need("loyalty.use");
      const order = shop.orders.create(parseOrder(body), {
        by: actor,
        clientRef: body.clientRef === undefined ? undefined : String(body.clientRef),
        payment,
      });
      return ok(res, { order }, 201);
    }
    case "GET /report":
      need("reports.view");
      return ok(res, shop.orders.report(date));

    // ----- what customers asked the chat assistant -----
    case "GET /questions":
      need("reports.view");
      return ok(res, shop.questions.summary(Number(url.searchParams.get("days") ?? 30)));
    case "POST /questions/handled": {
      need("reports.view");
      const b = await readObject(req);
      return ok(res, { handled: shop.questions.markHandled(String(b.key ?? "")) });
    }

    // ----- staff accounts -----
    case "GET /staff":
      need("staff.manage");
      return ok(res, {
        staff: shop.staff.list(),
        ownerLogin: deps.staffAuth.ownerEnabled(shop.tenantId),
        // The same table the server enforces, so the help screen can't drift from reality.
        rolePermissions: ROLE_PERMISSIONS,
        permissionLabels: PERMISSIONS,
      });
    case "POST /staff": {
      need("staff.manage");
      const b = await readObject(req);
      const member = await shop.staff.create({
        username: String(b.username ?? ""),
        name: String(b.name ?? ""),
        role: String(b.role ?? "") as Role,
        pin: String(b.pin ?? ""),
      });
      return ok(res, { member }, 201);
    }
  }

  const rest = sub;
  if (req.method === "PATCH" && (match = /^\/bookings\/(\d+)$/.exec(rest))) {
    need("bookings.manage");
    const status = String((await readObject(req)).status) as BookingStatus;
    if (!BOOKING_STATUSES.includes(status)) throw new HttpError(400, "Unknown booking status");
    return ok(res, { booking: shop.bookings.setStatus(idParam(match[1]), status) });
  }
  if (req.method === "PATCH" && (match = /^\/orders\/(\d+)$/.exec(rest))) {
    need("orders.manage");
    const status = String((await readObject(req)).status) as OrderStatus;
    if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, "Unknown order status");
    return ok(res, { order: shop.orders.setStatus(idParam(match[1]), status) });
  }
  if (req.method === "POST" && (match = /^\/orders\/(\d+)\/pay$/.exec(rest))) {
    need("payments.take");
    return ok(res, { order: shop.orders.pay(idParam(match[1]), parsePayment(await readObject(req)), actor) });
  }
  if (req.method === "GET" && (match = /^\/orders\/(\d+)\/receipt$/.exec(rest))) {
    need("till.use");
    const order = shop.orders.get(idParam(match[1]));
    if (!order) throw new HttpError(404, "Order not found");
    return ok(res, { receipt: shop.orders.receipt(order, (await deps.businessName?.(shop.tenantId)) ?? shop.tenantId) });
  }
  if (req.method === "POST" && (match = /^\/orders\/(\d+)\/refund$/.exec(rest))) {
    need("payments.refund");
    return ok(res, { order: shop.orders.refund(idParam(match[1]), String((await readObject(req)).reason ?? ""), actor) });
  }
  if (req.method === "PATCH" && (match = /^\/menu\/([a-z0-9-]+)$/.exec(rest))) {
    const id = match[1];
    const body = await readObject(req);
    // Staff: sold-out switch and stock counts. Managers: everything else.
    if (typeof body.available === "boolean") {
      need("menu.soldOut");
      return ok(res, { item: shop.menu.setAvailable(id, body.available) });
    }
    if ("stock" in body && Object.keys(body).length === 1) {
      need("menu.soldOut");
      return ok(res, { item: shop.menu.setStock(id, body.stock === null ? null : Number(body.stock)) });
    }
    if (typeof body.hidden === "boolean") {
      need("menu.edit");
      return ok(res, { item: shop.menu.setHidden(id, body.hidden) });
    }
    need("menu.edit");
    return ok(res, { item: shop.menu.update(id, parseMenuItem(body)) });
  }
  if (req.method === "PATCH" && (match = /^\/staff\/(\d+)$/.exec(rest))) {
    need("staff.manage");
    const id = idParam(match[1]);
    const b = await readObject(req);
    const target = shop.staff.get(id);
    if (deps.demo && target && isDemoAccount(target.username)) {
      throw new HttpError(403, "The shared demo accounts can't be changed in the public demo. Add your own staff account to try this.");
    }
    if (id === user.staffId && (b.active === false || (b.role !== undefined && b.role !== "manager"))) {
      throw new HttpError(400, "You can't deactivate or demote your own account. Ask another manager.");
    }
    const member = await shop.staff.update(id, {
      name: b.name === undefined ? undefined : String(b.name),
      role: b.role === undefined ? undefined : (String(b.role) as Role),
      active: typeof b.active === "boolean" ? b.active : undefined,
      pin: b.pin === undefined ? undefined : String(b.pin),
    });
    // A new PIN or deactivation signs them out everywhere.
    if (b.pin !== undefined || member.active === false) deps.staffAuth.endSessionsFor(shop.tenantId, id);
    return ok(res, { member });
  }

  throw new HttpError(404, "Not found");
}

interface CurrentUser {
  staffId: number | null;
  username: string;
  name: string;
  role: Role;
}

function currentUser(session: StaffSession, shop: Shop): CurrentUser | null {
  if (session.staffId === null) return { staffId: null, username: OWNER_USERNAME, name: session.name, role: "manager" };
  const member = shop.staff.get(session.staffId);
  if (!member?.active) return null;
  return { staffId: member.id, username: member.username, name: member.name, role: member.role };
}

async function login(req: IncomingMessage, res: ServerResponse, deps: DeskDeps): Promise<void> {
  const limit = deps.loginLimiter.take(clientIp(req, deps.trustProxy));
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    throw new HttpError(429, `Too many login attempts. Try again in ${limit.retryAfterSec} seconds.`);
  }
  const fail = () => new HttpError(401, "Wrong username or PIN");
  const body = await readObject(req);
  const tenantId = String(body.tenantId ?? "");
  try {
    assertValidTenantId(tenantId);
  } catch {
    throw fail();
  }
  const shop = await deps.getShop(tenantId);
  if (!shop) throw fail();

  // "owner" (or no username, for older clients) = the password from .env.
  const username = String(body.username ?? "").trim().toLowerCase() || OWNER_USERNAME;
  const secret = String(body.pin ?? body.password ?? "");
  let identity;
  if (username === OWNER_USERNAME) {
    if (!deps.staffAuth.checkOwner(tenantId, secret)) throw fail();
    identity = { tenantId, staffId: null, username: OWNER_USERNAME, name: "Owner", role: "manager" as const };
  } else {
    const member = await shop.staff.authenticate(username, secret);
    if (!member) throw fail();
    identity = { tenantId, staffId: member.id, username: member.username, name: member.name, role: member.role };
  }

  const token = deps.staffAuth.start(identity);
  sendJson(res, 200, deskInfo(shop, identity), { "Set-Cookie": cookie(token, 12 * 60 * 60, deps) });
}

function deskInfo(shop: Shop, user: CurrentUser & { tenantId?: string }) {
  return {
    tenantId: shop.tenantId,
    user: { name: user.name, username: user.username, role: user.role },
    permissions: ROLE_PERMISSIONS[user.role],
    roles: ROLES,
    timezone: shop.config.timezone,
    currency: shop.config.currency,
    locale: shop.config.locale ?? "en-US",
    charges: shop.config.charges ?? [],
    payments: { methods: paymentMethods(shop.config), qrName: shop.config.payments?.qrName ?? "QR payment" },
    cashRounding: shop.config.cashRounding ?? 1,
    today: shop.bookings.today().date,
    tables: shop.config.tables,
    stations: shop.config.stations ?? [],
    loyalty: shop.config.loyalty
      ? { name: shop.config.loyalty.name, pointsPerDollar: shop.config.loyalty.pointsPerDollar, rewards: shop.config.loyalty.rewards }
      : null,
    bookingStatuses: BOOKING_STATUSES,
    orderStatuses: ORDER_STATUSES,
  };
}

function parseOrder(body: Record<string, unknown>): OrderInput {
  return {
    type: body.type as OrderInput["type"],
    tableId: body.tableId ? String(body.tableId) : null,
    customerName: String(body.customerName ?? ""),
    notes: String(body.notes ?? ""),
    items: Array.isArray(body.items)
      ? body.items.map((i: { itemId?: unknown; quantity?: unknown; note?: unknown; options?: unknown }) => ({
          itemId: String(i?.itemId ?? ""),
          quantity: Number(i?.quantity),
          note: String(i?.note ?? ""),
          options: i?.options && typeof i.options === "object" && !Array.isArray(i.options) ? (i.options as Record<string, string | string[]>) : {},
        }))
      : [],
    memberId: body.memberId === undefined || body.memberId === null ? null : Number(body.memberId),
    rewardId: body.rewardId ? String(body.rewardId) : null,
  };
}

function parseMenuItem(b: Record<string, unknown>): MenuItemInput {
  return {
    name: String(b.name ?? ""),
    category: String(b.category ?? ""),
    price: Number(b.price),
    options: Array.isArray(b.options) ? b.options.map(String) : [],
    stock: b.stock === null || b.stock === undefined || b.stock === "" ? null : Number(b.stock),
  };
}

function parsePayment(raw: unknown): PaymentInput {
  const p = (raw ?? {}) as { method?: unknown; tendered?: unknown };
  const method = String(p.method ?? "") as PaymentInput["method"];
  if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, "Unknown payment method");
  return { method, tendered: p.tendered === undefined ? undefined : Number(p.tendered) };
}

/** Pushes a "change" event to the desk whenever bookings, orders or the menu change. */
function liveEvents(req: IncomingMessage, res: ServerResponse, shop: Shop, heartbeatMs: number): void {
  startSse(res);
  sendSse(res, "ready", { ok: true });
  const onChange = (change: ShopChange) => {
    // New bookings and orders carry a short summary so the desk can announce them.
    const created = change.action === "created";
    const booking = created && change.kind === "booking" ? shop.bookings.get(Number(change.id)) : null;
    const order = created && change.kind === "order" ? shop.orders.get(Number(change.id)) : null;
    sendSse(res, "change", {
      ...change,
      ...(booking && {
        booking: { name: booking.name, date: booking.date, time: booking.time, partySize: booking.partySize, source: booking.source },
      }),
      ...(order && { order: { number: order.number, type: order.type, tableId: order.tableId, by: order.createdBy, source: order.source } }),
    });
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
