// Staff desk: till, kitchen display, bookings + table map, menu.
// Built for a busy counter: big targets, glanceable states, live alerts.
// Plain JavaScript, no framework. All data is rendered as DOM nodes / text (never innerHTML).

const $ = (id) => document.getElementById(id);

/** Element builder: h("div", { class: "x", onclick: fn, style: { "--cat": "red" } }, "text", child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "style") for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const CATEGORY_COLORS = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-4)", "var(--cat-5)"];
const ORDER_WARN_MIN = 5;
const ORDER_LATE_MIN = 10;
const BOOKING_LATE_MIN = 10;
const BOOKING_SOON_MIN = 60;

const state = {
  info: null,
  tab: "till",
  now: { date: "", minutes: 0 },
  // till
  menu: [],
  category: null,
  search: "",
  ticket: new Map(), // itemId -> quantity
  orderType: "takeaway",
  orderTable: null,
  lastSentAt: 0,
  // orders
  orders: [],
  summary: null,
  seenOrderIds: null,
  // bookings
  bookingDate: null,
  bookings: [],
  todayBookings: [],
  nb: { party: 2, tableId: "", time: null, walkIn: false },
  // live
  events: null,
  sound: readPref("desk-sound", "on") === "on",
};

let money = (cents) => `$${(cents / 100).toFixed(2)}`;

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(`/api/desk${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") {
    showLogin();
    throw new Error("Please log in again");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Start / login ----------

start();

async function start() {
  try {
    state.info = await api("/me");
    await enterDesk();
  } catch {
    showLogin();
  }
}

async function showLogin() {
  stopEvents();
  $("desk-view").hidden = true;
  $("login-view").hidden = false;
  if (!$("login-tenant").value) {
    const fromUrl = new URLSearchParams(location.search).get("tenant");
    const config = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
    $("login-tenant").value = fromUrl || config.defaultTenant || "";
  }
  $("login-password").focus();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    state.info = await api("/login", {
      method: "POST",
      body: { tenantId: $("login-tenant").value.trim(), password: $("login-password").value },
    });
    $("login-password").value = "";
    await enterDesk();
  } catch (err) {
    $("login-error").textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  state.info = null;
  showLogin();
});

async function enterDesk() {
  const info = state.info;
  const format = new Intl.NumberFormat(undefined, { style: "currency", currency: info.currency });
  money = (cents) => format.format(cents / 100);

  $("login-view").hidden = true;
  $("desk-view").hidden = false;
  $("desk-title").textContent = prettyName(info.tenantId);
  document.title = `Desk · ${prettyName(info.tenantId)}`;
  tick();
  state.bookingDate ??= state.now.date;
  renderSoundToggle();
  renderTableChips();

  await Promise.all([loadMenu(), loadOrders(), loadBookings()]);
  startEvents();
}

// ---------- Clock (shop timezone) ----------

function shopNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: state.info.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function tick() {
  if (!state.info) return;
  const before = state.now.minutes;
  state.now = shopNow();
  const time = new Date().toLocaleTimeString([], { timeZone: state.info.timezone, hour: "2-digit", minute: "2-digit" });
  const day = new Date().toLocaleDateString([], { timeZone: state.info.timezone, weekday: "short", day: "numeric", month: "short" });
  $("clock").textContent = `${day} · ${time}`;
  // Timers and "late" flags change every minute.
  if (before !== state.now.minutes && state.orders.length + state.todayBookings.length > 0) {
    renderOrders();
    renderBookings();
  }
}
setInterval(tick, 15_000);

// ---------- Tabs & shortcuts ----------

for (const btn of document.querySelectorAll(".nav button")) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}

function showTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll(".nav button")) btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  for (const panel of document.querySelectorAll(".panel")) panel.hidden = panel.dataset.panel !== tab;
  if (tab === "till" && matchMedia("(min-width: 900px)").matches) $("item-search").focus({ preventScroll: true });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && state.tab === "till" && document.activeElement?.tagName !== "INPUT") {
    e.preventDefault();
    $("item-search").focus();
  }
  if (e.key === "Escape" && document.activeElement === $("item-search")) {
    $("item-search").value = "";
    state.search = "";
    renderTill();
  }
});

// ---------- Live updates, sound & alerts ----------

function startEvents() {
  stopEvents();
  const source = new EventSource("/api/desk/events");
  state.events = source;
  source.addEventListener("ready", () => setLive(true));
  source.addEventListener("change", (e) => onChange(JSON.parse(e.data)));
  source.onopen = () => setLive(true);
  source.onerror = () => {
    setLive(false);
    api("/me").catch(() => {}); // shows the login screen if the session ended
  };
}

function stopEvents() {
  state.events?.close();
  state.events = null;
}

function setLive(on) {
  $("live").classList.toggle("off", !on);
  $("live-text").textContent = on ? "Live" : "Reconnecting…";
}

function onChange(change) {
  if (change.booking && change.booking.source !== "staff") {
    const b = change.booking;
    chime();
    toast(`New ${b.source} booking · ${b.name}, ${b.partySize} people · ${dayName(b.date)} ${b.time}`, {
      tone: "alert",
      action: { label: "View", run: () => (showTab("bookings"), setBookingDate(b.date)) },
    });
  }
  if (change.order && Date.now() - state.lastSentAt > 3000) {
    chime();
    toast(`New order #${pad(change.order.number)}`, { tone: "alert", action: { label: "View", run: () => showTab("orders") } });
  }
  scheduleRefresh(change.kind);
}

const pending = new Set();
let refreshTimer = null;

/** Batches bursts of changes into one reload per kind. */
function scheduleRefresh(kind) {
  pending.add(kind);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const kinds = [...pending];
    pending.clear();
    try {
      if (kinds.includes("menu")) await loadMenu();
      if (kinds.includes("order")) await loadOrders();
      if (kinds.includes("booking")) await loadBookings();
    } catch (err) {
      toast(err.message, { tone: "error" });
    }
  }, 150);
}

