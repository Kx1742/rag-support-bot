// Chat UI. Plain JavaScript, no framework. All server text is inserted with
// textContent / DOM nodes (never innerHTML), so answers can't inject HTML.

const $ = (id) => document.getElementById(id);
const els = {
  messages: $("messages"),
  welcome: $("welcome"),
  suggestions: $("suggestions"),
  form: $("composer"),
  input: $("input"),
  send: $("send"),
  newChat: $("new-chat"),
};

let tenantId = "";
let tenantInfo = null;
let history = [];
let busy = false;
/** Formats cents in the café's currency (replaced once the café's settings load). */
let money = moneyFormatter({ currency: "USD", locale: "en-US" });

function moneyFormatter({ currency, locale }) {
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
  return (cents) => fmt.format(cents / 100);
}

// Language switcher (translations live in i18n.js).
const langSelect = $("lang-select");
langSelect.append(...Object.entries(LANGUAGES).map(([code, label]) => el("option", { value: code, selected: code === lang }, label)));
langSelect.addEventListener("change", () => setLanguage(langSelect.value));

init().catch((err) => showError(t("loadFailed", { error: err.message })));

async function init() {
  const config = await getJson("/api/config");
  tenantId = new URLSearchParams(location.search).get("tenant") || config.defaultTenant;
  if (config.demo) {
    // Point demo visitors at the parts they can't find from the chat alone.
    const strip = $("demo-strip");
    strip.hidden = false;
    strip.append(
      t("demoStrip"),
      el("a", { href: `/desk?tenant=${encodeURIComponent(tenantId)}` }, t("openDesk")),
      t("demoLogins"),
      el("a", { href: `/display?tenant=${encodeURIComponent(tenantId)}`, target: "_blank", rel: "noopener" }, t("pickupScreen")),
    );
    for (const cafe of (config.demo.cafes ?? []).filter((c) => c.id !== tenantId)) {
      strip.append(" · ", el("a", { href: `/?tenant=${encodeURIComponent(cafe.id)}` }, t("tryCafe", { name: cafe.name })));
    }
  }
  const tenant = await getJson(`/api/tenants/${encodeURIComponent(tenantId)}`);

  document.title = `${tenant.name} · Support`;
  $("business-name").textContent = tenant.name;
  $("avatar").textContent = tenant.name.trim().charAt(0).toUpperCase();
  $("assistant-line").textContent = t("assistantLine", { name: tenant.assistantName });
  $("welcome-title").textContent = t("welcome", { name: tenant.assistantName });
  $("fictional-badge").hidden = !tenant.fictional;
  $("mode-badge").hidden = config.mode !== "offline";
  if (tenant.brandColor) document.documentElement.style.setProperty("--brand", tenant.brandColor);
  tenantInfo = tenant;
  if (tenant.money) money = moneyFormatter(tenant.money);
  // Quick actions: only the ones this business offers.
  const actions = [
    ["order-btn", tenant.orderAhead, openOrderCard],
    ["book-btn", tenant.booking, openBookingCard],
    ["manage-btn", tenant.booking, openManageCard],
    ["points-btn", tenant.loyalty, openPointsCard],
  ];
  for (const [id, enabled, open] of actions) {
    $(id).hidden = !enabled;
    if (enabled) $(id).addEventListener("click", open);
  }
  $("quick-actions").hidden = !actions.some(([, enabled]) => enabled);
  if (tenant.orderAhead) restoreTrackedOrders();
  if (tenant.loyalty) $("points-label").textContent = t("myPoints", { program: tenant.loyalty.name });

  for (const question of tenant.suggestedQuestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = question;
    button.addEventListener("click", () => sendMessage(question));
    els.suggestions.append(button);
  }
  els.input.focus();
}

// ---------- Sending ----------

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(els.input.value);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});

els.input.addEventListener("input", autoGrow);

els.newChat.addEventListener("click", () => {
  if (busy) return;
  history = [];
  els.messages.replaceChildren(els.welcome);
  els.welcome.hidden = false;
  els.input.focus();
});

