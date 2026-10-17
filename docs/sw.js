// PriceWatch SV — navegación network-first (abrir la app trae la
// versión fresca); sin señal cae al último snapshot cacheado.
const CACHE = "pricewatch-v25";
// shell completa precacheada: si el SW se actualiza y el usuario abre
// offline antes de navegar online, los js/css ya estan en el cache
// nuevo (antes solo sobrevivian si ya se habian pedido)
const CORE = ["./", "./index.html", "./manifest.webmanifest",
             "./data.json", "./styles.css",
             "./js/state.js", "./js/siman.js", "./js/sync.js",
             "./js/render.js", "./js/app.js"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    // add por recurso (no addAll): si algo faltara en un deploy no
    // tumba la instalacion entera del SW
    Promise.all(CORE.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      // solo caches de esta app: GitHub Pages comparte CacheStorage
      // entre todos los proyectos del mismo user origin — borrar lo
      // demas romperia apps ajenas
      Promise.all(keys
        .filter(k => k.startsWith("pricewatch-") && k !== CACHE)
        .map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;

  // version.json nunca se cachea: es el detector de builds nuevos
  if (url.pathname.endsWith("version.json")) return;

  // data.json: red primero (igual que la navegación) — es lo único
  // que cambia entre builds; sin señal cae al último snapshot
  if (url.pathname.endsWith("data.json")) {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) { const cp = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, cp)); }
        return r;
      }).catch(() => caches.open(CACHE).then(c => c.match(e.request)))
    );
    return;
  }

  // navegación: red primero, último snapshot si no hay señal
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(r => {
        // clonar ANTES de devolverla: el callback del cache corre async
        // y para entonces el body ya se consumio (clone() fallaba)
        if (r.ok) { const cp = r.clone();
                    caches.open(CACHE).then(c => c.put(e.request, cp)); }
        return r;
      }).catch(() => caches.open(CACHE).then(c =>
        c.match(e.request).then(h => h || c.match("./index.html"))))
    );
    return;
  }

  // resto same-origin: cache-first con revalidación en background.
  // OJO: match dentro del cache actual — caches.match() global cruzaba
  // versiones y servia assets viejos de caches ya obsoletos
  e.respondWith(
    caches.open(CACHE).then(cache => cache.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => {
        if (r.ok) { const cp = r.clone(); cache.put(e.request, cp); }
        return r;
      }).catch(() => hit);
      return hit || net;
    }))
  );
});

// ---- web push: el digest del sweep despierta al dispositivo ----
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || "PriceWatch", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "badge.png",
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