let audio = null;
document.addEventListener("pointerdown", () => {
  // Browsers only allow sound after a tap, so unlock audio on the first one.
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch {
    /* no audio support */
  }
});

function chime() {
  if (!state.sound || !audio) return;
  const t = audio.currentTime;
  [880, 1320].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const at = t + i * 0.16;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.4);
  });
}

$("sound-toggle").addEventListener("click", () => {
  state.sound = !state.sound;
  writePref("desk-sound", state.sound ? "on" : "off");
  renderSoundToggle();
  if (state.sound) setTimeout(chime, 50);
});

function renderSoundToggle() {
  $("sound-toggle").setAttribute("aria-pressed", String(state.sound));
  $("sound-toggle").title = state.sound ? "Alert sound on (tap to mute)" : "Alert sound off (tap to unmute)";
}

// ---------- Till ----------

function categoryColor(category) {
  const categories = [...new Set(state.menu.map((m) => m.category))];
  return CATEGORY_COLORS[Math.max(0, categories.indexOf(category)) % CATEGORY_COLORS.length];
}

async function loadMenu() {
  state.menu = (await api("/menu")).menu;
  const categories = [...new Set(state.menu.map((m) => m.category))];
  if (!categories.includes(state.category)) state.category = categories[0] ?? null;
  let removed = 0;
  for (const id of [...state.ticket.keys()]) {
    if (!state.menu.find((m) => m.id === id && m.available)) {
      state.ticket.delete(id);
      removed++;
    }
  }
  if (removed) toast("A sold-out item was removed from the current order.", { tone: "alert" });
  renderTill();
  renderMenuAdmin();
}

$("item-search").addEventListener("input", (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderItems();
});

function renderTill() {
  const categories = [...new Set(state.menu.map((m) => m.category))];
  $("category-pills").replaceChildren(
    ...categories.map((c) =>
      h(
        "button",
        {
          type: "button",
          "aria-pressed": String(!state.search && c === state.category),
          style: { "--cat": categoryColor(c) },
          onclick: () => {
            state.category = c;
            state.search = "";
            $("item-search").value = "";
            renderTill();
          },
        },
        h("i"),
        c,
      ),
    ),
  );
  renderItems();
  renderTicket();
}

function renderItems() {
  const items = state.search
    ? state.menu.filter((m) => m.name.toLowerCase().includes(state.search))
    : state.menu.filter((m) => m.category === state.category);
  for (const b of $("category-pills").children) {
    b.setAttribute("aria-pressed", String(!state.search && b.textContent === state.category));
  }

  $("item-grid").replaceChildren(
    ...(items.length
      ? items.map((m) => {
          const qty = state.ticket.get(m.id) ?? 0;
          return h(
            "button",
            {
              type: "button",
              class: `tile${qty ? " in-ticket" : ""}`,
              disabled: !m.available,
              style: { "--cat": categoryColor(m.category) },
              "aria-label": `${m.name}, ${money(m.price)}${m.available ? "" : ", sold out"}${qty ? `, ${qty} in order` : ""}`,
              onclick: () => addToTicket(m.id),
            },
            h("span", { class: "name" }, m.name),
            state.search ? h("span", { class: "cat-label" }, m.category) : null,
            m.available ? h("span", { class: "price" }, money(m.price)) : h("span", { class: "sold-out" }, "Sold out"),
            qty ? h("span", { class: "qty-badge", "aria-hidden": "true" }, String(qty)) : null,
          );
        })
      : [h("p", { class: "no-results" }, `No items match “${state.search}”.`)]),
  );
}

