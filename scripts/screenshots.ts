// Takes README screenshots of a running demo server with a headless Edge or Chrome.
// No dependencies: talks to the browser over the Chrome DevTools Protocol with Node's built-in WebSocket.
//
// Usage:
//   npm run start:demo            (in one terminal)
//   npm run screenshots           (in another; or: node scripts/screenshots.ts http://localhost:3000)
// Set BROWSER_PATH if Edge/Chrome isn't found automatically.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const outDir = resolve(import.meta.dirname, "..", "docs", "screenshots");
const port = 9333;

const candidates = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/microsoft-edge",
].filter((p): p is string => !!p);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) throw new Error("No Edge/Chrome found. Set BROWSER_PATH to your browser's executable.");

const config = await fetch(`${base}/api/config`).then((r) => r.json()).catch(() => null);
if (!config?.demo) throw new Error(`Start the demo first (npm run start:demo) so ${base} has demo data and logins.`);
const manager = config.demo.accounts.find((a: { role: string }) => a.role === "manager");

const profile = mkdtempSync(join(tmpdir(), "shots-"));
const browser = spawn(
  browserPath,
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "about:blank"],
  { stdio: "ignore" },
);

try {
  const target = await waitForPage();
  const cdp = await connect(target);
  const send = cdp.send;
  await send("Page.enable");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const size = (width: number, height: number, mobile = false) =>
    send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const go = async (path: string) => {
    await send("Page.navigate", { url: `${base}${path}` });
    await sleep(1800);
  };
  const run = async (js: string) => {
    const r = (await send("Runtime.evaluate", { expression: `(async () => { ${js} })()`, awaitPromise: true })) as {
      exceptionDetails?: { exception?: { description?: string } };
    };
    if (r.exceptionDetails) throw new Error(`Page script failed: ${r.exceptionDetails.exception?.description}`);
    await sleep(500);
  };
  const shot = async (name: string) => {
    const { data } = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
    console.log(`saved docs/screenshots/${name}`);
  };
  mkdirSync(outDir, { recursive: true });

  // 1. Customer chat with an order-ahead card.
  await size(1280, 860);
  await go("/");
  await run(`
    document.getElementById("order-btn").click();
    await new Promise((r) => setTimeout(r, 800));
    const card = document.querySelector(".order-card");
    const add = (n) => [...card.querySelectorAll(".order-row")].find((r) => r.querySelector(".order-name").textContent === n).querySelector(".add-btn").click();
    add("Flat White");
    await new Promise((r) => setTimeout(r, 150));
    const pick = (t) => [...card.querySelectorAll(".opt-row button")].find((b) => b.textContent.startsWith(t)).click();
    pick("Large"); pick("Oat milk");
    card.querySelector(".opt-picker .primary").click();
    const inputs = card.querySelectorAll("input");
    inputs[0].value = "Alex"; inputs[1].value = "555 010 4242";
    document.querySelector(".messages").scrollTop = 0;
  `);
  await shot("chat-order-ahead.png");

  // 2. Staff desk as the demo manager.
  await run(`await fetch("/api/desk/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: ${JSON.stringify(config.defaultTenant)}, username: ${JSON.stringify(manager.username)}, pin: ${JSON.stringify(manager.pin)} }) });`);
  await go("/desk");
  await run(`
    addLine("latte", { size: "large", milk: "oat" }, 2, "");
    addLine("croissant", { "food-extras": ["warmed"] }, 1, "");
    document.querySelector("#member-slot button").click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById("ly-phone").value = "5550100100";
    document.getElementById("ly-find").click();
    await new Promise((r) => setTimeout(r, 600));
    [...document.querySelectorAll(".reward-opt")].find((b) => b.textContent.startsWith("Free drink")).click();
  `);
  await shot("desk-till.png");

  for (const [tab, file] of [
    ["orders", "desk-kitchen.png"],
    ["bookings", "desk-bookings.png"],
    ["report", "desk-report.png"],
  ] as const) {
    await run(`document.querySelector('[data-tab="${tab}"]').click();`);
    await sleep(600);
    await shot(file);
  }

  // 3. Customer pickup screen.
  await go(`/display?tenant=${encodeURIComponent(config.defaultTenant)}`);
  await shot("pickup-screen.png");

  // 4. Phone: the chat as most customers see it.
  await size(390, 844, true);
  await go("/");
  await run(`document.getElementById("book-btn").click(); await new Promise((r) => setTimeout(r, 600)); document.querySelector(".messages").scrollTop = 0;`);
  await shot("phone-chat.png");

  cdp.close();
} finally {
  browser.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* Windows can keep the browser profile locked briefly; it's only a temp folder */
  }
}

async function waitForPage(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as { type: string; webSocketDebuggerUrl: string }[];
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* browser still starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("The browser didn't start its debugging port.");
}

async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let nextId = 1;
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.fail(new Error(msg.error.message));
    else p?.ok(msg.result);
  };
  return {
    send: (method: string, params: Record<string, unknown> = {}) =>
      new Promise<unknown>((ok, fail) => {
        const id = nextId++;
        pending.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}
