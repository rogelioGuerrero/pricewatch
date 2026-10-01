// PriceWatch SV — navegación network-first (abrir la app trae la
// versión fresca); sin señal cae al último snapshot cacheado.
const CACHE = "pricewatch-v19";
const CORE = ["./", "./index.html", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;

  // version.json nunca se cachea: es el detector de builds nuevos
  if (url.pathname.endsWith("version.json")) return;

  // navegación: red primero, último snapshot si no hay señal
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() =>
        caches.match(e.request).then(h => h || caches.match("./index.html")))
    );
    return;
  }

  // resto same-origin: cache-first con revalidación en background
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// ---- web push: el digest del sweep despierta al dispositivo ----
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "PriceWatch", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: d.url || "./index.html" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./index.html";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes("index") || c.url.endsWith("/")) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
