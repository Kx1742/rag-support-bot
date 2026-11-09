// Tiny headless-browser driver over the Chrome DevTools Protocol (Edge or Chrome).
// No dependencies: uses Node's built-in WebSocket and fetch.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

export function findBrowser(): string {
  const path = CANDIDATES.find((p): p is string => !!p && existsSync(p));
  if (!path) throw new Error("No Edge/Chrome found. Set BROWSER_PATH to your browser's executable.");
  return path;
}

export interface Page {
  goto(url: string): Promise<void>;
  /** Runs an async JS body in the page and returns its (JSON) result. */
  run<T = unknown>(body: string): Promise<T>;
  /** Polls a JS expression until it's truthy; returns its value. */
  waitFor<T = unknown>(expression: string, opts?: { timeoutMs?: number; what?: string }): Promise<T>;
  screenshot(path: string): Promise<void>;
  setSize(width: number, height: number, mobile?: boolean): Promise<void>;
  /** Uncaught JS errors seen on this page so far. */
  errors: string[];
  close(): void;
}

export class Browser {
  private process: ChildProcess;
  private profile: string;
  private port: number;

  private constructor(process: ChildProcess, profile: string, port: number) {
    this.process = process;
    this.profile = profile;
    this.port = port;
  }

  static async launch(opts: { port?: number } = {}): Promise<Browser> {
    const port = opts.port ?? 9335;
    const profile = mkdtempSync(join(tmpdir(), "browser-"));
    const args = [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      // CI containers often can't use the sandbox.
      ...(process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
      "about:blank",
    ];
    const child = spawn(findBrowser(), args, { stdio: "ignore" });
    const browser = new Browser(child, profile, port);
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        return browser;
      } catch {
        await sleep(100);
      }
    }
    browser.close();
    throw new Error("The browser didn't start its debugging port.");
  }

  /** Opens a new tab. */
  async newPage(): Promise<Page> {
    const target = (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json())) as {
      webSocketDebuggerUrl: string;
    };
    return connectPage(target.webSocketDebuggerUrl);
  }

  close(): void {
    this.process.kill();
    setTimeout(() => rmSync(this.profile, { recursive: true, force: true }), 500);
  }
}

async function connectPage(wsUrl: string): Promise<Page> {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let nextId = 1;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const errors: string[] = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    }
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.fail(new Error(msg.error.message));
    else p?.ok(msg.result);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((ok, fail) => {
      const id = nextId++;
      pending.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");

  const run = async <T>(body: string): Promise<T> => {
    const r = await send("Runtime.evaluate", { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`Page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  };

  return {
    errors,
    async goto(url) {
      await send("Page.navigate", { url });
      // Wait for the page's scripts to be ready.
      for (let i = 0; i < 100; i++) {
        const ready = await run<boolean>(`return document.readyState === "complete";`).catch(() => false);
        if (ready) break;
        await sleep(100);
      }
      await sleep(300);
    },
    run,
    async waitFor<T>(expression: string, opts: { timeoutMs?: number; what?: string } = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 8000);
      let last: unknown;
      while (Date.now() < deadline) {
        last = await run(`try { return (${expression}); } catch { return null; }`);
        if (last) return last as T;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${opts.what ?? expression} (last value: ${JSON.stringify(last)})`);
    },
    async screenshot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    async setSize(width, height, mobile = false) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    },
    close() {
      ws.close();
    },
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
