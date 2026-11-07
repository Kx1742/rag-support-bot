import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Assistant } from "../rag/assistant.ts";
import type { TenantConfig } from "../types.ts";
import type { DailyCap, RateLimiter } from "./rateLimit.ts";
import { LIMITS, parseChatBody, ValidationError } from "./validate.ts";

/** The part of Assistant the server needs (makes it easy to fake in tests). */
export type ChatAssistant = Pick<Assistant, "tenant" | "askStream">;

export interface ServerDeps {
  /** Returns null when the tenant doesn't exist. */
  getAssistant(tenantId: string): Promise<ChatAssistant | null>;
  publicDir: string;
  defaultTenant: string;
  limiter: RateLimiter;
  dailyCap: DailyCap;
  /** Read the client IP from X-Forwarded-For (only behind a trusted proxy). */
  trustProxy?: boolean;
  mode?: string;
  log?: (message: string) => void;
}

/** Only these files are served, so no path tricks can reach anything else. */
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createAppServer(deps: ServerDeps): Server {
  const log = deps.log ?? ((m: string) => console.log(m));

  return createServer(async (req, res) => {
    try {
      await route(req, res, deps);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof ValidationError ? 400 : 500;
      if (status === 500) log(`Error on ${req.method} ${req.url}: ${(err as Error).stack ?? err}`);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, status, { error: status === 500 ? "Something went wrong" : (err as Error).message });
      }
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && STATIC_FILES[path]) {
    const { file, type } = STATIC_FILES[path];
    const content = await readFile(join(deps.publicDir, file));
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(content);
    return;
  }

  if (req.method === "GET" && path === "/api/health") {
    sendJson(res, 200, { ok: true, mode: deps.mode ?? "unknown" });
    return;
  }

  if (req.method === "GET" && path === "/api/config") {
    sendJson(res, 200, { defaultTenant: deps.defaultTenant, mode: deps.mode ?? "unknown" });
    return;
  }

  const tenantMatch = /^\/api\/tenants\/([^/]+)(\/chat)?$/.exec(path);
  if (tenantMatch) {
    const assistant = await deps.getAssistant(decodeURIComponent(tenantMatch[1]));
    if (!assistant) throw new HttpError(404, "Business not found");

    if (!tenantMatch[2] && req.method === "GET") {
      sendJson(res, 200, publicTenantInfo(assistant.tenant));
      return;
    }
    if (tenantMatch[2] && req.method === "POST") {
      await handleChat(req, res, assistant, deps);
      return;
    }
    throw new HttpError(405, "Method not allowed");
  }

  throw new HttpError(404, "Not found");
}

async function handleChat(req: IncomingMessage, res: ServerResponse, assistant: ChatAssistant, deps: ServerDeps) {
  const limit = deps.limiter.take(clientIp(req, deps.trustProxy));
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfterSec));
    throw new HttpError(429, `Too many messages. Please wait ${limit.retryAfterSec} seconds.`);
  }

  const { message, history } = parseChatBody(await readJson(req));
  if (!deps.dailyCap.take()) {
    throw new HttpError(503, "The demo has reached its daily message limit. Please try again tomorrow.");
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let closed = false;
  res.on("close", () => (closed = true));

  try {
    for await (const event of assistant.askStream(message, history)) {
      if (closed) break; // visitor left: stop sending
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    (deps.log ?? console.log)(`Chat error for ${assistant.tenant.id}: ${(err as Error).message}`);
    if (!closed) {
      const error = "Sorry, the assistant is having trouble right now. Please try again.";
      res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error })}\n\n`);
    }
  }
  res.end();
}

/** Only the fields the browser needs (no internal settings). */
export function publicTenantInfo(t: TenantConfig) {
  return {
    id: t.id,
    name: t.name,
    assistantName: t.assistantName,
    fictional: !!t.fictional,
    suggestedQuestions: (t.suggestedQuestions ?? []).slice(0, 6),
    brandColor: t.brandColor && /^#[0-9a-f]{6}$/i.test(t.brandColor) ? t.brandColor : null,
  };
}

function clientIp(req: IncomingMessage, trustProxy = false): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