async function sendMessage(raw) {
  const message = raw.trim();
  if (!message || busy || !tenantId) return;

  setBusy(true);
  els.welcome.hidden = true;
  els.input.value = "";
  autoGrow();
  addUserBubble(message);
  const bot = addBotBubble();

  let answer = "";
  let sources = [];
  let failed = false;

  try {
    const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || t("requestFailed", { status: res.status }));
    }

    for await (const { event, data } of readSse(res.body)) {
      if (event === "action") showAction(data);
      else if (event === "sources") sources = data.sources;
      else if (event === "delta") {
        answer += data.text;
        renderAnswer(bot.body, answer, sources);
      } else if (event === "error") throw new Error(data.error);
      scrollToBottom();
    }
    if (!answer) throw new Error(t("noAnswer"));
    renderSources(bot, citedSources(answer, sources));
    history.push({ role: "user", text: message }, { role: "assistant", text: answer });
    history = history.slice(-10);
  } catch (err) {
    failed = true;
    bot.root.classList.add("error");
    bot.body.textContent = err.message || t("somethingWrong");
  } finally {
    setBusy(false);
    scrollToBottom();
    if (failed) els.input.value = message; // let them retry easily
    els.input.focus();
  }
}

/** Parses Server-Sent Events from a fetch() response body. */
async function* readSse(body) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: JSON.parse(data.join("\n")) };
    }
  }
}

// ---------- Rendering ----------

function addUserBubble(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  els.messages.append(div);
  scrollToBottom();
}

function addBotBubble() {
  const root = document.createElement("div");
  root.className = "msg bot";
  const body = document.createElement("div");
  const typing = document.createElement("div");
  typing.className = "typing";
  typing.setAttribute("aria-label", t("typing"));
  typing.append(...[0, 1, 2].map(() => document.createElement("span")));
  body.append(typing);
  root.append(body);
  els.messages.append(root);
  scrollToBottom();
  return { root, body };
}

/**
 * Tiny, safe formatter: paragraphs, "- " bullet lists, **bold**, and [n] citations.
 */
function renderAnswer(container, text, sources) {
  const nodes = [];
  let list = null;

  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        nodes.push(list);
      }
      const li = document.createElement("li");
      appendInline(li, bullet[1], sources, container);
      list.append(li);
    } else if (line.trim()) {
      list = null;
      const p = document.createElement("p");
      appendInline(p, line, sources, container);
      nodes.push(p);
    } else {
      list = null;
    }
  }
  container.replaceChildren(...nodes);
}

function appendInline(parent, text, sources, container) {
  // Split into **bold**, [1] / [1, 2] citations, and plain text.
  for (const part of text.split(/(\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/g)) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      const b = document.createElement("strong");
      b.textContent = part.slice(2, -2);
      parent.append(b);
    } else if (/^\[\d+(?:\s*,\s*\d+)*\]$/.test(part)) {
      for (const n of part.slice(1, -1).split(",").map((s) => Number(s.trim()))) {
        const source = sources.find((s) => s.n === n);
        if (!source) continue; // drop citations that don't match a real source
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "cite";
        btn.textContent = String(n);
        btn.title = `${source.heading || source.docId}`;
        btn.addEventListener("click", () => flashSource(container.closest(".msg"), n));
        parent.append(btn);
      }
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}

/** Only the sources the answer actually cites, e.g. [1] or [1, 3]. */
function citedSources(answer, sources) {
  const cited = new Set();
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of match[1].split(",")) cited.add(Number(n.trim()));
  }
  return sources.filter((s) => cited.has(s.n));
}

function renderSources(bot, sources) {
  if (!sources.length) return;
  const details = document.createElement("details");
  details.className = "sources";
  const summary = document.createElement("summary");
  summary.textContent = t("sources", { n: sources.length });
  const ol = document.createElement("ol");

  for (const s of sources) {
    const li = document.createElement("li");
    li.className = "source";
    li.dataset.n = String(s.n);
    const title = document.createElement("div");
    title.className = "source-title";
    title.textContent = `[${s.n}] ${s.heading || s.docId}`;
    const file = document.createElement("div");
    file.className = "source-file";
    file.textContent = s.docId;
    const excerpt = document.createElement("p");
    excerpt.className = "source-excerpt";
    excerpt.textContent = s.excerpt;
    li.append(title, file, excerpt);
    ol.append(li);
  }
  details.append(summary, ol);
  bot.root.append(details);
}

function flashSource(msg, n) {
  const details = msg?.querySelector(".sources");
  const item = details?.querySelector(`.source[data-n="${n}"]`);
  if (!details || !item) return;
  details.open = true;
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  item.classList.add("flash");
  setTimeout(() => item.classList.remove("flash"), 1200);
}

