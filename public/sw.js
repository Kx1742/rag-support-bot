// Service worker: keeps a copy of the pages so a shaky café Wi-Fi doesn't leave a blank screen.
// - Pages and static files: network first (always fresh when online), cached copy when offline.
// - /api/ requests are never touched: orders, payments and bookings always go to the server.

const CACHE = "shell-v1";
const SHELL = ["/", "/app.js", "/styles.css", "/desk", "/desk.js", "/desk.css", "/display", "/display.js", "/display.css", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          // Store pages by path so "/desk?tenant=x" and "/desk" share one offline copy.
          caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        }
        return response;
      })
      .catch(() => caches.match(url.pathname).then((cached) => cached ?? Response.error())),
  );
});