function addToTicket(id) {
  state.ticket.set(id, Math.min((state.ticket.get(id) ?? 0) + 1, 50));
  renderItems();
  renderTicket(id);
}

function changeQty(id, delta) {
  const qty = (state.ticket.get(id) ?? 0) + delta;
  if (qty <= 0) state.ticket.delete(id);
  else state.ticket.set(id, Math.min(qty, 50));
  renderItems();
  renderTicket();
}

function renderTicket(flashId) {
  const lines = [...state.ticket]
    .map(([id, qty]) => ({ item: state.menu.find((m) => m.id === id), qty }))
    .filter((l) => l.item);

  $("ticket-lines").replaceChildren(
    ...lines.map(({ item, qty }) =>
      h(
        "li",
        { class: item.id === flashId ? "flash" : "" },
        h("span", { class: "line-name" }, item.name),
        h("strong", { class: "line-total" }, money(item.price * qty)),
        h(
          "div",
          { class: "qty" },
          h("button", { type: "button", "aria-label": `One less ${item.name}`, onclick: () => changeQty(item.id, -1) }, "−"),
          h("output", { "aria-label": "Quantity" }, String(qty)),
          h("button", { type: "button", "aria-label": `One more ${item.name}`, onclick: () => changeQty(item.id, 1) }, "+"),
          h("button", { type: "button", class: "remove", onclick: () => changeQty(item.id, -qty) }, "Remove"),
        ),
      ),
    ),
  );
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const total = lines.reduce((sum, l) => sum + l.item.price * l.qty, 0);
  $("ticket-count").textContent = `${count} item${count === 1 ? "" : "s"}`;
  $("ticket-total").textContent = money(total);
  $("empty-ticket").hidden = lines.length > 0;
  $("ticket-lines").hidden = lines.length === 0;

  const needsTable = state.orderType === "dine_in" && !state.orderTable;
  $("send-order").disabled = lines.length === 0 || needsTable;
  $("send-order").textContent = lines.length === 0 ? "Send to kitchen" : needsTable ? "Choose a table" : `Send to kitchen · ${money(total)}`;
}

for (const btn of document.querySelectorAll("#order-type button")) {
  btn.addEventListener("click", () => {
    state.orderType = btn.dataset.type;
    for (const b of document.querySelectorAll("#order-type button")) b.setAttribute("aria-checked", String(b === btn));
    $("table-chips").hidden = state.orderType !== "dine_in";
    renderTableChips();
    renderTicket();
  });
}

function renderTableChips() {
  $("table-chips").replaceChildren(
    ...state.info.tables.map((t) =>
      h(
        "button",
        {
          type: "button",
          role: "radio",
          "aria-checked": String(state.orderTable === t.id),
          onclick: () => {
            state.orderTable = t.id;
            renderTableChips();
            renderTicket();
          },
        },
        shortTable(t.name),
        h("small", {}, `${t.seats} seats`),
      ),
    ),
  );
}

$("clear-ticket").addEventListener("click", clearTicket);

function clearTicket() {
  state.ticket.clear();
  state.orderTable = null;
  $("order-name").value = "";
  $("order-notes").value = "";
  $("ticket-error").textContent = "";
  renderTableChips();
  renderItems();
  renderTicket();
}

$("send-order").addEventListener("click", async () => {
  $("ticket-error").textContent = "";
  $("send-order").disabled = true;
  state.lastSentAt = Date.now();
  try {
    const { order } = await api("/orders", {
      method: "POST",
      body: {
        type: state.orderType,
        tableId: state.orderType === "dine_in" ? state.orderTable : null,
        customerName: $("order-name").value,
        notes: $("order-notes").value,
        items: [...state.ticket].map(([itemId, quantity]) => ({ itemId, quantity })),
      },
    });
    toast(`Order #${pad(order.number)} sent to the kitchen · ${money(order.total)}`, { tone: "success" });
    clearTicket();
    await loadOrders();
  } catch (err) {
    $("ticket-error").textContent = err.message;
    renderTicket();
  }
});

// ---------- Orders (kitchen display) ----------

