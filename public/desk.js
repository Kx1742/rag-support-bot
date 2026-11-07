// Staff desk: till, order queue, bookings and menu. Plain JavaScript, no framework.
// All data is rendered with DOM nodes / textContent (never innerHTML).

const $ = (id) => document.getElementById(id);

/** Tiny element builder: h("div", { class: "x", onclick: fn }, "text", child) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const state = {
  info: null, // from /api/desk/me
  tab: "till",
  menu: [],
  category: null,
  ticket: new Map(), // itemId -> quantity
  orderType: "takeaway",
  orders: [],
  summary: null,
  bookingDate: null,
  bookings: [],
  newBooking: { time: null },
  events: null,
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
    enterDesk();
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
    enterDesk();
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
  $("desk-title").textContent = `Desk · ${info.tenantId}`;
  document.title = `Desk · ${info.tenantId}`;
  state.bookingDate ??= info.today;

  const tableOptions = () => info.tables.map((t) => h("option", { value: t.id }, `${t.name} (${t.seats})`));
  $("order-table").replaceChildren(...tableOptions());
  $("nb-table").replaceChildren(h("option", { value: "" }, "Any free table"), ...tableOptions());

  await Promise.all([loadMenu(), loadOrders(), loadBookings()]);
  startEvents();
}

// ---------- Tabs ----------

for (const btn of document.querySelectorAll(".tabs button")) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
}

function showTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll(".tabs button")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  }
  for (const panel of document.querySelectorAll(".tab-panel")) panel.hidden = panel.dataset.panel !== tab;
}

// ---------- Live updates ----------

function startEvents() {
  stopEvents();
  const source = new EventSource("/api/desk/events");
  state.events = source;
  source.addEventListener("ready", () => $("live").classList.remove("off"));
  source.addEventListener("change", (e) => {
    const change = JSON.parse(e.data);
    if (change.booking && change.booking.source !== "staff") {
      const b = change.booking;
      toast(`New ${b.source} booking: ${b.name}, ${b.partySize} people · ${formatDate(b.date)} at ${b.time}`);
    }
    scheduleRefresh(change.kind);
  });
  source.onerror = () => {
    $("live").classList.add("off");
    $("live").textContent = "● Reconnecting";
    // If the session expired, /me fails and shows the login screen.
    api("/me").catch(() => {});
  };
  source.onopen = () => {
    $("live").classList.remove("off");
    $("live").textContent = "● Live";
  };
}

function stopEvents() {
  state.events?.close();
  state.events = null;
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
    if (kinds.includes("menu")) await loadMenu();
    if (kinds.includes("order")) await loadOrders({ announce: true });
    if (kinds.includes("booking")) await loadBookings();
  }, 150);
}

// ---------- Menu & till ----------

async function loadMenu() {
  state.menu = (await api("/menu")).menu;
  const categories = [...new Set(state.menu.map((m) => m.category))];
  if (!categories.includes(state.category)) state.category = categories[0] ?? null;
  // Drop sold-out items from the ticket.
  for (const id of state.ticket.keys()) {
    if (!state.menu.find((m) => m.id === id && m.available)) state.ticket.delete(id);
  }
  renderTill();
  renderMenuAdmin();
}

function renderTill() {
  const categories = [...new Set(state.menu.map((m) => m.category))];
  $("category-pills").replaceChildren(
    ...categories.map((c) =>
      h("button", { type: "button", "aria-pressed": String(c === state.category), onclick: () => ((state.category = c), renderTill()) }, c),
    ),
  );
  $("item-grid").replaceChildren(
    ...state.menu
      .filter((m) => m.category === state.category)
      .map((m) =>
        h(
          "button",
          { type: "button", class: "item-btn", disabled: !m.available, onclick: () => addToTicket(m.id) },
          h("span", {}, m.name),
          m.available ? h("span", { class: "price" }, money(m.price)) : h("span", { class: "sold-out" }, "Sold out"),
        ),
      ),
  );
  renderTicket();
}

function addToTicket(id) {
  state.ticket.set(id, (state.ticket.get(id) ?? 0) + 1);
  renderTicket();
}

function changeQty(id, delta) {
  const qty = (state.ticket.get(id) ?? 0) + delta;
  if (qty <= 0) state.ticket.delete(id);
  else state.ticket.set(id, Math.min(qty, 50));
  renderTicket();
}

function renderTicket() {
  const lines = [...state.ticket].map(([id, qty]) => ({ item: state.menu.find((m) => m.id === id), qty })).filter((l) => l.item);
  $("ticket-lines").replaceChildren(
    ...lines.map(({ item, qty }) =>
      h(
        "li",
        {},
        h("span", {}, item.name),
        h(
          "span",
          { class: "qty" },
          h("button", { type: "button", "aria-label": `One less ${item.name}`, onclick: () => changeQty(item.id, -1) }, "−"),
          h("span", {}, String(qty)),
          h("button", { type: "button", "aria-label": `One more ${item.name}`, onclick: () => changeQty(item.id, 1) }, "+"),
        ),
        h("strong", {}, money(item.price * qty)),
      ),
    ),
  );
  const total = lines.reduce((sum, l) => sum + l.item.price * l.qty, 0);
  $("ticket-total").textContent = money(total);
  $("empty-ticket").hidden = lines.length > 0;
  $("send-order").disabled = lines.length === 0;
}

for (const btn of document.querySelectorAll("#order-type button")) {
  btn.addEventListener("click", () => {
    state.orderType = btn.dataset.type;
    for (const b of document.querySelectorAll("#order-type button")) b.setAttribute("aria-pressed", String(b === btn));
    $("table-field").hidden = state.orderType !== "dine_in";
  });
}

$("clear-ticket").addEventListener("click", clearTicket);

function clearTicket() {
  state.ticket.clear();
  $("order-name").value = "";
  $("order-notes").value = "";
  $("ticket-error").textContent = "";
  renderTicket();
}

$("send-order").addEventListener("click", async () => {
  $("ticket-error").textContent = "";
  $("send-order").disabled = true;
  try {
    const { order } = await api("/orders", {
      method: "POST",
      body: {
        type: state.orderType,
        tableId: state.orderType === "dine_in" ? $("order-table").value : null,
        customerName: $("order-name").value,
        notes: $("order-notes").value,
        items: [...state.ticket].map(([itemId, quantity]) => ({ itemId, quantity })),
      },
    });
    toast(`Order #${pad(order.number)} sent · ${money(order.total)}`);
    clearTicket();
    await loadOrders();
  } catch (err) {
    $("ticket-error").textContent = err.message;
    renderTicket();
  }
});

function renderMenuAdmin() {
  const categories = [...new Set(state.menu.map((m) => m.category))];
  $("menu-admin").replaceChildren(
    ...categories.map((c) =>
      h(
        "div",
        { class: "card" },
        h("h3", {}, c),
        h(
          "ul",
          {},
          ...state.menu
            .filter((m) => m.category === c)
            .map((m) =>
              h(
                "li",
                {},
                h("span", {}, `${m.name} · `, h("span", { class: "muted" }, money(m.price))),
                h(
                  "button",
                  {
                    type: "button",
                    class: `ghost small toggle${m.available ? "" : " off"}`,
                    "aria-pressed": String(!m.available),
                    onclick: () => setAvailable(m, !m.available),
                  },
                  m.available ? "Available" : "Sold out",
                ),
              ),
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
    toast(err.message);
  }
}

// ---------- Orders ----------

const ORDER_NEXT = {
  new: [["preparing", "Start"], ["cancelled", "Cancel"]],
  preparing: [["ready", "Ready"], ["new", "Back"], ["cancelled", "Cancel"]],
  ready: [["completed", "Picked up"], ["preparing", "Back"]],
  completed: [["ready", "Undo"]],
  cancelled: [],
};

async function loadOrders({ announce = false } = {}) {
  const before = new Set(state.orders.map((o) => o.id));
  const data = await api("/orders");
  state.orders = data.orders;
  state.summary = data.summary;
  if (announce) {
    for (const o of state.orders) if (!before.has(o.id)) toast(`New order #${pad(o.number)}`);
  }
  renderOrders();
}

function renderOrders() {
  const s = state.summary;
  $("order-stats").replaceChildren(
    stat(String(s.open), "open orders"),
    stat(String(s.orders), "orders today"),
    stat(String(s.items), "items sold"),
    stat(money(s.sales), "sales today"),
  );
  for (const status of ["new", "preparing", "ready"]) {
    const list = state.orders.filter((o) => o.status === status);
    $(`col-${status}`).replaceChildren(...(list.length ? list.map(orderCard) : [h("p", { class: "muted small" }, "Nothing here")]));
  }
  const done = state.orders.filter((o) => o.status === "completed" || o.status === "cancelled").reverse();
  $("done-summary").textContent = `Completed & cancelled (${done.length})`;
  $("col-done").replaceChildren(...done.map(orderCard));
  $("orders-count").textContent = String(s.open);
  $("orders-count").hidden = s.open === 0;
}

function orderCard(o) {
  const table = o.tableId ? state.info.tables.find((t) => t.id === o.tableId)?.name ?? o.tableId : null;
  return h(
    "article",
    { class: "order-card" },
    h(
      "header",
      {},
      h("span", { class: "num" }, `#${pad(o.number)}`),
      h("span", { class: `badge ${o.status}` }, o.status),
    ),
    h("div", { class: "muted small" }, [o.type === "dine_in" ? `Dine in${table ? ` · ${table}` : ""}` : "Takeaway", o.customerName, timeAgo(o.createdAt)].filter(Boolean).join(" · ")),
    h("ul", {}, ...o.items.map((l) => h("li", {}, `${l.quantity} × ${l.name}`))),
    o.notes ? h("div", { class: "small" }, `Note: ${o.notes}`) : null,
    h("div", { class: "small" }, h("strong", {}, money(o.total))),
    h(
      "div",
      { class: "actions" },
      ...ORDER_NEXT[o.status].map(([status, label]) =>
        h(
          "button",
          { type: "button", class: status === "cancelled" ? "ghost small danger" : "ghost small", onclick: () => setOrderStatus(o, status) },
          label,
        ),
      ),
    ),
  );
}

async function setOrderStatus(order, status) {
  if (status === "cancelled" && !confirm(`Cancel order #${pad(order.number)}?`)) return;
  try {
    await api(`/orders/${order.id}`, { method: "PATCH", body: { status } });
    await loadOrders();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- Bookings ----------

const BOOKING_NEXT = {
  confirmed: [["seated", "Seat"], ["no_show", "No-show"], ["cancelled", "Cancel"]],
  seated: [["completed", "Finish"], ["confirmed", "Undo"]],
  completed: [["seated", "Undo"]],
  no_show: [["confirmed", "Undo"]],
  cancelled: [],
};
const STATUS_LABEL = { confirmed: "Confirmed", seated: "Seated", completed: "Finished", cancelled: "Cancelled", no_show: "No-show" };

async function loadBookings() {
  state.bookings = (await api(`/bookings?date=${state.bookingDate}`)).bookings;
  renderBookings();
  if (!$("booking-form").hidden) loadTimes();
}

function renderBookings() {
  $("booking-date").value = state.bookingDate;
  const active = state.bookings.filter((b) => b.status === "confirmed" || b.status === "seated");
  const covers = active.reduce((n, b) => n + b.partySize, 0);
  $("booking-stats").textContent = `${active.length} active booking${active.length === 1 ? "" : "s"} · ${covers} people`;

  $("booking-list").replaceChildren(
    ...(state.bookings.length
      ? state.bookings.map(bookingRow)
      : [h("div", { class: "empty" }, `No bookings for ${formatDate(state.bookingDate)}.`)]),
  );
}

function bookingRow(b) {
  const inactive = b.status === "cancelled" || b.status === "no_show";
  return h(
    "article",
    { class: `booking-row${inactive ? " inactive" : ""}` },
    h("div", {}, h("div", { class: "time" }, b.time), h("div", { class: "meta" }, `to ${b.endTime}`)),
    h(
      "div",
      {},
      h("div", { class: "who" }, `${b.name} · ${b.partySize} ${b.partySize === 1 ? "person" : "people"}`),
      h("div", { class: "meta" }, [b.tableName, b.phone, b.reference, `via ${b.source}`].filter(Boolean).join(" · ")),
      b.notes ? h("div", { class: "small" }, `Note: ${b.notes}`) : null,
    ),
    h(
      "div",
      { class: "right" },
      h("span", { class: `badge ${b.status}` }, STATUS_LABEL[b.status]),
      h(
        "div",
        { class: "actions" },
        ...BOOKING_NEXT[b.status].map(([status, label]) =>
          h(
            "button",
            {
              type: "button",
              class: status === "cancelled" || status === "no_show" ? "ghost small danger" : "ghost small",
              onclick: () => setBookingStatus(b, status),
            },
            label,
          ),
        ),
      ),
    ),
  );
}

async function setBookingStatus(booking, status) {
  if (status === "cancelled" && !confirm(`Cancel ${booking.name}'s booking at ${booking.time}?`)) return;
  try {
    await api(`/bookings/${booking.id}`, { method: "PATCH", body: { status } });
    await loadBookings();
  } catch (err) {
    toast(err.message);
  }
}

function setBookingDate(date) {
  state.bookingDate = date;
  loadBookings().catch((err) => toast(err.message));
}

$("booking-date").addEventListener("change", (e) => e.target.value && setBookingDate(e.target.value));
$("prev-day").addEventListener("click", () => setBookingDate(shiftDate(state.bookingDate, -1)));
$("next-day").addEventListener("click", () => setBookingDate(shiftDate(state.bookingDate, 1)));
$("today-btn").addEventListener("click", () => setBookingDate(state.info.today));

// New booking form (phone bookings and walk-ins)
$("new-booking-btn").addEventListener("click", () => {
  $("booking-form").hidden = false;
  $("nb-date").value = state.bookingDate;
  $("nb-error").textContent = "";
  loadTimes();
  $("nb-name").focus();
});
$("nb-cancel").addEventListener("click", () => ($("booking-form").hidden = true));
for (const id of ["nb-date", "nb-party", "nb-table"]) $(id).addEventListener("change", loadTimes);

async function loadTimes() {
  state.newBooking.time = null;
  $("nb-submit").disabled = true;
  const date = $("nb-date").value;
  const party = Number($("nb-party").value);
  if (!date || !(party >= 1)) return;
  try {
    const { times, reason } = await api(`/availability?date=${date}&partySize=${party}`);
    $("nb-times").replaceChildren(
      ...(times.length
        ? times.map((t) =>
            h("button", { type: "button", "aria-pressed": "false", onclick: (e) => pickTime(t, e.currentTarget) }, t),
          )
        : [h("span", { class: "muted small" }, reason || "No free times.")]),
    );
    $("nb-error").textContent = "";
  } catch (err) {
    $("nb-times").replaceChildren();
    $("nb-error").textContent = err.message;
  }
}

function pickTime(time, button) {
  state.newBooking.time = time;
  for (const b of $("nb-times").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === button));
  $("nb-submit").disabled = false;
}

$("booking-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("nb-error").textContent = "";
  try {
    const { booking } = await api("/bookings", {
      method: "POST",
      body: {
        date: $("nb-date").value,
        time: state.newBooking.time,
        partySize: Number($("nb-party").value),
        name: $("nb-name").value,
        phone: $("nb-phone").value,
        notes: $("nb-notes").value,
        tableId: $("nb-table").value || undefined,
      },
    });
    toast(`Booked ${booking.name} at ${booking.time} (${booking.tableName}) · ${booking.reference}`);
    for (const id of ["nb-name", "nb-phone", "nb-notes"]) $(id).value = "";
    $("booking-form").hidden = true;
    setBookingDate(booking.date);
  } catch (err) {
    $("nb-error").textContent = err.message;
  }
});

// ---------- Helpers ----------

function stat(value, label) {
  return h("div", { class: "stat" }, h("strong", {}, value), h("span", {}, label));
}

function toast(text) {
  const el = h("div", { class: "toast", role: "status" }, text);
  $("toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}

function pad(n) {
  return String(n).padStart(3, "0");
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDate(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
}

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Refresh "x min ago" labels.
setInterval(() => state.info && state.tab === "orders" && renderOrders(), 60_000);
