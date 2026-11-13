// Records the README's animated demo (docs/demo.png, an animated PNG) by clicking through the main
// journey in a headless Edge/Chrome: question → order ahead → kitchen → ready → pickup screen → till
// → the owner's report → teaching an answer → the Malaysian café in Chinese.
//
//   npm run demo-tour
//
// Like the browser tests, it starts its own demo server on a copy of the cafés where it's midday,
// so ordering is open whenever you record.

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApng } from "./lib/apng.ts";
import { Browser, type Page, sleep } from "./lib/browser.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 4124;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = join(ROOT, "docs", "demo.png");
const WIDTH = 1200;
const HEIGHT = 750;

const work = mkdtempSync(join(tmpdir(), "tour-"));
const tenants = join(work, "tenants");
for (const id of ["bean-and-byte", "kopi-kita"]) {
  cpSync(join(ROOT, "tenants", id), join(tenants, id), { recursive: true });
  const file = join(tenants, id, "shop.json");
  const shop = JSON.parse(readFileSync(file, "utf8"));
  const offset = 12 - new Date().getUTCHours();
  shop.timezone = offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
  shop.closedDates = [];
  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) shop.openingHours[day] = ["07:00", "22:00"];
  writeFileSync(file, JSON.stringify(shop, null, 2));
}

const server: ChildProcess = spawn(process.execPath, [join(ROOT, "src/server/main.ts"), "--demo"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: join(work, "data"),
    TENANTS_DIR: tenants,
    LLM_PROVIDER: "offline",
    BACKUP_EVERY_HOURS: "0",
    LOG_REQUESTS: "0",
    GEMINI_API_KEY: "",
    STAFF_PASSWORD: "",
  },
  stdio: "ignore",
});

const frames: Buffer[] = [];
const delays: number[] = [];

/** Shows a caption pill at the bottom of the page, then captures the frame. */
async function frame(page: Page, caption: string, ms = 2600) {
  await page.run(`
    document.getElementById("tour-caption")?.remove();
    const pill = document.createElement("div");
    pill.id = "tour-caption";
    pill.textContent = ${JSON.stringify(caption)};
    Object.assign(pill.style, {
      position: "fixed", left: "50%", bottom: "22px", transform: "translateX(-50%)", zIndex: "99999",
      padding: "11px 22px", borderRadius: "999px", background: "rgba(31,29,26,0.92)", color: "#fff",
      font: "600 16px/1.3 system-ui, 'Segoe UI', sans-serif", letterSpacing: "0.01em",
      boxShadow: "0 10px 30px rgba(0,0,0,0.25)", whiteSpace: "nowrap", pointerEvents: "none",
    });
    document.body.append(pill);
  `);
  await sleep(250);
  frames.push(await page.capture());
  delays.push(ms);
  console.log(`  frame ${frames.length}: ${caption}`);
}

