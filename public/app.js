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
  if (tenant.booking) {
    $("book-btn").hidden = false;
    $("book-btn").addEventListener("click", openBookingCard);
    $("manage-btn").hidden = false;
    $("manage-btn").addEventListener("click", openManageCard);
  }

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
