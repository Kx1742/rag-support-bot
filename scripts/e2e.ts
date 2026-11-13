// End-to-end browser tests: real user journeys in a headless Chrome/Edge against a real server.
//
//   npm run e2e
//
// The runner starts its own server in demo mode on a test copy of the café that is open all day,
// in a timezone where it is currently around midday, so results don't depend on the time of day.
// Failure screenshots are saved to e2e-artifacts/.

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser, type Page, sleep } from "./lib/browser.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.E2E_PORT ?? 4123);
const BASE = `http://127.0.0.1:${PORT}`;
const TENANT = "bean-and-byte";
const ARTIFACTS = join(ROOT, "e2e-artifacts");

// ---------- test copy of the café: open all day, local time ~midday ----------

const work = mkdtempSync(join(tmpdir(), "e2e-"));
const tenants = join(work, "tenants");
cpSync(join(ROOT, "tenants", TENANT), join(tenants, TENANT), { recursive: true });
// The Malaysian demo café, as is (its till test doesn't depend on opening hours).
cpSync(join(ROOT, "tenants", "kopi-kita"), join(tenants, "kopi-kita"), { recursive: true });
const shopFile = join(tenants, TENANT, "shop.json");
const shop = JSON.parse(readFileSync(shopFile, "utf8"));
const offset = 12 - new Date().getUTCHours(); // hours to add to UTC to reach ~12:00
shop.timezone = offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`; // Etc/GMT signs are inverted
shop.closedDates = [];
for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) shop.openingHours[day] = ["06:00", "22:00"];
writeFileSync(shopFile, JSON.stringify(shop, null, 2));

// ---------- server ----------

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
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

// ---------- tiny test framework ----------

const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
const pages: Record<string, Page> = {};

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: (err as Error).message, ms: Date.now() - started });
    console.log(`  ✖ ${name}\n      ${(err as Error).message}`);
    mkdirSync(ARTIFACTS, { recursive: true });
    for (const [label, page] of Object.entries(pages)) {
      const file = join(ARTIFACTS, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}--${label}.png`);
      await page.screenshot(file).catch(() => {});
    }
    // Close the failed test's extra tabs: their live connections would slow every later test.
    for (const label of Object.keys(pages).filter((l) => l !== "chat" && l !== "desk")) {
      pages[label].close();
      delete pages[label];
    }
  }
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const js = (value: unknown) => JSON.stringify(value);

// ---------- run ----------

