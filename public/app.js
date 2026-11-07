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
      if (event === "sources") sources = data.sources;
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