const NEXT_STEP = {
  new: { status: "preparing", label: "Start", class: "" },
  preparing: { status: "ready", label: "Ready", class: "to-ready" },
  ready: { status: "completed", label: "Picked up", class: "to-done" },
};
const STEP_BACK = { preparing: "new", ready: "preparing", completed: "ready" };

async function loadOrders() {
  const data = await api("/orders");
  state.orders = data.orders;
  state.summary = data.summary;
  renderOrders();
}

function renderOrders() {
  const s = state.summary;
  if (!s) return;
  const open = state.orders.filter((o) => o.status === "new" || o.status === "preparing");
  const longest = Math.max(0, ...open.map((o) => ageMinutes(o.createdAt)));

  $("order-stats").replaceChildren(
    stat(String(s.open), "open orders"),
    stat(open.length ? `${longest} min` : "–", "longest wait", longest >= ORDER_LATE_MIN ? "late" : ""),
    stat(String(s.orders), "orders today"),
    stat(money(s.sales), "sales today"),
  );

  const seen = state.seenOrderIds;
  for (const status of ["new", "preparing", "ready"]) {
    const list = state.orders.filter((o) => o.status === status);
    $(`count-${status}`).textContent = String(list.length);
    $(`col-${status}`).replaceChildren(
      ...(list.length
        ? list.map((o) => orderCard(o, seen && !seen.has(o.id)))
        : [h("div", { class: "lane-empty" }, status === "new" ? "No new orders" : status === "preparing" ? "Nothing in progress" : "Nothing waiting")]),
    );
  }
  state.seenOrderIds = new Set(state.orders.map((o) => o.id));

  const done = state.orders.filter((o) => o.status === "completed" || o.status === "cancelled").reverse();
  $("done-summary").textContent = `Completed & cancelled today (${done.length})`;
  $("col-done").replaceChildren(...done.map((o) => orderCard(o, false)));

  $("badge-orders").textContent = String(s.open);
  $("badge-orders").hidden = s.open === 0;
}

function orderCard(o, isNew) {
  const table = o.tableId ? state.info.tables.find((t) => t.id === o.tableId)?.name ?? o.tableId : null;
  const age = ageMinutes(o.createdAt);
  const active = o.status !== "completed" && o.status !== "cancelled";
  const timerClass = age >= ORDER_LATE_MIN ? "late" : age >= ORDER_WARN_MIN ? "warn" : "ok";
  const next = NEXT_STEP[o.status];
  const lane = { new: "var(--new)", preparing: "var(--prep)", ready: "var(--ready)" }[o.status];

  return h(
    "article",
    { class: `order${isNew ? " is-new-arrival" : ""}`, style: lane ? { "--lane": lane } : {} },
    h(
      "div",
      { class: "order-top" },
      h("span", { class: "order-num" }, `#${pad(o.number)}`),
      h("span", { class: `chip${table ? " table" : ""}` }, table ? shortTable(table) : "Takeaway"),
      active
        ? h("span", { class: `chip timer ${timerClass}`, title: "Waiting time" }, age < 1 ? "now" : `${age} min`)
        : h("span", { class: "chip timer" }, o.status === "completed" ? "Done" : "Cancelled"),
    ),
    o.customerName ? h("div", { class: "order-who" }, o.customerName) : null,
    h("ul", { class: "order-items" }, ...o.items.map((l) => h("li", {}, h("b", {}, `${l.quantity}×`), ` ${l.name}`))),
    o.notes ? h("div", { class: "note" }, o.notes) : null,
    h("div", { class: "order-total" }, money(o.total)),
    h(
      "div",
      { class: "card-actions" },
      next
        ? h("button", { type: "button", class: `btn btn-go ${next.class}`, onclick: () => setOrderStatus(o, next.status) }, next.label)
        : null,
      STEP_BACK[o.status]
        ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => setOrderStatus(o, STEP_BACK[o.status]) }, o.status === "completed" ? "Undo" : "Back")
        : null,
      active
        ? armButton("Cancel", `order-cancel-${o.id}`, () => setOrderStatus(o, "cancelled"))
        : null,
    ),
  );
}