// ---------- Bookings ----------

/** Small DOM builder: el("div", { class: "x" }, "text", child) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

/** Shows a card for things the assistant did through its tools. */
function showAction(action) {
  if (action.name === "booking_created") addBookingConfirmation(action.data);
  if (action.name === "booking_cancelled") {
    const b = action.data;
    addCard(el("div", { class: "booking-card cancelled" }, el("strong", {}, t("bookingCancelled")), el("div", {}, t("refAt", { ref: b.reference, date: b.dateText, time: b.time }))));
  }
}

function addCard(node) {
  els.welcome.hidden = true;
  els.messages.append(node);
  scrollToBottom();
}

function addBookingConfirmation(b) {
  addCard(
    el(
      "div",
      { class: "booking-card confirmed" },
      el("strong", {}, t("tableBooked")),
      el("div", { class: "ref" }, b.reference),
      el("div", {}, t("dateAt", { date: b.dateText, time: b.time })),
      el("div", {}, `${peopleLabel(b.partySize)} · ${b.name}`),
      el(
        "div",
        { class: "hint" },
        tenantInfo?.chatBookings
          ? t("keepRefChat")
          : t("keepRefCall"),
      ),
    ),
  );
}

function openBookingCard() {
  const info = tenantInfo.booking;
  const maxDate = shiftDate(info.today, info.maxDaysAhead);
  let chosenTime = null;

  const date = el("input", { type: "date", min: info.today, max: maxDate, value: info.today, required: true });
  const party = el(
    "select",
    {},
    ...Array.from({ length: info.maxPartySize }, (_, i) => el("option", { value: String(i + 1), selected: i === 1 }, peopleLabel(i + 1))),
  );
  const times = el("div", { class: "times" });
  const name = el("input", { maxlength: "80", autocomplete: "name", required: true });
  const phone = el("input", { type: "tel", autocomplete: "tel", required: true });
  const notes = el("input", { maxlength: "300", placeholder: t("notesPlaceholder") });
  const error = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { type: "submit", class: "primary", disabled: true }, t("bookBtn"));
  const close = el("button", { type: "button", class: "ghost" }, t("close"));

  const form = el(
    "form",
    { class: "booking-card form" },
    el("strong", {}, t("bookTable")),
    el("div", { class: "row" }, el("label", {}, t("date"), date), el("label", {}, t("people"), party)),
    el("div", { class: "label" }, t("time")),
    times,
    el("div", { class: "row" }, el("label", {}, t("name"), name), el("label", {}, t("phone"), phone)),
    el("label", {}, t("notes"), notes),
    error,
    el("div", { class: "actions" }, close, submit),
  );

  async function loadTimes() {
    chosenTime = null;
    submit.disabled = true;
    times.replaceChildren(el("span", { class: "hint" }, t("checking")));
    try {
      const data = await getJson(`/api/tenants/${encodeURIComponent(tenantId)}/availability?date=${date.value}&partySize=${party.value}`);
      times.replaceChildren(
        ...(data.times.length
          ? data.times.map((t) =>
              el(
                "button",
                {
                  type: "button",
                  "aria-pressed": "false",
                  onclick: (e) => {
                    chosenTime = t;
                    for (const b of times.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === e.currentTarget));
                    submit.disabled = false;
                  },
                },
                t,
              ),
            )
          : [el("span", { class: "hint" }, data.reason || t("noTimes"))]),
      );
    } catch (err) {
      times.replaceChildren(el("span", { class: "hint" }, err.message));
    }
  }

  date.addEventListener("change", loadTimes);
  party.addEventListener("change", loadTimes);
  close.addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: date.value,
          time: chosenTime,
          partySize: Number(party.value),
          name: name.value,
          phone: phone.value,
          notes: notes.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t("bookingFailed", { status: res.status }));
      form.remove();
      addBookingConfirmation(data.booking);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      if (/booked|available/i.test(err.message)) loadTimes();
    }
  });

  addCard(form);
  loadTimes();
}

