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

init().catch((err) => showError(`Could not load the chat: ${err.message}`));

async function init() {
  const config = await getJson("/api/config");
  tenantId = new URLSearchParams(location.search).get("tenant") || config.defaultTenant;
  if (config.demo) {
    // Point demo visitors at the parts they can't find from the chat alone.
    const strip = $("demo-strip");
    strip.hidden = false;
    strip.append(
      "Public demo · ",
      el("a", { href: `/desk?tenant=${encodeURIComponent(tenantId)}` }, "Open the staff desk"),
      " (one-tap demo logins) · ",
      el("a", { href: `/display?tenant=${encodeURIComponent(tenantId)}`, target: "_blank", rel: "noopener" }, "Pickup screen"),
    );
  }
  const tenant = await getJson(`/api/tenants/${encodeURIComponent(tenantId)}`);

  document.title = `${tenant.name} · Support`;
  $("business-name").textContent = tenant.name;
  $("avatar").textContent = tenant.name.trim().charAt(0).toUpperCase();
  $("assistant-line").textContent = `${tenant.assistantName} · AI assistant`;
  $("welcome-title").textContent = `Hi, I'm ${tenant.assistantName}! How can I help?`;
  $("fictional-badge").hidden = !tenant.fictional;
  $("mode-badge").hidden = config.mode !== "offline";
  if (tenant.brandColor) document.documentElement.style.setProperty("--brand", tenant.brandColor);
  tenantInfo = tenant;
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
  if (tenant.loyalty) $("points-btn").lastChild.textContent = ` My ${tenant.loyalty.name}`;

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
      throw new Error(data.error || `Request failed (${res.status})`);
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
    if (!answer) throw new Error("No answer received");
    renderSources(bot, citedSources(answer, sources));
    history.push({ role: "user", text: message }, { role: "assistant", text: answer });
    history = history.slice(-10);
  } catch (err) {
    failed = true;
    bot.root.classList.add("error");
    bot.body.textContent = err.message || "Something went wrong.";
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
  typing.setAttribute("aria-label", "Assistant is typing");
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
  summary.textContent = `Sources (${sources.length})`;
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
    addCard(el("div", { class: "booking-card cancelled" }, el("strong", {}, "Booking cancelled"), el("div", {}, `${b.reference} · ${b.dateText} at ${b.time}`)));
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
      el("strong", {}, "✓ Table booked"),
      el("div", { class: "ref" }, b.reference),
      el("div", {}, `${b.dateText} at ${b.time}`),
      el("div", {}, `${b.partySize} ${b.partySize === 1 ? "person" : "people"} · ${b.name}`),
      el(
        "div",
        { class: "hint" },
        tenantInfo?.chatBookings
          ? "Keep your reference. To cancel, tell me the reference and your phone number."
          : "Keep your reference. To cancel, contact the café with your reference.",
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
    ...Array.from({ length: info.maxPartySize }, (_, i) => el("option", { value: String(i + 1), selected: i === 1 }, `${i + 1} ${i ? "people" : "person"}`)),
  );
  const times = el("div", { class: "times" });
  const name = el("input", { maxlength: "80", autocomplete: "name", required: true });
  const phone = el("input", { type: "tel", autocomplete: "tel", required: true });
  const notes = el("input", { maxlength: "300", placeholder: "Optional, e.g. high chair" });
  const error = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { type: "submit", class: "primary", disabled: true }, "Book table");
  const close = el("button", { type: "button", class: "ghost" }, "Close");

  const form = el(
    "form",
    { class: "booking-card form" },
    el("strong", {}, "Book a table"),
    el("div", { class: "row" }, el("label", {}, "Date", date), el("label", {}, "People", party)),
    el("div", { class: "label" }, "Time"),
    times,
    el("div", { class: "row" }, el("label", {}, "Name", name), el("label", {}, "Phone", phone)),
    el("label", {}, "Notes", notes),
    error,
    el("div", { class: "actions" }, close, submit),
  );

  async function loadTimes() {
    chosenTime = null;
    submit.disabled = true;
    times.replaceChildren(el("span", { class: "hint" }, "Checking…"));
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
          : [el("span", { class: "hint" }, data.reason || "No free times that day.")]),
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
      if (!res.ok) throw new Error(data.error || `Booking failed (${res.status})`);
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
  const find = el("button", { type: "submit", class: "primary" }, "Find booking");
  const close = el("button", { type: "button", class: "ghost" }, "Close");

  const form = el(
    "form",
    { class: "booking-card form" },
    el("strong", {}, "Your booking"),
    el("div", { class: "hint" }, "Enter the reference from your confirmation and the phone number you booked with."),
    el("div", { class: "row" }, el("label", {}, "Reference", reference), el("label", {}, "Phone", phone)),
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
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data.booking;
  };

  const STATUS = { confirmed: "Confirmed", seated: "Seated", completed: "Finished", cancelled: "Cancelled", no_show: "Missed" };
  const show = (b) => {
    const cancel = el("button", { type: "button", class: "ghost danger" }, "Cancel this booking");
    let armed = false;
    cancel.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        cancel.textContent = "Tap again to cancel";
        setTimeout(() => {
          armed = false;
          cancel.textContent = "Cancel this booking";
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
        el("div", {}, `${b.dateText} at ${b.time}`),
        el("div", {}, `${b.partySize} ${b.partySize === 1 ? "person" : "people"} · ${b.name}`),
        el("div", { class: "status" }, STATUS[b.status] ?? b.status),
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
    addCard(el("div", { class: "booking-card" }, el("strong", {}, "Order ahead"), el("div", { class: "hint" }, err.message)));
    return;
  }
  if (!data.ordering.open) {
    addCard(el("div", { class: "booking-card" }, el("strong", {}, "Order ahead"), el("div", { class: "hint" }, data.ordering.reason)));
    return;
  }

  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
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
    { "aria-label": "Pickup time" },
    el("option", { value: "asap" }, "As soon as possible"),
    ...data.ordering.slots.map((t) => el("option", { value: t }, t)),
  );
  const name = el("input", { maxlength: "60", autocomplete: "name", required: true });
  const phone = el("input", { type: "tel", autocomplete: "tel", required: true });
  const notes = el("input", { maxlength: "300", placeholder: "Optional" });
  const error = el("p", { class: "form-error", role: "alert" });
  const submit = el("button", { type: "submit", class: "primary", disabled: true }, "Place order");
  const close = el("button", { type: "button", class: "ghost" }, "Close");
  const clientRef = crypto.randomUUID();

  const form = el(
    "form",
    { class: "booking-card form order-card" },
    el("strong", {}, "Order ahead"),
    el("div", { class: "hint" }, "Pick up at the counter and pay there by cash or card."),
    tabs,
    list,
    cartBox,
    el("div", { class: "row" }, el("label", {}, "Pickup", pickup), el("label", {}, "Name", name)),
    el("div", { class: "row" }, el("label", {}, "Phone", phone), el("label", {}, "Notes", notes)),
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
            el("div", {}, el("div", { class: "order-name" }, item.name), el("div", { class: "hint" }, item.options.length ? `from ${money(item.price)}` : money(item.price), item.lowStock ? ` · only ${item.lowStock} left` : "")),
            el(
              "button",
              {
                type: "button",
                class: "add-btn",
                "aria-label": `Add ${item.name}`,
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
        el("button", { type: "button", class: "primary", onclick: () => addToCart(item, { ...opts }) }, `Add · ${money(priceOf(item, opts))}`),
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
    const total = cart.reduce((n, l) => n + l.unit * l.qty, 0);
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
                  "aria-label": `Remove one ${l.item.name}`,
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
        : [el("div", { class: "hint" }, "Your order is empty. Tap + to add items.")]),
    );
    submit.disabled = cart.length === 0;
    submit.textContent = cart.length ? `Place order · ${money(total)}` : "Place order";
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
      if (!res.ok) throw new Error(out.error || `Order failed (${res.status})`);
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
  const program = tenantInfo.loyalty?.name ?? "Points";
  const phone = el("input", { type: "tel", autocomplete: "tel", required: true, placeholder: "The number you joined with" });
  const error = el("p", { class: "form-error", role: "alert" });
  const result = el("div");
  const find = el("button", { type: "submit", class: "primary" }, "Check");
  const close = el("button", { type: "button", class: "ghost" }, "Close");
  const form = el(
    "form",
    { class: "booking-card form" },
    el("strong", {}, `My ${program}`),
    el("label", {}, "Phone", phone),
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
      if (!res.ok) throw new Error(s.error || `Request failed (${res.status})`);
      result.replaceChildren(
        el(
          "div",
          { class: "booking-summary" },
          el("div", { class: "ref" }, `${s.points} points`),
          s.nextReward ? el("div", {}, `${s.nextReward.pointsNeeded} more for ${s.nextReward.name}`) : el("div", {}, "You can use any reward!"),
          ...s.rewards.map((r) => el("div", { class: r.affordable ? "status" : "hint" }, `${r.affordable ? "✓" : "·"} ${r.name} (${r.points} pts)`)),
          el("div", { class: "hint" }, "Show your phone number at the counter to use a reward."),
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
  { status: "new", label: "Received" },
  { status: "preparing", label: "Being made" },
  { status: "ready", label: "Ready to collect" },
];

/**
 * A card that follows an online order live: Received → Being made → Ready to collect.
 * Uses the order's private tracking token, so only the person who ordered can follow it.
 */
function trackOrder(order) {
  const number = `#${String(order.number).padStart(3, "0")}`;
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const steps = el("ol", { class: "order-steps" });
  const headline = el("strong", {}, "✓ Order placed");
  const status = el("div", { class: "order-status-text" });
  const pickupLine = el("div", {}, `Pickup ${order.pickupTime === "asap" ? "as soon as possible" : `at ${order.pickupTime}`} · ${money(order.total)} to pay at the counter`);
  const card = el(
    "div",
    { class: "booking-card confirmed tracking-card", "aria-live": "polite" },
    headline,
    el("div", { class: "ref" }, number),
    steps,
    status,
    pickupLine,
    ...order.items.map((i) => el("div", { class: "hint" }, `${i.quantity}× ${i.name}${i.optionsLabel ? ` · ${i.optionsLabel}` : ""}`)),
    order.memberPoints ? el("div", { class: "hint" }, `You'll earn ${tenantInfo.loyalty?.name ?? "points"} when you pay.`) : null,
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
    if (s === "new") status.textContent = "We've got your order. We'll start on it shortly.";
    if (s === "preparing") status.textContent = "We're making your order now.";
    if (s === "ready") {
      headline.textContent = "🔔 Your order is ready!";
      status.textContent = `Collect ${number} at the counter.`;
      if (!firstUpdate) {
        chime();
        flashTitle(`Ready: ${number}`);
      }
    }
    if (s === "completed") {
      headline.textContent = "✓ Collected. Enjoy!";
      status.textContent = "";
      pickupLine.hidden = true; // the receipt below has the payment details
      offerReceipt(card, order.trackingToken).finally(() => forgetOrder(order.trackingToken));
    }
    if (s === "cancelled") {
      headline.textContent = "Order cancelled";
      status.textContent = "This order was cancelled. Please contact the café if that's unexpected.";
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
    const btn = el("button", { type: "button", class: "ghost receipt-btn" }, "View receipt");
    btn.addEventListener("click", () => {
      box.hidden = !box.hidden;
      btn.textContent = box.hidden ? "View receipt" : "Hide receipt";
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
    el("div", { class: "r-meta" }, el("div", {}, `Order #${num} · Takeaway`), el("div", {}, `${r.date} ${r.time}`)),
    el(
      "div",
      { class: "r-lines" },
      ...r.lines.map((l) => el("div", {}, row(`${l.quantity}× ${l.name}`, m(l.lineTotal)), l.optionsLabel ? el("div", { class: "r-sub" }, l.optionsLabel) : null)),
    ),
    row("Subtotal", m(r.subtotal)),
    r.discount ? row(r.reward ?? "Reward", `−${m(r.discount)}`) : null,
    row("Total", m(r.total), "r-total"),
    p.status === "paid" ? row(`Paid by ${p.method}`, m(p.tendered ?? r.total)) : row(p.status === "refunded" ? "Refunded" : "Not paid yet", ""),
    p.status === "paid" && p.method === "cash" && p.change ? row("Change", m(p.change)) : null,
    r.pointsEarned ? el("div", { class: "r-note" }, `+${r.pointsEarned} loyalty points`) : null,
    r.business.footer ? el("div", { class: "r-foot" }, r.business.footer) : null,
  ].filter(Boolean);
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
  const t = audioCtx.currentTime;
  [660, 880, 1100].forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const at = t + i * 0.18;
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
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Installable app + offline copy of the pages (never of /api data). Optional: ignore failures.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