async function setOrderStatus(order, status) {
  try {
    await api(`/orders/${order.id}`, { method: "PATCH", body: { status } });
    await loadOrders();
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

// ---------- Bookings ----------

async function loadBookings() {
  const today = state.now.date;
  const [viewed, todays] = await Promise.all([
    api(`/bookings?date=${state.bookingDate}`),
    state.bookingDate === today ? null : api(`/bookings?date=${today}`),
  ]);
  state.bookings = viewed.bookings;
  state.todayBookings = todays ? todays.bookings : viewed.bookings;
  renderBookings();
}

/** Where a booking belongs right now: late, soon, seated, later, or done. */
function bookingPhase(b, isToday) {
  if (b.status === "completed" || b.status === "cancelled" || b.status === "no_show") return "done";
  if (b.status === "seated") return "seated";
  if (!isToday) return "later";
  const start = toMinutes(b.time);
  if (start <= state.now.minutes - BOOKING_LATE_MIN) return "late";
  if (start <= state.now.minutes + BOOKING_SOON_MIN) return "soon";
  return "later";
}

function renderBookings() {
  if (!state.info) return;
  const today = state.now.date;
  const isToday = state.bookingDate === today;
  $("booking-date").value = state.bookingDate;
  $("day-title").textContent = isToday ? "Today" : state.bookingDate === shiftDate(today, 1) ? "Tomorrow" : dayName(state.bookingDate);
  $("today-btn").hidden = isToday;

  const active = state.bookings.filter((b) => b.status === "confirmed" || b.status === "seated");
  const people = active.reduce((n, b) => n + b.partySize, 0);
  $("booking-stats").textContent = `${active.length} booking${active.length === 1 ? "" : "s"} · ${people} ${people === 1 ? "person" : "people"}`;

  // Table map only makes sense for today.
  $("floor-section").hidden = !isToday;
  if (isToday) renderFloor();

  const groups = { late: [], soon: [], seated: [], later: [], done: [] };
  for (const b of state.bookings) groups[bookingPhase(b, isToday)].push(b);

  const sections = [];
  const section = (title, list, opts = {}) =>
    list.length
      ? h(
          "section",
          {},
          h("h2", { class: `section-title${opts.alert ? " alert" : ""}` }, title, h("b", {}, String(list.length))),
          h("div", { class: "booking-list" }, ...list.map((b) => bookingCard(b, isToday))),
        )
      : null;

  sections.push(section("Late, not arrived", groups.late, { alert: true }));
  sections.push(section("Arriving in the next hour", groups.soon));
  sections.push(section("Seated now", groups.seated));
  sections.push(section(isToday ? "Later today" : "Bookings", groups.later));
  if (groups.done.length) {
    sections.push(
      h(
        "details",
        { class: "collapsed" },
        h("summary", {}, `Finished, cancelled & no-shows (${groups.done.length})`),
        h("div", { class: "booking-list" }, ...groups.done.map((b) => bookingCard(b, isToday))),
      ),
    );
  }
  if (!active.length) {
    sections.unshift(
      h(
        "div",
        { class: "empty-state" },
        h("strong", {}, `No bookings ${isToday ? "for the rest of today" : `on ${dayName(state.bookingDate)}`}`),
        h("span", {}, "New bookings from the website and chat appear here instantly."),
      ),
    );
  }
  $("booking-sections").replaceChildren(...sections.filter(Boolean));

  // Badge: guests who are late or due within the hour.
  const attention = state.todayBookings.filter((b) => ["late", "soon"].includes(bookingPhase(b, true))).length;
  $("badge-bookings").textContent = String(attention);
  $("badge-bookings").hidden = attention === 0;
}

function bookingCard(b, isToday) {
  const phase = bookingPhase(b, isToday);
  const start = toMinutes(b.time);
  const diff = start - state.now.minutes;
  const statusClass = phase === "done" ? "s-done" : phase === "late" ? "s-late" : phase === "soon" ? "s-soon" : `s-${b.status}`;

  const chips = [h("span", { class: "chip party" }, `${b.partySize} ${b.partySize === 1 ? "person" : "people"}`), h("span", { class: "chip table" }, shortTable(b.tableName))];
  if (phase === "late") chips.push(h("span", { class: "chip late-chip" }, `${-diff} min late`));
  if (phase === "soon") chips.push(h("span", { class: "chip soon-chip" }, diff <= 0 ? "Due now" : `In ${diff} min`));
  if (b.status === "seated") chips.push(h("span", { class: "chip status-seated" }, "Seated"));
  if (phase === "done") chips.push(h("span", { class: "chip status-done" }, { completed: "Finished", cancelled: "Cancelled", no_show: "No-show" }[b.status]));

  const actions = [];
  if (b.status === "confirmed") {
    actions.push(h("button", { type: "button", class: "btn btn-go", onclick: () => setBookingStatus(b, "seated") }, "Seat"));
    if (phase === "late" || !isToday || diff <= 0) {
      actions.push(armButton("No-show", `booking-noshow-${b.id}`, () => setBookingStatus(b, "no_show"), { armedLabel: "Tap to confirm", className: "btn btn-ghost btn-sm" }));
    }
    actions.push(armButton("Cancel", `booking-cancel-${b.id}`, () => setBookingStatus(b, "cancelled")));
  } else if (b.status === "seated") {
    actions.push(h("button", { type: "button", class: "btn btn-go to-done", onclick: () => setBookingStatus(b, "completed") }, "Finish"));
    actions.push(h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => setBookingStatus(b, "confirmed") }, "Undo"));
  } else if (b.status === "completed") {
    actions.push(h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => setBookingStatus(b, "seated") }, "Undo"));
  } else if (b.status === "no_show") {
    actions.push(h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => setBookingStatus(b, "confirmed") }, "They arrived"));
  }

  return h(
    "article",
    { class: `booking ${statusClass}` },
    h("div", { class: "b-time" }, h("strong", {}, b.time), h("span", {}, `until ${b.endTime}`)),
    h(
      "div",
      { class: "b-main" },
      h("div", { class: "b-name" }, b.name),
      h("div", { class: "b-chips" }, ...chips),
      b.notes ? h("div", { class: "note" }, b.notes) : null,
      h(
        "div",
        { class: "b-meta" },
        b.phone ? h("a", { href: `tel:${b.phone}` }, b.phone) : "No phone",
        ` · ${b.reference} · via ${b.source}`,
      ),
    ),
    h("div", { class: "b-actions" }, ...actions),
  );
}