/** Customers look up (and cancel) their own booking with its reference + phone number. */
function openManageCard() {
  const reference = el("input", { maxlength: "12", autocomplete: "off", placeholder: "e.g. BB-7K3QX", required: true });
  const phone = el("input", { type: "tel", autocomplete: "tel", required: true });
  const error = el("p", { class: "form-error", role: "alert" });
  const result = el("div", { class: "booking-result" });
  const find = el("button", { type: "submit", class: "primary" }, t("findBooking"));
  const close = el("button", { type: "button", class: "ghost" }, t("close"));

  const form = el(
    "form",
    { class: "booking-card form" },
    el("strong", {}, t("yourBooking")),
    el("div", { class: "hint" }, t("lookupHint")),
    el("div", { class: "row" }, el("label", {}, t("reference"), reference), el("label", {}, t("phone"), phone)),
    error,
    result,
    el("div", { class: "actions" }, close, find),
  );

  const call = async (action) => {
    const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/bookings/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference: reference.value.trim(), phone: phone.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("requestFailed", { status: res.status }));
    return data.booking;
  };

  const show = (b) => {
    const cancel = el("button", { type: "button", class: "ghost danger" }, t("cancelBooking"));
    let armed = false;
    cancel.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        cancel.textContent = t("tapAgainCancel");
        setTimeout(() => {
          armed = false;
          cancel.textContent = t("cancelBooking");
        }, 3000);
        return;
      }
      cancel.disabled = true;
      try {
        show(await call("cancel"));
      } catch (err) {
        error.textContent = err.message;
        cancel.disabled = false;
      }
    });
    result.replaceChildren(
      el(
        "div",
        { class: `booking-summary ${b.status}` },
        el("div", { class: "ref" }, b.reference),
        el("div", {}, t("dateAt", { date: b.dateText, time: b.time })),
        el("div", {}, `${peopleLabel(b.partySize)} · ${b.name}`),
        el("div", { class: "status" }, t(`status_${b.status}`)),
        b.status === "confirmed" ? cancel : null,
      ),
    );
  };

  close.addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    find.disabled = true;
    try {
      show(await call("lookup"));
    } catch (err) {
      result.replaceChildren();
      error.textContent = err.message;
    } finally {
      find.disabled = false;
    }
  });

  addCard(form);
  reference.focus();
}

// ---------- Order ahead ----------

