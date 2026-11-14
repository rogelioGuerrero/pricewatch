// PriceWatch SV — navegación network-first (abrir la app trae la
// versión fresca); sin señal cae al último snapshot cacheado.
const CACHE = "pricewatch-v28";
const VER = "28";
// shell completa precacheada: si el SW se actualiza y el usuario abre
// offline antes de navegar online, los js/css ya estan en el cache
// nuevo (antes solo sobrevivian si ya se habian pedido). Los assets
// llevan ?v=NN del release: el HTML nuevo pide URLs ?v=NN que NO
// colisionan con las llaves bare que un cache viejo pudo dejar —
// publicar un asset cambiado exige subir el numero de shell (CACHE),
// nunca pisar ?v=NN en caliente. OJO: el servidor estatico sirve el
// archivo ACTUAL para cualquier ?v= — una llave versionada no
// retiene contenido historico por release
const CORE = ["./", "./index.html", "./manifest.webmanifest",
             "./data.json", "./styles.css?v=28",
             "./vendor/echarts.min.js?v=28",
             "./vendor/appwrite-sdk.js?v=28",
             "./js/storage.js?v=28", "./js/freshness.js?v=28",
             "./js/state.js?v=28", "./js/siman.js?v=28",
             "./js/sync.js?v=28", "./js/render.js?v=28",
             "./js/app.js?v=28"];

// esquema del dataset compartido con el bootstrap inline: un payload
// que no lo pasa jamas entra al cache ni reemplaza una copia buena.
// Los campos privados quedan fuera a proposito: el builder es dueño
// de la privacidad y el estado de cliente no nace de D.mis
const validData = d => {
  const map = x => x != null && typeof x === "object" && !Array.isArray(x);
  const recordList = x => Array.isArray(x) && x.every(map);
  const day = s => typeof s === "string" && (s === "" ||
    (/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s))
      && new Date(Date.parse(s)).toISOString().slice(0, 10) === s));
  return map(d) && ["products", "series", "agg", "clubs"].every(k => map(d[k]))
    && Object.values(d.products).every(map) && Object.values(d.agg).every(map)
    && Object.values(d.series).every(rows => Array.isArray(rows) && rows.every(r =>
      Array.isArray(r) && r.length >= 3 && typeof r[0] === "string"
      && (r[1] == null || Number.isFinite(r[1]))))
    && recordList(d.events) && recordList(d.ofertas) && day(d.generated)
    && (d.siman == null || (map(d.siman)
      && recordList(d.siman.items) && recordList(d.siman.events)));
};

// copia guardada de data.json en el cache actual, solo si su CUERPO
// pasa el esquema. Un cache con CacheStorage roto/lleno no tira el
// servicio: los fallos de open/match se tragan y se sigue con la red
const cachedData = req => caches.open(CACHE).then(async c => {
  const hit = await c.match(req);
  if (!hit) return null;
  try {
    const d = await hit.clone().json();
    return validData(d) ? hit : null;
  } catch (_) { return null; }
}).catch(() => null);
// la copia se marca: el bootstrap lee X-PriceWatch-Cache para anunciar
// "copia guardada" en el datastrip. Se clona — la almacenada jamas se
// consume ni se muta
const cacheHit = hit => {
  const hs = new Headers(hit.headers);
  hs.set("X-PriceWatch-Cache", "1");
  return new Response(hit.clone().body,
    { status: hit.status, statusText: hit.statusText, headers: hs });
};

self.addEventListener("install", e => {
  // instalacion ATOMICA: addAll rechaza si cualquier asset falta —
  // el SW viejo (con su cache completa) sigue activo en vez de
  // quedar un cache nuevo a medias. El data.json precacheado tambien
  // se valida antes de clamar: una build con dataset roto no debe
  // tomar el control. Si algo falla se borra SOLO el cache v28 en
  // instalacion — los releases viejos quedan intactos
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE)
      .then(() => c.match("./data.json"))
      .then(hit => (hit ? hit.json() : Promise.reject(
          new Error("data.json no precacheado")))
        .then(d => {
          if (!validData(d)) throw new Error("data.json invalido");
        })))
      .then(() => self.skipWaiting())
      .catch(err => caches.delete(CACHE).then(() => { throw err; }))
  );
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
  // que cambia entre builds. El CUERPO se valida antes de pisar el
  // cache: JSON truncado, esquema equivocado, HTML de proxy con
  // content-type json — ninguno reemplaza la copia buena. 5xx, red
  // caida y basura valida-HTTP caen al snapshot marcado; si no hay
  // copia se devuelve la respuesta real (el bootstrap decide error)
  if (url.pathname.endsWith("data.json")) {
    e.respondWith(
      fetch(e.request).then(r =>
        (r.ok
          ? r.clone().json().then(d => {
              if (validData(d))
                // cache lleno/corrupto no bloquea: la red se sirve igual
                return caches.open(CACHE)
                  .then(c => c.put(e.request, r.clone()))
                  .then(() => r, () => r);
              return cachedData(e.request)
                .then(h => h ? cacheHit(h) : r);
            }, () => cachedData(e.request)
                .then(h => h ? cacheHit(h) : r))
          : cachedData(e.request).then(h => h ? cacheHit(h) : r))
      ).catch(() => cachedData(e.request)
        .then(h => h ? cacheHit(h) : Response.error()))
    );
    return;
  }

  // navegación: red primero, último snapshot si no hay señal o error
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then(r => {
        // clonar ANTES de devolverla: el callback del cache corre async
        // y para entonces el body ya se consumio (clone() fallaba)
        if (r.ok) { const cp = r.clone();
                    caches.open(CACHE).then(c => c.put(e.request, cp));
                    return r; }
        // 5xx: la copia guardada gana sobre el error de la red
        return caches.open(CACHE).then(c =>
          c.match(e.request).then(h => h || c.match("./index.html"))
            .then(h => h || r));
      }).catch(() => caches.open(CACHE).then(c =>
        c.match(e.request).then(h => h || c.match("./index.html"))
          // ni siquiera hay shell cacheado: aviso explicito, jamas
          // una pagina en blanco ni un error mudo del navegador
          .then(h => h || new Response(
            "<!doctype html><meta charset=utf-8><title>Sin conexión</title>"
            + "<body style='background:#0f1420;color:#e8ecf5;"
            + "font:16px system-ui;padding:2em;text-align:center'>"
            + "<h1>Sin conexión</h1><p>No hay copia guardada de "
            + "PriceWatch en este dispositivo.<br>Conecta a internet "
            + "y vuelve a intentar.</p>"))))
    );
    return;
  }

  // assets versionados (?v=28): un hit se sirve tal cual SIN
  // revalidacion en background — reescribir la entrada meteria el
  // archivo actual bajo una llave que el HTML que la pidio cree
  // inmutable. Un miss siempre resuelve a la red
  if (/\.(?:js|css)$/.test(url.pathname)
      && url.searchParams.get("v") === VER) {
    e.respondWith(
      caches.open(CACHE).then(c => c.match(e.request).then(hit => {
        if (hit) return hit;
        return fetch(e.request).then(r => {
          if (r.ok) return c.put(e.request, r.clone())
            .then(() => r, () => r);
          return r;
        });
      })).catch(() => fetch(e.request))
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