let browser: Browser | undefined;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* starting */
    }
    if (i > 100) throw new Error("Server didn't start");
    await sleep(100);
  }
  browser = await Browser.launch({ port: 9340 });
  const chat = await browser.newPage();
  const desk = await browser.newPage();
  await chat.setSize(WIDTH, HEIGHT);
  await desk.setSize(WIDTH, HEIGHT);
  console.log("Recording the demo tour…");

  // 1. Welcome
  await chat.goto(`${BASE}/?lang=en`);
  await chat.waitFor(`!document.getElementById("order-btn").hidden`);
  await chat.run(`document.getElementById("demo-strip").hidden = true;`);
  await frame(chat, "A café's own assistant: open hours, actions, suggested questions", 2800);

  // 2. A question answered from the café's documents
  await chat.run(`document.getElementById("input").value = "Do you have oat milk?"; document.getElementById("composer").requestSubmit();`);
  await chat.waitFor(`(() => { const m = [...document.querySelectorAll(".msg.bot")].at(-1); return m && !document.getElementById("send").disabled && m.querySelector(".cite"); })()`);
  await frame(chat, "Answers come from the café's own documents, with sources", 2800);

  // 3. Order ahead
  await chat.run(`
    document.getElementById("order-btn").click();
    await new Promise((r) => setTimeout(r, 700));
    const card = document.querySelector(".order-card");
    const add = (name) => [...card.querySelectorAll(".order-row")].find((r) => r.querySelector(".order-name").textContent === name).querySelector(".add-btn").click();
    add("Flat White");
    await new Promise((r) => setTimeout(r, 150));
    [...card.querySelectorAll(".opt-row button")].find((b) => b.textContent.startsWith("Oat")).click();
    card.querySelector(".opt-picker .primary").click();
    await new Promise((r) => setTimeout(r, 150));
    const inputs = card.querySelectorAll("input");
    inputs[0].value = "Alex"; inputs[1].value = "555 010 7777";
    card.scrollIntoView({ block: "start" });
  `);
  await frame(chat, "Order ahead: the real menu, drink options and a live total");

  // 4. Placed: live tracking card
  await chat.run(`document.querySelector(".order-card button[type=submit]").click();`);
  const ref = await chat.waitFor<string>(`document.querySelector(".tracking-card .ref")?.textContent`);
  await chat.run(`document.querySelector(".tracking-card").scrollIntoView({ block: "center" });`);
  await frame(chat, "The customer gets a live tracking card…", 2200);

  // 5. Desk: the order arrives on the kitchen screen
  await desk.goto(`${BASE}/desk`);
  await desk.waitFor(`document.querySelector("#demo-box button")`);
  await desk.run(`[...document.querySelectorAll("#demo-box button")].find((b) => b.textContent.includes("Manager")).click();`);
  await desk.waitFor(`!document.getElementById("desk-view").hidden`);
  await desk.run(`document.getElementById("demo-banner").hidden = true; document.querySelector('[data-tab="orders"]').click();`);
  await desk.waitFor(`[...document.querySelectorAll(".order-num")].some((n) => n.textContent === ${JSON.stringify(ref)})`);
  await frame(desk, "…and staff see the order on the kitchen screen instantly");

  // 6. Staff mark it ready; the customer's card updates
  const tap = (label: string) =>
    desk.run(`
      const card = [...document.querySelectorAll(".order")].find((c) => c.querySelector(".order-num").textContent === ${JSON.stringify(ref)});
      [...card.querySelectorAll(".btn-go")].find((b) => b.textContent === ${JSON.stringify(label)}).click();
    `);
  await tap("Start");
  await sleep(500);
  await tap("Ready");
  await chat.waitFor(`/ready/i.test(document.querySelector(".tracking-card strong")?.textContent ?? "")`);
  await chat.run(`document.querySelector(".tracking-card").scrollIntoView({ block: "center" });`);
  await frame(chat, "Staff tap Ready: the customer's phone chimes", 2400);

  // 7. Pickup screen
  const pickup = await browser.newPage();
  await pickup.setSize(WIDTH, HEIGHT);
  await pickup.goto(`${BASE}/display`);
  await pickup.waitFor(`document.getElementById("ready").innerText.includes(${JSON.stringify(ref.replace("#", ""))})`);
  await frame(pickup, "The pickup screen at the counter calls the number", 2400);
  pickup.close();

  // 8. Till with a payment sheet
  await desk.run(`
    document.querySelector('[data-tab="till"]').click();
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll(".tile")].find((t) => t.textContent.startsWith("Mocha")).click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById("opt-submit").click();
    await new Promise((r) => setTimeout(r, 200));
    [...document.querySelectorAll(".tile")].find((t) => t.textContent.startsWith("Espresso")).click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById("opt-submit").click();
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById("charge-order").click();
    await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll("#pay-quick button")].find((b) => b.textContent === "$10.00").click();
  `);
  await frame(desk, "A full till: drink options, cash with change, card, loyalty");
  await desk.run(`document.getElementById("pay-cancel").click();`);

  // 9. The owner's report: what the assistant couldn't answer
  await desk.run(`document.querySelector('[data-tab="report"]').click();`);
  await desk.waitFor(`document.querySelector("#questions-list .q-row")`);
  await desk.run(`document.getElementById("questions-block").scrollIntoView({ block: "start" }); document.querySelector(".panel:not([hidden])").scrollBy(0, -12);`);
  await frame(desk, "Owners see what customers asked that the assistant couldn't answer…", 2800);

  // 10. Teach it
  await desk.run(`
    [...document.querySelector("#questions-list .q-row").querySelectorAll("button")].find((b) => b.textContent === "Answer it").click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById("answer-text").value = "Yes, there's a baby changing table in the accessible restroom at the back.";
    document.getElementById("answer-text").dispatchEvent(new Event("input"));
  `);
  await frame(desk, "…and teach it in seconds: the next customer gets the answer", 2800);
  await desk.run(`document.getElementById("answer-cancel").click();`);

  // 11. Kopi Kita in Chinese
  await chat.goto(`${BASE}/?tenant=kopi-kita&lang=zh`);
  await chat.waitFor(`!document.getElementById("order-btn").hidden`);
  await chat.run(`document.getElementById("demo-strip").hidden = true;`);
  await frame(chat, "Multi-café and multilingual: Kopi Kita in Malaysia, in 中文", 3200);

  writeFileSync(OUT, buildApng(frames, delays));
  chat.close();
  desk.close();
  console.log(`Saved docs/demo.png (${frames.length} frames, ${(readFileSync(OUT).length / 1024 / 1024).toFixed(1)} MB)`);
} finally {
  browser?.close();
  server.kill();
  await sleep(300);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* temp folder */
  }
}
// Open browser connections would otherwise keep Node running.
process.exit(process.exitCode ?? 0);