/** Order-ahead card: pick items (with options), a pickup time, name and phone. Pay at pickup. */
async function openOrderCard() {
  let data;
  try {
    data = await getJson(`/api/tenants/${encodeURIComponent(tenantId)}/menu`);
  } catch (err) {
    addCard(el("div", { class: "booking-card" }, el("strong", {}, t("orderAhead")), el("div", { class: "hint" }, err.message)));
    return;
  }
  if (!data.ordering.open) {
    addCard(el("div", { class: "booking-card" }, el("strong", {}, t("orderAhead")), el("div", { class: "hint" }, data.ordering.reason)));
    return;
  }

  const groups = new Map(data.optionGroups.map((g) => [g.id, g]));
  const categories = [...new Set(data.menu.map((m) => m.category))];
  const cart = []; // { key, item, options, qty, label, unit }
  let category = categories[0];
  let picking = null; // item whose options are open

  const priceOf = (item, options) =>
    item.price +
    item.options.reduce((sum, gid) => {
      const g = groups.get(gid);
      const ids = g.type === "single" ? [options[gid] ?? g.choices.find((c) => c.default).id] : (options[gid] ?? []);
      return sum + ids.reduce((n, id) => n + (g.choices.find((c) => c.id === id)?.price ?? 0), 0);
    }, 0);
  const labelOf = (item, options) =>
    item.options
      .flatMap((gid) => {
        const g = groups.get(gid);
        const ids = g.type === "single" ? [options[gid]].filter(Boolean) : (options[gid] ?? []);
        return ids.map((id) => g.choices.find((c) => c.id === id)).filter((c) => c && !c.default).map((c) => c.name);
      })
      .join(" · ");

  const tabs = el("div", { class: "order-tabs" });
  const list = el("div", { class: "order-items-list" });
  const cartBox = el("div", { class: "order-cart" });
  const pickup = el(
    "select",
    { "aria-label": t("pickupTime") },
    el("option", { value: "asap" }, t("asap")),
    ...data.ordering.slots.map((t) => el("option", { value: t }, t)),
  );
  const name = el("input", { maxlength: "60", autocomplete: "name", required: true });
  const phone = el("input", { type: "tel", autocomplete: "tel", required: true });
  const notes = el("input", { maxlength: "300", placeholder: t("optional") });
  const error = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { type: "submit", class: "primary", disabled: true }, t("placeOrder"));
  const close = el("button", { type: "button", class: "ghost" }, t("close"));
  const clientRef = crypto.randomUUID();

  const form = el(
    "form",
    { class: "booking-card form order-card" },
    el("strong", {}, t("orderAhead")),
    el("div", { class: "hint" }, payHint()),
    tabs,
    list,
    cartBox,
    el("div", { class: "row" }, el("label", {}, t("pickup"), pickup), el("label", {}, t("name"), name)),
    el("div", { class: "row" }, el("label", {}, t("phone"), phone), el("label", {}, t("notes"), notes)),
    error,
    el("div", { class: "actions" }, close, submit),
  );

  function renderTabs() {
    tabs.replaceChildren(
      ...categories.map((c) =>
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(c === category),
            onclick: () => {
              category = c;
              picking = null;
              renderTabs();
              renderList();
            },
          },
          c,
        ),
      ),
    );
  }

  function renderList() {
    list.replaceChildren(
      ...data.menu
        .filter((m) => m.category === category)
        .flatMap((item) => {
          const row = el(
            "div",
            { class: "order-row" },
            el("div", {}, el("div", { class: "order-name" }, item.name), el("div", { class: "hint" }, item.options.length ? t("fromPrice", { price: money(item.price) }) : money(item.price), item.lowStock ? t("onlyLeft", { n: item.lowStock }) : "")),
            el(
              "button",
              {
                type: "button",
                class: "add-btn",
                "aria-label": t("addItem", { name: item.name }),
                onclick: () => {
                  if (item.options.length) {
                    picking = picking?.id === item.id ? null : { id: item.id, options: {} };
                    renderList();
                  } else addToCart(item, {});
                },
              },
              "+",
            ),
          );
          return picking?.id === item.id ? [row, optionPicker(item)] : [row];
        }),
    );
  }

  function optionPicker(item) {
    const opts = picking.options;
    const box = el("div", { class: "opt-picker" });
    const draw = () => {
      box.replaceChildren(
        ...item.options.map((gid) => {
          const g = groups.get(gid);
          return el(
            "div",
            { class: "opt-row" },
            el("span", { class: "hint" }, g.name),
            ...g.choices.map((c) => {
              const on = g.type === "single" ? (opts[gid] ?? g.choices.find((x) => x.default).id) === c.id : (opts[gid] ?? []).includes(c.id);
              return el(
                "button",
                {
                  type: "button",
                  "aria-pressed": String(on),
                  onclick: () => {
                    if (g.type === "single") opts[gid] = c.default ? undefined : c.id;
                    else opts[gid] = on ? opts[gid].filter((x) => x !== c.id) : [...(opts[gid] ?? []), c.id];
                    if (g.type === "multi" && !opts[gid].length) delete opts[gid];
                    if (opts[gid] === undefined) delete opts[gid];
                    draw();
                  },
                },
                c.price ? `${c.name} +${money(c.price)}` : c.name,
              );
            }),
          );
        }),
        el("button", { type: "button", class: "primary", onclick: () => addToCart(item, { ...opts }) }, t("addTotal", { total: money(priceOf(item, opts)) })),
      );
    };
    draw();
    return box;
  }

  function addToCart(item, options) {
    const key = JSON.stringify([item.id, Object.entries(options).sort()]);
    const line = cart.find((l) => l.key === key);
    if (line) line.qty = Math.min(line.qty + 1, 20);
    else cart.push({ key, item, options, qty: 1, label: labelOf(item, options), unit: priceOf(item, options) });
    picking = null;
    renderList();
    renderCart();
  }

  function renderCart() {
    const subtotal = cart.reduce((n, l) => n + l.unit * l.qty, 0);
    // Same rule as the server: each charge is a percentage of the amount so far.
    let total = subtotal;
    const charges = (data.charges ?? []).map((c) => {
      const amount = Math.round((total * c.percent) / 100);
      total += amount;
      return { name: c.name, amount };
    });
    cartBox.replaceChildren(
      ...(cart.length
        ? cart.map((l) =>
            el(
              "div",
              { class: "cart-line" },
              el("div", {}, el("div", {}, `${l.qty}× ${l.item.name}`), l.label ? el("div", { class: "hint" }, l.label) : null),
              el("span", {}, money(l.unit * l.qty)),
              el(
                "button",
                {
                  type: "button",
                  class: "ghost small-btn",
                  "aria-label": t("removeOne", { name: l.item.name }),
                  onclick: () => {
                    l.qty -= 1;
                    if (!l.qty) cart.splice(cart.indexOf(l), 1);
                    renderCart();
                  },
                },
                "−",
              ),
            ),
          )
        : [el("div", { class: "hint" }, t("cartEmpty"))]),
      ...(cart.length ? charges.map((c) => el("div", { class: "cart-line cart-charge" }, el("div", { class: "hint" }, c.name), el("span", { class: "hint" }, money(c.amount)))) : []),
    );
    submit.disabled = cart.length === 0;
    submit.textContent = cart.length ? t("placeOrderTotal", { total: money(total) }) : t("placeOrder");
  }

  close.addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRef,
          name: name.value,
          phone: phone.value,
          pickupTime: pickup.value,
          notes: notes.value,
          items: cart.map((l) => ({ itemId: l.item.id, quantity: l.qty, options: l.options })),
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || t("orderFailed", { status: res.status }));
      form.remove();
      unlockSound(); // the customer just tapped, so the "ready" chime is allowed later
      rememberOrder(out.order.trackingToken);
      trackOrder(out.order);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = cart.length === 0;
    }
  });

  renderTabs();
  renderList();
  renderCart();
  addCard(form);
}