let browser: Browser | undefined;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {
      /* starting */
    }
    if (i > 100) throw new Error(`Server didn't start:\n${serverLog}`);
    await sleep(100);
  }
  browser = await Browser.launch();
  const chat = (pages.chat = await browser.newPage());
  const desk = (pages.desk = await browser.newPage());
  await chat.setSize(1280, 900);
  await desk.setSize(1280, 900);
  console.log(`E2E against ${BASE} (café timezone ${shop.timezone})\n`);

  let orderNumber = 0;

  await test("customer asks a question and gets an answer with a source", async () => {
    await chat.goto(`${BASE}/`);
    await chat.waitFor(`document.getElementById("business-name").textContent === "Bean & Byte Café"`, { what: "business name" });
    await chat.run(`document.getElementById("input").value = "Do you have oat milk?"; document.getElementById("composer").requestSubmit();`);
    // Answers stream in word by word: wait until the send button is back (answer finished).
    const answer = await chat.waitFor<string>(
      `(() => { const m = [...document.querySelectorAll(".msg.bot")].at(-1); return m && !document.getElementById("send").disabled && m.innerText; })()`,
      { what: "finished bot answer" },
    );
    assert(/oat/i.test(answer), `answer should mention oat milk, got: ${answer}`);
    assert(await chat.run(`return !!document.querySelector(".msg.bot .cite");`), "answer should cite a source");
  });

  await test("customer orders ahead with drink options and gets a tracking card", async () => {
    await chat.run(`document.getElementById("order-btn").click();`);
    await chat.waitFor(`document.querySelector(".order-card .order-row")`, { what: "order card menu" });
    await chat.run(`
      const card = document.querySelector(".order-card");
      const row = [...card.querySelectorAll(".order-row")].find((r) => r.querySelector(".order-name").textContent === "Flat White");
      row.querySelector(".add-btn").click();
      await new Promise((r) => setTimeout(r, 100));
      const pick = (t) => [...card.querySelectorAll(".opt-row button")].find((b) => b.textContent.startsWith(t)).click();
      pick("Large"); pick("Oat milk");
      card.querySelector(".opt-picker .primary").click();
      const inputs = card.querySelectorAll("input");
      inputs[0].value = "E2E Customer"; inputs[1].value = "555 010 9090";
    `);
    const button = await chat.run<string>(`return document.querySelector(".order-card button[type=submit]").textContent;`);
    assert(button === "Place order · $5.80", `price with options should be $5.80, got "${button}"`);
    await chat.run(`document.querySelector(".order-card button[type=submit]").click();`);
    const ref = await chat.waitFor<string>(`document.querySelector(".tracking-card .ref")?.textContent`, { what: "tracking card" });
    orderNumber = Number(ref.replace("#", ""));
    assert(orderNumber > 0, `bad order number ${ref}`);
  });

  await test("staff log in with a one-tap demo login and see the online order", async () => {
    await desk.goto(`${BASE}/desk`);
    await desk.waitFor(`document.querySelector("#demo-box button")`, { what: "demo login buttons" });
    await desk.run(`[...document.querySelectorAll("#demo-box button")].find((b) => b.textContent.includes("Manager")).click();`);
    await desk.waitFor(`!document.getElementById("desk-view").hidden`, { what: "desk after login" });
    await desk.run(`document.querySelector('[data-tab="orders"]').click();`);
    const card = await desk.waitFor<string>(
      `[...document.querySelectorAll(".order")].find((c) => c.querySelector(".order-num").textContent === ${js(`#${String(orderNumber).padStart(3, "0")}`)})?.innerText`,
      { what: "online order card" },
    );
    assert(/Online/.test(card) && /Large · Oat milk/.test(card), `card should show Online and the options: ${card}`);
  });

  await test("customer's tracking card updates live as staff make the order", async () => {
    const clickNext = (label: string) =>
      desk.run(`
        const card = [...document.querySelectorAll(".order")].find((c) => c.querySelector(".order-num").textContent === ${js(`#${String(orderNumber).padStart(3, "0")}`)});
        [...card.querySelectorAll(".btn-go")].find((b) => b.textContent === ${js(label)}).click();
      `);
    await clickNext("Start");
    await chat.waitFor(`document.querySelector(".tracking-card li.current")?.textContent === "Being made"`, { what: "Being made" });
    await desk.waitFor(`[...document.querySelectorAll("#col-preparing .order-num")].some((n) => n.textContent === ${js(`#${String(orderNumber).padStart(3, "0")}`)})`);
    await clickNext("Ready");
    await chat.waitFor(`/ready/i.test(document.querySelector(".tracking-card strong")?.textContent ?? "")`, { what: "ready headline" });
  });

  await test("pickup screen shows the ready order number", async () => {
    const pickup = (pages.pickup = await browser!.newPage());
    await pickup.goto(`${BASE}/display?tenant=${TENANT}`);
    const ready = await pickup.waitFor<string>(`document.getElementById("ready").innerText`, { what: "ready column" });
    assert(ready.includes(String(orderNumber).padStart(3, "0")), `ready column should include ${orderNumber}: ${ready}`);
    pickup.close();
    delete pages.pickup;
  });

  await test("till: ring up a mocha with options and take cash with change", async () => {
    await desk.run(`document.querySelector('[data-tab="till"]').click();`);
    await desk.run(`[...document.querySelectorAll(".tile")].find((t) => t.textContent.startsWith("Mocha")).click();`);
    await desk.waitFor(`document.getElementById("options-dialog").open`, { what: "options sheet" });
    await desk.run(`document.getElementById("opt-submit").click();`);
    await desk.waitFor(`document.getElementById("charge-order").textContent === "Charge $5.25"`, { what: "charge button total" });
    await desk.run(`document.getElementById("charge-order").click();`);
    await desk.waitFor(`document.getElementById("pay-dialog").open`);
    await desk.run(`[...document.querySelectorAll("#pay-quick button")].find((b) => b.textContent === "$10.00").click();`);
    const change = await desk.run<string>(`return document.getElementById("pay-change").innerText;`);
    assert(/\$4\.75/.test(change), `change should be $4.75, got ${change}`);
    await desk.run(`document.getElementById("pay-submit").click();`);
    const toast = await desk.waitFor<string>(`[...document.querySelectorAll(".toast")].map((t) => t.textContent).find((t) => /paid/.test(t))`, {
      what: "paid toast",
    });
    assert(/change \$4\.75/.test(toast), `toast should mention the change: ${toast}`);
  });

  await test("manager sees the questions the assistant couldn't answer", async () => {
    await desk.run(`document.querySelector('[data-tab="report"]').click();`);
    const top = await desk.waitFor<string>(`document.querySelector("#questions-list .q-row")?.innerText`, { what: "unanswered questions" });
    assert(/baby changing table/i.test(top) && /4×/.test(top), `most-asked missing topic should be first: ${top}`);
    const rate = await desk.run<string>(`return document.getElementById("questions-rate").innerText;`);
    assert(/\d+% of \d+ questions answered/.test(rate), `answer rate should show: ${rate}`);
  });

  await test("manager answers it on the desk, and the chat uses that answer right away", async () => {
    await desk.run(`
      [...document.querySelector("#questions-list .q-row").querySelectorAll("button")].find((b) => b.textContent === "Answer it").click();
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById("answer-text").value = "Yes, there's a baby changing table in the accessible restroom at the back.";
      document.getElementById("answer-submit").click();
    `);
    await desk.waitFor(`document.getElementById("answers-list").innerText.includes("accessible restroom")`, { what: "saved answer" });
    const left = await desk.run<string>(`return document.getElementById("questions-list").innerText;`);
    assert(!/baby changing/i.test(left), `the answered question should leave the list: ${left}`);

    // The assistant is rebuilt in the background; ask until it uses the new answer (a second or two).
    let reply = "";
    for (let i = 0; i < 20 && !/accessible restroom/.test(reply); i++) {
      reply = await chat.run<string>(`
        const res = await fetch("/api/tenants/${TENANT}/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "Is there a baby changing table?" }) });
        return (await res.text()).split("\\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).filter((d) => d.type === "delta").map((d) => d.text).join("");
      `);
      if (!/accessible restroom/.test(reply)) await sleep(250);
    }
    assert(/accessible restroom/.test(reply), `chat should answer with the desk's answer, got: ${reply}`);
  });

  await test("customer books a table and staff see it on the desk", async () => {
    await chat.run(`document.getElementById("book-btn").click();`);
    await chat.waitFor(`[...document.querySelectorAll(".booking-card .times button")].length > 0`, { what: "booking times" });
    await chat.run(`
      const card = [...document.querySelectorAll(".booking-card.form")].at(-1);
      card.querySelector(".times button").click();
      const inputs = card.querySelectorAll("input:not([type=date])");
      inputs[0].value = "E2E Booker"; inputs[1].value = "555 010 8080";
      card.querySelector("button[type=submit]").click();
    `);
    const ref = await chat.waitFor<string>(`[...document.querySelectorAll(".booking-card.confirmed .ref")].map((r) => r.textContent).find((t) => t.startsWith("BB-"))`, {
      what: "booking reference",
    });
    assert(/^BB-[A-Z0-9]{5}$/.test(ref), `bad reference ${ref}`);
    await desk.run(`document.querySelector('[data-tab="bookings"]').click();`);
    await desk.waitFor(`document.getElementById("booking-sections").innerText.includes("E2E Booker")`, { what: "booking on desk" });
  });

  await test("a barista can't see manager screens, and the server refuses them too", async () => {
    await desk.run(`await fetch("/api/desk/logout", { method: "POST" }); location.reload();`);
    await desk.waitFor(`document.querySelector("#demo-box button")`, { what: "login screen" });
    await desk.run(`[...document.querySelectorAll("#demo-box button")].find((b) => b.textContent.includes("Barista")).click();`);
    await desk.waitFor(`!document.getElementById("desk-view").hidden`);
    const hidden = await desk.run<boolean[]>(`return ["report", "staff"].map((t) => document.querySelector('[data-tab="' + t + '"]').hidden);`);
    assert(hidden.every(Boolean), "Report and Staff tabs should be hidden for a barista");
    const status = await desk.run<number>(`return (await fetch("/api/desk/report")).status;`);
    assert(status === 403, `report API should be 403 for a barista, got ${status}`);
  });

  await test("Malaysian café: service charge and SST on a dine-in order, paid by DuitNow QR", async () => {
    // Opening another café's desk logs out of this one first.
    await desk.goto(`${BASE}/desk?tenant=kopi-kita`);
    await desk.waitFor(`!document.getElementById("login-view").hidden && document.querySelector("#demo-box button")`, { what: "Kopi Kita login" });
    await desk.run(`[...document.querySelectorAll("#demo-box button")].find((b) => b.textContent.includes("Manager")).click();`);
    await desk.waitFor(`!document.getElementById("desk-view").hidden && document.title.includes("Kopi Kita")`, { what: "Kopi Kita desk" });
    await desk.run(`
      document.querySelector('[data-tab="till"]').click();
      document.querySelector('#order-type button[data-type="dine_in"]').click();
      document.querySelector("#table-chips button").click();
      [...document.querySelectorAll(".tile")].find((t) => t.textContent.startsWith("Milo Dinosaur")).click();
    `);
    // RM6.50 + 10% service charge (RM0.65) + 6% SST on both (RM0.43) = RM7.58
    await desk.waitFor(`/^Charge RM\\s?7\\.58$/.test(document.getElementById("charge-order").textContent)`, { what: "charge RM 7.58" });
    await desk.run(`document.getElementById("charge-order").click();`);
    await desk.waitFor(`document.getElementById("pay-dialog").open`);
    await desk.run(`document.querySelector('#pay-method button[data-method="qr"]').click();`);
    const submit = await desk.run<string>(`return document.getElementById("pay-submit").textContent;`);
    assert(/Payment received · RM\s?7\.58/.test(submit), `QR pays the exact total, got "${submit}"`);
    await desk.run(`document.getElementById("pay-submit").click();`);
    await desk.waitFor(`[...document.querySelectorAll(".toast")].some((t) => /paid/.test(t.textContent))`, { what: "paid toast" });
  });

  await test("customers can switch the chat to 中文 and the pickup screen to Malay", async () => {
    const page = (pages.lang = await browser!.newPage());
    await page.goto(`${BASE}/`);
    await page.waitFor(`document.getElementById("business-name").textContent === "Bean & Byte Café"`, { what: "chat loaded" });
    await page.run(`const s = document.getElementById("lang-select"); s.value = "zh"; s.dispatchEvent(new Event("change"));`);
    try {
      await page.waitFor(`document.documentElement.lang === "zh-Hans" && document.querySelector("#new-chat span").textContent === "新对话" && document.getElementById("business-name").textContent === "Bean & Byte Café" && !document.getElementById("order-btn").hidden`, { what: "Chinese chat" });
      await page.run(`document.getElementById("order-btn").click();`);
      const hint = await page.waitFor<string>(`document.querySelector(".order-card .hint")?.textContent`, { what: "Chinese order card" });
      assert(hint.includes("柜台"), `order card should be in Chinese: ${hint}`);
      // The choice is remembered on the next visit.
      await page.goto(`${BASE}/`);
      await page.waitFor(`document.getElementById("lang-select").value === "zh"`, { what: "remembered language" });
    } finally {
      // Other tabs share this browser's storage: never leave them in Chinese.
      await page.run(`localStorage.removeItem("lang");`).catch(() => {});
    }

    await page.goto(`${BASE}/display?tenant=${TENANT}&lang=ms`);
    const title = await page.waitFor<string>(`document.getElementById("ready-title").textContent`);
    assert(title === "Sedia untuk diambil", `pickup screen should be in Malay, got "${title}"`);
    assert(page.errors.length === 0, `uncaught errors:\n${page.errors.join("\n")}`);
    page.close();
    delete pages.lang;
  });

  await test("works on a phone without sideways scrolling", async () => {
    const phone = (pages.phone = await browser!.newPage());
    await phone.setSize(390, 844, true);
    for (const path of ["/", "/desk", `/display?tenant=${TENANT}`]) {
      await phone.goto(`${BASE}${path}`);
      const widths = await phone.run<number[]>(`return [document.documentElement.scrollWidth, window.innerWidth];`);
      assert(widths[0] <= widths[1], `${path} is wider than the phone screen (${widths[0]} > ${widths[1]})`);
    }
    phone.close();
    delete pages.phone;
  });

  await test("no JavaScript errors on any page", async () => {
    const errors = [...chat.errors, ...desk.errors];
    assert(errors.length === 0, `uncaught errors:\n${errors.join("\n")}`);
  });
} catch (err) {
  results.push({ name: "setup", ok: false, error: (err as Error).message, ms: 0 });
  console.log(`  ✖ setup\n      ${(err as Error).message}`);
} finally {
  for (const page of Object.values(pages)) page.close();
  browser?.close();
  server.kill();
  await sleep(300);
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log(`Screenshots of failures: ${ARTIFACTS}`);
  process.exitCode = 1;
}