/** Live table map: free, reserved soon, late, or seated, plus open dine-in orders. */
function renderFloor() {
  const now = state.now.minutes;
  const openOrders = state.orders.filter((o) => o.tableId && ["new", "preparing", "ready"].includes(o.status));

  $("floor").replaceChildren(
    ...state.info.tables.map((t) => {
      const mine = state.todayBookings.filter((b) => b.tableId === t.id);
      const seated = mine.find((b) => b.status === "seated");
      const next = mine
        .filter((b) => b.status === "confirmed" && toMinutes(b.endTime) > now)
        .sort((a, b) => toMinutes(a.time) - toMinutes(b.time))[0];
      const orders = openOrders.filter((o) => o.tableId === t.id);

      let kind = "free";
      let label = "Free";
      let detail = next ? `Next booking ${next.time}` : "No more bookings today";
      if (seated) {
        kind = "seated";
        label = "Seated";
        detail = `${seated.name} · ${seated.partySize}p · until ${seated.endTime}`;
      } else if (next && toMinutes(next.time) <= now - BOOKING_LATE_MIN) {
        kind = "late";
        label = `Late · ${next.time}`;
        detail = `${next.name} · ${next.partySize}p`;
      } else if (next && toMinutes(next.time) <= now + BOOKING_SOON_MIN) {
        kind = "reserved";
        label = `Reserved ${next.time}`;
        detail = `${next.name} · ${next.partySize}p`;
      }

      const content = [
        h("span", { class: "t-name" }, shortTable(t.name), h("span", { class: "t-seats" }, `${t.seats} seats`)),
        h("span", { class: "t-state" }, label),
        h("span", { class: "t-detail" }, detail),
        ...orders.map((o) => h("span", { class: "t-detail" }, `Order #${pad(o.number)} · ${o.status}`)),
      ];
      return kind === "free"
        ? h(
            "button",
            { type: "button", class: "table-card free", title: "Seat a walk-in here", onclick: () => openBookingDialog({ tableId: t.id, walkIn: true }) },
            ...content,
          )
        : h("div", { class: `table-card ${kind}` }, ...content);
    }),
  );
}