// ---------- Loyalty balance ----------

function openPointsCard() {
  const program = tenantInfo.loyalty?.name ?? t("points");
  const phone = el("input", { type: "tel", autocomplete: "tel", required: true, placeholder: t("joinedNumber") });
  const error = el("p", { class: "form-error", role: "alert" });
  const result = el("div");
  const find = el("button", { type: "submit", class: "primary" }, t("check"));
  const close = el("button", { type: "button", class: "ghost" }, t("close"));
  const form = el(
    "form",
    { class: "booking-card form" },
    el("strong", {}, t("myPoints", { program })),
    el("label", {}, t("phone"), phone),
    error,
    result,
    el("div", { class: "actions" }, close, find),
  );
  close.addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    find.disabled = true;
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/loyalty`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.value }),
      });
      const s = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(s.error || t("requestFailed", { status: res.status }));
      result.replaceChildren(
        el(
          "div",
          { class: "booking-summary" },
          el("div", { class: "ref" }, t("pointsCount", { n: s.points })),
          s.nextReward ? el("div", {}, t("moreFor", { n: s.nextReward.pointsNeeded, reward: s.nextReward.name })) : el("div", {}, t("anyReward")),
          ...s.rewards.map((r) => el("div", { class: r.affordable ? "status" : "hint" }, `${r.affordable ? "✓" : "·"} ${r.name} (${t("pts", { n: r.points })})`)),
          el("div", { class: "hint" }, t("showPhone")),
        ),
      );
    } catch (err) {
      result.replaceChildren();
      error.textContent = err.message;
    } finally {
      find.disabled = false;
    }
  });
  addCard(form);
  phone.focus();
}

// ---------- Live order tracking ----------

const ORDER_STEPS = [
  { status: "new", label: t("received") },
  { status: "preparing", label: t("beingMade") },
  { status: "ready", label: t("readyToCollect") },
];

/**
 * A card that follows an online order live: Received → Being made → Ready to collect.
 * Uses the order's private tracking token, so only the person who ordered can follow it.
 */
function trackOrder(order) {
  const number = `#${String(order.number).padStart(3, "0")}`;
  const steps = el("ol", { class: "order-steps" });
  const headline = el("strong", {}, t("orderPlaced"));
  const status = el("div", { class: "order-status-text" });
  const pickupLine = el("div", {}, order.pickupTime === "asap" ? t("pickupAsap", { total: money(order.total) }) : t("pickupAt", { time: order.pickupTime, total: money(order.total) }));
  const card = el(
    "div",
    { class: "booking-card confirmed tracking-card", "aria-live": "polite" },
    headline,
    el("div", { class: "ref" }, number),
    steps,
    status,
    pickupLine,
    ...order.items.map((i) => el("div", { class: "hint" }, `${i.quantity}× ${i.name}${i.optionsLabel ? ` · ${i.optionsLabel}` : ""}`)),
    order.memberPoints ? el("div", { class: "hint" }, t("earnWhenPay", { program: tenantInfo.loyalty?.name ?? t("points") })) : null,
  );

  let last = null;
  const show = (s) => {
    if (s === last) return;
    const firstUpdate = last === null;
    last = s;
    const index = ORDER_STEPS.findIndex((x) => x.status === s);
    steps.replaceChildren(
      ...ORDER_STEPS.map((step, i) =>
        el("li", { class: s === "completed" || i < index ? "done" : i === index ? "current" : "" }, step.label),
      ),
    );
    card.classList.toggle("is-ready", s === "ready");
    card.classList.toggle("is-cancelled", s === "cancelled");
    if (s === "new") status.textContent = t("statusNew");
    if (s === "preparing") status.textContent = t("statusPreparing");
    if (s === "ready") {
      headline.textContent = t("orderReady");
      status.textContent = t("collectAt", { number });
      if (!firstUpdate) {
        chime();
        flashTitle(t("readyTitle", { number }));
      }
    }
    if (s === "completed") {
      headline.textContent = t("collected");
      status.textContent = "";
      pickupLine.hidden = true; // the receipt below has the payment details
      offerReceipt(card, order.trackingToken).finally(() => forgetOrder(order.trackingToken));
    }
    if (s === "cancelled") {
      headline.textContent = t("orderCancelled");
      status.textContent = t("orderCancelledText");
      forgetOrder(order.trackingToken);
    }
  };
  show(order.status ?? "new");
  addCard(card);

  if (!order.trackingToken || ["completed", "cancelled"].includes(order.status)) return;
  const url = `/api/tenants/${encodeURIComponent(tenantId)}/orders/track/events?token=${encodeURIComponent(order.trackingToken)}`;
  const source = new EventSource(url);
  source.addEventListener("status", (e) => {
    const s = JSON.parse(e.data).status;
    show(s);
    if (s === "completed" || s === "cancelled") source.close();
  });
}

