import type { IncomingMessage, ServerResponse } from "node:http";
import { ShopError } from "../shop/errors.ts";
import { LIMITS, ValidationError } from "./validate.ts";

export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** HTTP status for an error; 500 means "unexpected, log it and hide details". */
export function statusFor(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (err instanceof ValidationError) return 400;
  if (err instanceof ShopError) {
    if (err.code === "not_found") return 404;
    // 409 = the request is fine but clashes with the current state (slot taken, already paid...).
    const conflicts = ["unavailable", "invalid_status", "sold_out", "needs_refund", "already_paid", "not_paid", "taken", "last_manager"];
    if (conflicts.includes(err.code)) return 409;
    if (err.code === "too_many") return 429;
    return 400;
  }
  return 500;
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

/**
 * Reads a JSON body. Requiring Content-Type: application/json also blocks
 * cross-site form posts (browsers can't send it cross-origin without CORS).
 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > LIMITS.bodyBytes) throw new HttpError(413, "Request body too large");
    parts.push(part as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Reads a JSON object body, rejecting arrays/primitives. */
export async function readObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJson(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
  return body as Record<string, unknown>;
}

export function clientIp(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Starts a Server-Sent Events response. */
export function startSse(res: ServerResponse): void {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export function sendSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Positive integer from a URL segment, or a 404. */
export function idParam(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, "Not found");
  return id;
}