async function setBookingStatus(booking, status) {
  try {
    await api(`/bookings/${booking.id}`, { method: "PATCH", body: { status } });
    await loadBookings();
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

function setBookingDate(date) {
  state.bookingDate = date;
  loadBookings().catch((err) => toast(err.message, { tone: "error" }));
}

$("booking-date").addEventListener("change", (e) => e.target.value && setBookingDate(e.target.value));
$("prev-day").addEventListener("click", () => setBookingDate(shiftDate(state.bookingDate, -1)));
$("next-day").addEventListener("click", () => setBookingDate(shiftDate(state.bookingDate, 1)));
$("today-btn").addEventListener("click", () => setBookingDate(state.now.date));
$("day-title").addEventListener("click", () => $("booking-date").showPicker?.());

// ---------- New booking dialog (phone bookings & walk-ins) ----------

const dialog = $("booking-dialog");
$("new-booking-btn").addEventListener("click", () => openBookingDialog());
$("nb-close").addEventListener("click", () => dialog.close());
$("nb-cancel").addEventListener("click", () => dialog.close());
$("nb-date").addEventListener("change", loadTimes);
$("nb-party-minus").addEventListener("click", () => setParty(state.nb.party - 1));
$("nb-party-plus").addEventListener("click", () => setParty(state.nb.party + 1));

function openBookingDialog({ tableId = "", walkIn = false } = {}) {
  const table = state.info.tables.find((t) => t.id === tableId);
  state.nb = { party: table ? Math.min(2, table.seats) : 2, tableId, time: null, walkIn };
  $("nb-title").textContent = walkIn ? `Seat a walk-in · ${shortTable(table?.name ?? "")}` : "New booking";
  $("nb-date").value = walkIn ? state.now.date : state.bookingDate;
  $("nb-name").value = walkIn ? "Walk-in" : "";
  $("nb-phone").value = "";
  $("nb-notes").value = "";
  $("nb-error").textContent = "";
  $("nb-submit").textContent = walkIn ? "Seat now" : "Create booking";
  $("nb-party").textContent = String(state.nb.party);
  renderNbTables();
  dialog.showModal();
  loadTimes();
  if (!walkIn) $("nb-name").focus();
}

function setParty(n) {
  const max = Math.max(...state.info.tables.map((t) => t.seats));
  state.nb.party = Math.min(max, Math.max(1, n));
  $("nb-party").textContent = String(state.nb.party);
  const table = state.info.tables.find((t) => t.id === state.nb.tableId);
  if (table && table.seats < state.nb.party) state.nb.tableId = "";
  renderNbTables();
  loadTimes();
}

function renderNbTables() {
  const chip = (id, label, sub, disabled) =>
    h(
      "button",
      {
        type: "button",
        role: "radio",
        "aria-checked": String(state.nb.tableId === id),
        disabled,
        onclick: () => {
          state.nb.tableId = id;
          renderNbTables();
          loadTimes();
        },
      },
      label,
      h("small", {}, sub),
    );
  $("nb-tables").replaceChildren(
    chip("", "Any", "best fit", false),
    ...state.info.tables.map((t) => chip(t.id, shortTable(t.name), `${t.seats} seats`, t.seats < state.nb.party)),
  );
}

let timesRequest = 0;
async function loadTimes() {
  const request = ++timesRequest;
  state.nb.time = null;
  $("nb-submit").disabled = true;
  const date = $("nb-date").value;
  if (!date) return;
  const params = new URLSearchParams({ date, partySize: String(state.nb.party) });
  if (state.nb.tableId) params.set("tableId", state.nb.tableId);
  try {
    const { times, reason } = await api(`/availability?${params}`);
    if (request !== timesRequest) return; // a newer request is on its way
    $("nb-times").replaceChildren(
      ...(times.length
        ? times.map((t) => h("button", { type: "button", role: "radio", "aria-checked": "false", onclick: () => pickTime(t) }, t))
        : [h("p", { class: "none" }, reason || "No free times.")]),
    );
    $("nb-error").textContent = "";
    if (state.nb.walkIn && times.length) pickTime(times[0]); // walk-ins start now
  } catch (err) {
    $("nb-times").replaceChildren();
    $("nb-error").textContent = err.message;
  }
}

function pickTime(time) {
  state.nb.time = time;
  for (const b of $("nb-times").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.textContent === time));
  $("nb-submit").disabled = false;
}

$("booking-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("nb-error").textContent = "";
  $("nb-submit").disabled = true;
  try {
    const { booking } = await api("/bookings", {
      method: "POST",
      body: {
        date: $("nb-date").value,
        time: state.nb.time,
        partySize: state.nb.party,
        name: $("nb-name").value,
        phone: $("nb-phone").value,
        notes: $("nb-notes").value,
        tableId: state.nb.tableId || undefined,
      },
    });
    if (state.nb.walkIn) await api(`/bookings/${booking.id}`, { method: "PATCH", body: { status: "seated" } });
    dialog.close();
    toast(
      state.nb.walkIn
        ? `${booking.name} seated at ${shortTable(booking.tableName)}`
        : `Booked ${booking.name} · ${dayName(booking.date)} ${booking.time} · ${shortTable(booking.tableName)}`,
      { tone: "success" },
    );
    setBookingDate(booking.date);
  } catch (err) {
    $("nb-error").textContent = err.message;
    $("nb-submit").disabled = !state.nb.time;
  }
});

// ---------- Menu ----------