/** Adds a "View receipt" button once the order has been paid. */
async function offerReceipt(card, token) {
  if (!token || card.querySelector(".receipt-btn")) return;
  try {
    const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/orders/track?token=${encodeURIComponent(token)}`);
    const { receipt } = await res.json();
    if (!receipt) return;
    const box = el("div", { class: "receipt", hidden: true }, ...receiptNodes(receipt));
    const btn = el("button", { type: "button", class: "ghost receipt-btn" }, t("viewReceipt"));
    btn.addEventListener("click", () => {
      box.hidden = !box.hidden;
      btn.textContent = box.hidden ? t("viewReceipt") : t("hideReceipt");
    });
    card.append(btn, box);
  } catch {
    /* receipt is a nice-to-have */
  }
}

/** Receipt layout (same as the till's printed receipt). */
function receiptNodes(r) {
  const fmt = new Intl.NumberFormat(r.locale, { style: "currency", currency: r.currency });
  const m = (cents) => fmt.format(cents / 100);
  const row = (label, value, cls = "") => el("div", { class: `r-row ${cls}` }, el("span", {}, label), el("span", {}, value));
  const num = String(r.number).padStart(3, "0");
  const p = r.payment;
  return [
    el("div", { class: "r-head" }, el("strong", {}, r.business.name), r.business.address ? el("div", {}, r.business.address) : null, r.business.phone ? el("div", {}, r.business.phone) : null),
    el("div", { class: "r-meta" }, el("div", {}, t("orderTakeaway", { n: num })), el("div", {}, `${r.date} ${r.time}`)),
    el(
      "div",
      { class: "r-lines" },
      ...r.lines.map((l) => el("div", {}, row(`${l.quantity}× ${l.name}`, m(l.lineTotal)), l.optionsLabel ? el("div", { class: "r-sub" }, l.optionsLabel) : null)),
    ),
    row(t("subtotal"), m(r.subtotal)),
    r.discount ? row(r.reward ?? t("reward"), `−${m(r.discount)}`) : null,
    ...(r.charges ?? []).map((c) => row(c.name, m(c.amount))),
    row(t("total"), m(r.total), "r-total"),
    p.status === "paid" && p.rounding ? row(t("rounding"), `${p.rounding > 0 ? "+" : "−"}${m(Math.abs(p.rounding))}`) : null,
    p.status === "paid" && p.rounding ? row(t("amountPaid"), m(p.amount), "r-total") : null,
    p.status === "paid" ? row(t("paidBy", { method: methodName(p.method, p.methodName) }), m(p.tendered ?? r.total)) : row(p.status === "refunded" ? t("refunded") : t("notPaid"), ""),
    p.status === "paid" && p.method === "cash" && p.change ? row(t("change"), m(p.change)) : null,
    r.pointsEarned ? el("div", { class: "r-note" }, t("loyaltyPoints", { n: r.pointsEarned })) : null,
    r.business.footer ? el("div", { class: "r-foot" }, r.business.footer) : null,
  ].filter(Boolean);
}

/** "cash" -> "tunai" etc.; a QR method keeps the café's own name, e.g. "DuitNow QR". */
function methodName(method, fallback) {
  return method === "cash" || method === "card" ? t(`method_${method}`) : (fallback ?? method);
}

/** "Pick up at the counter and pay there by cash, card or DuitNow QR." in the visitor's language. */
function payHint() {
  const names = (tenantInfo.payments ?? ["cash", "card"]).map((m) => methodName(m, m));
  let list = names.join(", ");
  try {
    list = new Intl.ListFormat(document.documentElement.lang, { type: "disjunction" }).format(names);
  } catch {
    /* older browsers: plain commas */
  }
  return t("orderAheadPay", { methods: list });
}

/** Remembers tracked orders in this browser so a reload doesn't lose them. */
function trackedKey() {
  return `tracked-orders:${tenantId}`;
}

function rememberOrder(token) {
  if (!token) return;
  try {
    const list = JSON.parse(localStorage.getItem(trackedKey()) ?? "[]").filter((t) => t !== token);
    localStorage.setItem(trackedKey(), JSON.stringify([...list, token].slice(-5)));
  } catch {
    /* storage blocked: tracking works until the page is closed */
  }
}

function forgetOrder(token) {
  try {
    const list = JSON.parse(localStorage.getItem(trackedKey()) ?? "[]").filter((t) => t !== token);
    localStorage.setItem(trackedKey(), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** On page load: show cards for orders that are still being made or waiting. */
async function restoreTrackedOrders() {
  let tokens = [];
  try {
    tokens = JSON.parse(localStorage.getItem(trackedKey()) ?? "[]");
  } catch {
    return;
  }
  for (const token of tokens) {
    try {
      const res = await fetch(`/api/tenants/${encodeURIComponent(tenantId)}/orders/track?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        forgetOrder(token);
        continue;
      }
      const { order } = await res.json();
      if (["completed", "cancelled"].includes(order.status)) forgetOrder(token);
      else trackOrder({ ...order, trackingToken: token });
    } catch {
      /* offline: try again next visit */
    }
  }
}

