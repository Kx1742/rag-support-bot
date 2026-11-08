// Customer pickup screen: shows order numbers being made and ready to collect.
// Public and read-only: the server only sends order numbers, never names or items.

const $ = (id) => document.getElementById(id);
const tenantId = new URLSearchParams(location.search).get("tenant");
let tenant = tenantId;
let knownReady = new Set();
let firstLoad = true;
let audio = null;

start();

async function start() {
  if (!tenant) {
    const config = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
    tenant = config.defaultTenant;
  }
  await refresh();
  listen();
  tick();
  setInterval(tick, 15_000);
  setInterval(refresh, 60_000); // safety net if a live update is missed
}

async function refresh() {
  try {
    const res = await fetch(`/api/tenants/${encodeURIComponent(tenant)}/pickup`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    $("offline").hidden = true;
  } catch {
    $("offline").hidden = false;
  }
}

function render(board) {
  $("name").textContent = board.name;
  document.title = `${board.name} · Order pickup`;

  const fresh = board.ready.filter((n) => !knownReady.has(n));
  if (!firstLoad && fresh.length) chime();
  knownReady = new Set(board.ready);
  firstLoad = false;

  $("preparing").replaceChildren(...numbers(board.preparing, [], "Nothing in the queue"));
  // The server sends ready orders newest-call first.
  $("ready").replaceChildren(...numbers(board.ready, fresh, "—"));
}

function numbers(list, fresh, emptyText) {
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = emptyText;
    return [p];
  }
  return list.map((n) => {
    const span = document.createElement("span");
    span.className = `num${fresh.includes(n) ? " fresh" : ""}`;
    span.textContent = String(n).padStart(3, "0");
    return span;
  });
}

function listen() {
  const source = new EventSource(`/api/tenants/${encodeURIComponent(tenant)}/pickup/events`);
  let timer = null;
  source.addEventListener("change", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  });
  source.onopen = () => {
    $("offline").hidden = true;
    refresh();
  };
  source.onerror = () => ($("offline").hidden = false);
}

function tick() {
  $("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Browsers only allow sound after a tap on the page.
$("sound").addEventListener("click", () => {
  try {
    audio ??= new AudioContext();
    audio.resume();
    $("sound").textContent = "Sound on";
    $("sound").classList.add("on");
    chime();
  } catch {
    $("sound").textContent = "No sound on this device";
  }
});

$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

function chime() {
  if (!audio || audio.state !== "running") return;
  const t = audio.currentTime;
  [660, 880, 1100].forEach((freq, i) => {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const at = t + i * 0.18;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.55);
  });
}