function renderMenuAdmin() {
  const categories = [...new Set(state.menu.map((m) => m.category))];
  const soldOut = state.menu.filter((m) => !m.available);

  $("menu-summary").textContent = soldOut.length
    ? `${soldOut.length} item${soldOut.length === 1 ? " is" : "s are"} sold out: ${soldOut.map((m) => m.name).join(", ")}.`
    : "Everything is available. Tap an item to mark it sold out.";
  $("restock-all").replaceWith(
    Object.assign(armButton("Mark all available", "restock-all", restockAll, { armedLabel: "Tap to confirm", className: "btn btn-ghost btn-sm" }), {
      id: "restock-all",
      hidden: soldOut.length === 0,
    }),
  );
  $("badge-menu").textContent = String(soldOut.length);
  $("badge-menu").hidden = soldOut.length === 0;
  $("badge-menu").title = "Sold out items";

  $("menu-admin").replaceChildren(
    ...categories.map((c) =>
      h(
        "section",
        { class: "menu-group", style: { "--cat": categoryColor(c) } },
        h("h3", {}, c),
        ...state.menu
          .filter((m) => m.category === c)
          .map((m) =>
            h(
              "button",
              { type: "button", class: "menu-row", role: "switch", "aria-checked": String(m.available), onclick: () => setAvailable(m, !m.available) },
              h("span", {}, h("span", { class: "m-name" }, m.name), " ", h("span", { class: "m-price" }, money(m.price))),
              h("span", { class: "m-state" }, m.available ? "Available" : "Sold out"),
              h("span", { class: "switch", "aria-hidden": "true" }),
            ),
          ),
      ),
    ),
  );
}

async function setAvailable(item, available) {
  try {
    await api(`/menu/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { available } });
    await loadMenu();
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

async function restockAll() {
  const soldOut = state.menu.filter((m) => !m.available);
  try {
    await Promise.all(soldOut.map((m) => api(`/menu/${encodeURIComponent(m.id)}`, { method: "PATCH", body: { available: true } })));
    await loadMenu();
    toast("Everything is available again", { tone: "success" });
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

// ---------- Helpers ----------

/**
 * Two-tap confirm for destructive actions: the first tap turns the button red,
 * a second tap within 3 seconds runs it. Faster than a pop-up on a busy counter.
 * The armed state is kept by key, so a live refresh between taps doesn't reset it.
 */
let armed = null; // { key, until }

function armButton(label, key, action, { armedLabel = "Tap again", className = "btn btn-danger btn-sm" } = {}) {
  const isArmed = armed?.key === key && armed.until > Date.now();
  return h(
    "button",
    {
      type: "button",
      class: `${className}${isArmed ? " armed" : ""}`,
      "data-arm": key,
      "data-label": label,
      "data-armed-label": armedLabel,
      onclick: () => {
        if (armed?.key === key && armed.until > Date.now()) {
          armed = null;
          syncArmed();
          action();
          return;
        }
        armed = { key, until: Date.now() + 3000 };
        syncArmed();
        setTimeout(() => {
          if (armed?.key === key && armed.until <= Date.now()) {
            armed = null;
            syncArmed();
          }
        }, 3050);
      },
    },
    isArmed ? armedLabel : label,
  );
}

function syncArmed() {
  for (const b of document.querySelectorAll("[data-arm]")) {
    const on = armed?.key === b.dataset.arm;
    b.classList.toggle("armed", on);
    b.textContent = on ? b.dataset.armedLabel : b.dataset.label;
  }
}

function stat(value, label, tone = "") {
  return h("div", { class: `stat${tone ? ` ${tone}` : ""}` }, h("strong", {}, value), h("span", {}, label));
}

function toast(text, { tone = "", action = null, ms = 6000 } = {}) {
  const el = h(
    "div",
    { class: `toast ${tone}`, role: "status" },
    h("p", {}, text),
    action
      ? h(
          "button",
          {
            type: "button",
            onclick: () => {
              action.run();
              el.remove();
            },
          },
          action.label,
        )
      : null,
  );
  $("toasts").append(el);
  while ($("toasts").children.length > 3) $("toasts").firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

function pad(n) {
  return String(n).padStart(3, "0");
}

function toMinutes(time) {
  const [hh, mm] = time.split(":").map(Number);
  return hh * 60 + mm;
}

function ageMinutes(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayName(date) {
  if (state.now.date && date === state.now.date) return "Today";
  if (state.now.date && date === shiftDate(state.now.date, 1)) return "Tomorrow";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
}

/** "Big Table 6" -> "Table 6", "Window 3" stays. Keeps chips short. */
function shortTable(name) {
  return name.replace(/^Big\s+/i, "");
}

function prettyName(id) {
  return id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bAnd\b/g, "&");
}

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: preference lasts this visit only */
  }
}