let audioCtx = null;
function unlockSound() {
  try {
    audioCtx ??= new AudioContext();
    audioCtx.resume();
  } catch {
    /* no audio */
  }
}

function chime() {
  if (!audioCtx || audioCtx.state !== "running") return;
  const at0 = audioCtx.currentTime;
  [660, 880, 1100].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const at = at0 + i * 0.18;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + 0.55);
  });
}

/** Flashes the tab title until the customer looks at the page. */
function flashTitle(text) {
  const original = document.title;
  let on = false;
  const timer = setInterval(() => {
    document.title = (on = !on) ? text : original;
  }, 1000);
  const stop = () => {
    clearInterval(timer);
    document.title = original;
    document.removeEventListener("visibilitychange", onVisible);
  };
  const onVisible = () => document.visibilityState === "visible" && stop();
  document.addEventListener("visibilitychange", onVisible);
  setTimeout(stop, document.visibilityState === "visible" ? 6000 : 600000);
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Helpers ----------

function showError(text) {
  els.welcome.hidden = true;
  const div = document.createElement("div");
  div.className = "msg bot error";
  div.textContent = text;
  els.messages.append(div);
}

function setBusy(value) {
  busy = value;
  els.send.disabled = value;
  els.input.disabled = value;
  for (const b of els.suggestions.querySelectorAll("button")) b.disabled = value;
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t("requestFailed", { status: res.status }));
  return data;
}

// Installable app + offline copy of the pages (never of /api data). Optional: ignore failures.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
