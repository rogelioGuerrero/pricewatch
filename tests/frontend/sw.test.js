"use strict";
// sw.test.js — ejecuta docs/sw.js real contra caches/clients falsos.
// v28: assets ?v=NN inmutables (sin revalidacion en background),
// data.json valida el CUERPO antes de pisar el cache y la copia
// guardada se sirve marcada con X-PriceWatch-Cache; la instalacion
// valida el dataset precacheado y jamas borra caches ajenos/viejos.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("node:vm");

const SW = fs.readFileSync(
  path.join(__dirname, "..", "..", "docs", "sw.js"), "utf8");
const CACHE = /const CACHE = "([^"]+)"/.exec(SW)[1];
const CORE = /const CORE = \[([\s\S]*?)\];/.exec(SW)[1]
  .match(/"([^"]+)"/g).map(s => s.slice(1, -1));

// dataset valido minimo segun el predicado compartido sw/bootstrap
const DATA = { generated: "2026-11-12",
  products: { a: {} }, series: { a: [["2026-11-12", 100, 1]] },
  agg: { a: {} }, clubs: {}, events: [], ofertas: [],
  siman: { items: [], events: [] } };
const dataResp = (d = DATA) => new Response(JSON.stringify(d),
  { status: 200, headers: { "content-type": "application/json" } });
// las llaves de cache canonicas como la API real: "./x" y la URL
// absoluta del request apuntan a la misma entrada
const keyOf = r => new URL(
  typeof r === "string" ? r : r.url, "http://pw.test/").href;
const tick = () => new Promise(r => setImmediate(r));

function makeSW({ store = {}, net = null, source = SW } = {}) {
  // el store semilla entra con llaves ya canonicas (el fixture puede
  // escribir rutas relativas igual que las entradas CORE)
  for (const m of Object.values(store))
    if (m instanceof Map)
      for (const [k, v] of [...m]) { m.delete(k); m.set(keyOf(k), v); }
  const log = [];
  const listeners = {};
  const ctx = {
    console, URL, Response, Headers,
    location: { origin: "http://pw.test" },
    fetch: net || (() => Promise.reject(new Error("sin red en tests"))),
    caches: {
      open: n => Promise.resolve({
        add: u => Promise.resolve((store[n] ||= new Map()).set(u, u)),
        // addAll ATOMICO igual que el real: si un asset falta no queda
        // nada precacheado (la instalacion aborta y el SW viejo sigue).
        // Cada URL queda como Response real: data.json con cuerpo JSON
        addAll: urls => {
          if (ctx.__addAllFails) return Promise.reject(new Error("404"));
          const m = store[n] ||= new Map();
          urls.forEach(u => m.set(keyOf(u), u.includes("data.json")
            ? dataResp(ctx.__installData || DATA)
            : new Response("/* " + u + " */")));
          return Promise.resolve();
        },
        // la API real clona: put guarda una copia y match devuelve una
        // — consumir el hit jamas agota la entrada almacenada
        put: (req, r) => ctx.__putFails
          ? Promise.reject(new Error("quota llena"))
          : Promise.resolve((store[n] ||= new Map()).set(keyOf(req),
              r && typeof r.clone === "function" ? r.clone() : r)),
        match: req => {
          const v = (store[n] || new Map()).get(keyOf(req));
          return Promise.resolve(
            v && typeof v.clone === "function" ? v.clone() : v);
        },
      }),
      keys: () => Promise.resolve(Object.keys(store)),
      delete: k => { log.push("del:" + k); delete store[k];
                     return Promise.resolve(true); },
      match: () => Promise.resolve(undefined),
    },
    clients: {
      claim: () => { log.push("claim"); return Promise.resolve(); },
      matchAll: () => Promise.resolve([]),
      openWindow: () => Promise.resolve(),
    },
    registration: { showNotification: () => Promise.resolve() },
    skipWaiting: () => { log.push("skipWaiting"); },
  };
  ctx.self = ctx;
  ctx.addEventListener = (t, f) => { (listeners[t] ||= []).push(f); };
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: "docs/sw.js" });
  const fire = (t, ev = {}) => {
    for (const f of listeners[t] || []) f.call(ctx, ev);
    return ev.wait || ev.rsp || Promise.resolve();
  };
  return { ctx, store, log, fire };
}
const waitEv = () => ({ waitUntil(p) { this.wait = p; } });
const fetchEv = req => ({ request: req,
                          respondWith(p) { this.rsp = p; } });
const dataReq = () => ({ method: "GET", url: "http://pw.test/data.json",
                         mode: "cors" });

test("activate borra solo caches pricewatch viejos", async () => {
  const { store, log, fire } = makeSW({ store: {
    [CACHE]: new Map([["x", 1]]),
    "pricewatch-v20": new Map(), "pricewatch-v23": new Map(),
    "otro-proyecto": new Map(), "pwajeno-x": new Map(),
  } });
  await fire("activate", waitEv());
  assert.ok(store[CACHE], "el cache actual sobrevive");
  assert.ok(store["otro-proyecto"], "cache ajeno intacto");
  assert.ok(store["pwajeno-x"], "prefijo ajeno intacto");
  assert.ok(!("pricewatch-v20" in store), "v20 borrado");
  assert.ok(!("pricewatch-v23" in store), "v23 borrado");
});

test("clients.claim corre DESPUES de borrar, dentro del waitUntil", async () => {
  const { log, fire } = makeSW({ store: {
    [CACHE]: new Map(), "pricewatch-v10": new Map() } });
  await fire("activate", waitEv());
  const lastDel = log.lastIndexOf("del:pricewatch-v10");
  assert.ok(lastDel >= 0 && log.indexOf("claim") > lastDel,
    `claim tras el delete: ${log}`);
});

test("install precarga el shell completo y valida el dataset", async () => {
  const { store, log, fire } = makeSW();
  await fire("install", waitEv());
  assert.equal(store[CACHE].size, CORE.length);
  assert.ok(store[CACHE].has(keyOf("./data.json")));
  assert.ok(store[CACHE].has(keyOf("./js/app.js?v=28")));
  assert.ok(log.includes("skipWaiting"), "clama tras validar todo");
});

test("data.json valido: cachea y devuelve el cuerpo legible", async () => {
  const net = { ...DATA, generated: "2026-11-13" };
  const { store, fire } = makeSW({
    net: () => Promise.resolve(dataResp(net)) });
  const r = await fire("fetch", fetchEv(dataReq()));
  assert.equal((await r.json()).generated, "2026-11-13",
    "el cuerpo de red se lee tras la validacion");
  assert.ok(!r.headers.get("x-pricewatch-cache"), "red sin marca");
  const cached = store[CACHE].get("http://pw.test/data.json");
  assert.ok(cached, "la respuesta quedo cacheada");
  assert.equal((await cached.json()).generated, "2026-11-13",
    "la copia cacheada es la misma que se sirvio");
});

test("data.json: JSON truncado 200 no pisa la copia buena", async () => {
  const store = { [CACHE]: new Map(
    [["http://pw.test/data.json", dataResp()]]) };
  const { fire } = makeSW({ store,
    net: () => Promise.resolve(new Response('{"products":{"a":',
      { status: 200, headers: { "content-type": "application/json" } })) });
  const r = await fire("fetch", fetchEv(dataReq()));
  assert.equal(r.headers.get("x-pricewatch-cache"), "1",
    "la copia guardada se sirve marcada");
  assert.equal((await r.json()).generated, "2026-11-12",
    "el cuerpo servido es el de la copia buena");
});

test("data.json: esquema invalido jamas entra al cache", async () => {
  const bads = [
    ["otro esquema", { foo: 1 }],
    ["products array", { ...DATA, products: [] }],
    ["sin agg", { ...DATA, agg: null }],
    ["sin clubs", { ...DATA, clubs: "x" }],
    ["serie corta", { ...DATA, series: { a: [["2026-11-12"]] } }],
    ["serie precio NaN", { ...DATA, series: { a: [["2026-11-12", "x", 1]] } }],
    ["generated invalida", { ...DATA, generated: "ayer" }],
    ["generated 30-feb", { ...DATA, generated: "2026-02-30" }],
    ["events no-mapa", { ...DATA, events: [1, 2] }],
    ["ofertas no-mapa", { ...DATA, ofertas: ["x"] }],
    ["siman items malos", { ...DATA, siman: { items: [3], events: [] } }],
  ];
  for (const [name, d] of bads) {
    const good = dataResp();
    const store = { [CACHE]: new Map(
      [["http://pw.test/data.json", good]]) };
    const { fire } = makeSW({ store,
      net: () => Promise.resolve(dataResp(d)) });
    const r = await fire("fetch", fetchEv(dataReq()));
    assert.equal(r.headers.get("x-pricewatch-cache"), "1", name);
    assert.equal((await r.json()).generated, "2026-11-12", name);
    assert.equal(store[CACHE].get(keyOf("http://pw.test/data.json")),
      good, `${name}: la copia buena sigue intacta`);
  }
});

test("data.json: 503 y offline caen a la copia marcada", async () => {
  for (const net of [
      () => Promise.resolve(new Response("err", { status: 503 })),
      () => Promise.reject(new Error("offline"))]) {
    const store = { [CACHE]: new Map(
      [["http://pw.test/data.json", dataResp()]]) };
    const { fire } = makeSW({ store, net });
    const r = await fire("fetch", fetchEv(dataReq()));
    assert.equal(r.headers.get("x-pricewatch-cache"), "1");
    assert.equal((await r.json()).generated, "2026-11-12");
  }
});

test("data.json: cache lleno no impide servir la red valida", async () => {
  const { ctx, fire } = makeSW({
    net: () => Promise.resolve(dataResp()) });
  ctx.__putFails = true;
  const r = await fire("fetch", fetchEv(dataReq()));
  assert.equal((await r.json()).generated, "2026-11-12",
    "la respuesta de red se sirve aunque put falle");
  assert.ok(!r.headers.get("x-pricewatch-cache"));
});

test("data.json: ni red ni copia => respuesta de error honesta", async () => {
  const { fire } = makeSW({
    net: () => Promise.reject(new Error("offline")) });
  const r = await fire("fetch", fetchEv(dataReq()));
  assert.equal(r.status, 0, "Response.error() — el bootstrap decide");
});

test("navegación offline: request cacheado y fallback a ./index.html", async () => {
  const { fire } = makeSW({ store: {
    [CACHE]: new Map([["http://pw.test/x", "PAGINA"],
                      ["./index.html", "SHELL"]]),
  } });
  const hit = fetchEv({ method: "GET", url: "http://pw.test/x",
                        mode: "navigate" });
  assert.equal(await fire("fetch", hit), "PAGINA");
  const miss = fetchEv({ method: "GET", url: "http://pw.test/nuevo",
                         mode: "navigate" });
  assert.equal(await fire("fetch", miss), "SHELL");
});

test("install atomico: un asset faltante aborta SIN cache parcial", async () => {
  const { ctx, store, log, fire } = makeSW({ store: {
    "pricewatch-v20": new Map([["./data.json", dataResp()]]) } });
  ctx.__addAllFails = true;
  await assert.rejects(fire("install", waitEv()),
    "la instalacion falla entera");
  assert.ok(!store[CACHE], "no queda cache nuevo a medias");
  assert.ok(store["pricewatch-v20"], "el release viejo no se toca");
  assert.ok(!log.includes("skipWaiting"));
});

test("install: dataset invalido aborta y solo limpia el cache nuevo", async () => {
  const { ctx, store, log, fire } = makeSW({ store: {
    "pricewatch-v20": new Map([["./data.json", dataResp()]]),
    "otro-proyecto": new Map([["./data.json", dataResp()]]) } });
  ctx.__installData = { generated: "ayer", products: "mal" };
  await assert.rejects(fire("install", waitEv()));
  assert.ok(!store[CACHE], "el cache v28 fallido se borra");
  assert.ok(store["pricewatch-v20"], "release viejo preservado");
  assert.ok(store["otro-proyecto"], "cache ajeno preservado");
  assert.ok(log.includes("del:" + CACHE), "solo se borro v28");
  assert.ok(!log.includes("skipWaiting"), "nunca clamo el control");
});

test("navegación: 5xx cae al snapshot, no muestra el error", async () => {
  const { fire } = makeSW({
    store: { [CACHE]: new Map([["http://pw.test/x", "PAGINA"]]) },
    net: () => Promise.resolve({ ok: false, status: 503 }),
  });
  const ev = fetchEv({ method: "GET", url: "http://pw.test/x",
                       mode: "navigate" });
  assert.equal(await fire("fetch", ev), "PAGINA");
});

test("asset versionado: hit inmutable, cero revalidacion", async () => {
  let calls = 0;
  const { fire } = makeSW({
    store: { [CACHE]: new Map(
      [["http://pw.test/js/app.js?v=28", new Response("/* v28 */")]]) },
    net: () => { calls++;
                 return Promise.resolve(new Response("/* red */")); } });
  const r = await fire("fetch", fetchEv({ method: "GET",
    url: "http://pw.test/js/app.js?v=28", mode: "cors" }));
  assert.equal(await r.text(), "/* v28 */");
  await tick();
  assert.equal(calls, 0, "un hit versionado nunca toca la red");
});

test("asset versionado: miss baja de red y cachea para el release", async () => {
  const { store, fire } = makeSW({
    net: () => Promise.resolve(new Response("/* nuevo */")) });
  const ev = fetchEv({ method: "GET",
    url: "http://pw.test/js/app.js?v=28", mode: "cors" });
  const r = await fire("fetch", ev);
  assert.equal(await r.text(), "/* nuevo */");
  const cached = store[CACHE].get(keyOf("./js/app.js?v=28"));
  assert.ok(cached, "la bajada queda cacheada en v28");
});

test("legacy: worker viejo sirve bare viejo; ?v=28 no colisiona", async () => {
  // el bug real era con el worker VIEJO activo: un HTML nuevo pedia
  // las MISMAS URLs bare y el cache-first generico del v20 devolvia
  // los assets viejos (HTML nuevo + JS/CSS viejos = mezcla rota).
  // Este mock corre el MISMO fuente del SW con el release renombrado
  // a v20: el handler cache-first generico no cambio entre releases.
  const LEGACY = SW.replace('const CACHE = "pricewatch-v28"',
      'const CACHE = "pricewatch-v20"')
    .replace('const VER = "28"', 'const VER = "20"')
    .replaceAll("?v=28", "?v=20");
  const { fire } = makeSW({ source: LEGACY,
    store: { "pricewatch-v20": new Map([
      ["./js/app.js", new Response("JS-VIEJO")],
      ["./styles.css", new Response("CSS-VIEJO")]]) },
    net: () => Promise.resolve(new Response("/* NUEVO */")) });
  // reproduce el bug: con el worker viejo activo, los URLs bare del
  // HTML viejo reciben el contenido cacheado, no el archivo actual
  for (const [u, want] of [
      ["http://pw.test/js/app.js", "JS-VIEJO"],
      ["http://pw.test/styles.css", "CSS-VIEJO"]]) {
    const r = await fire("fetch", fetchEv(
      { method: "GET", url: u, mode: "cors" }));
    assert.equal(await r.text(), want,
      `bare ${u}: reproduce el mezclado bajo el worker v20`);
  }
  // el fix: el HTML nuevo pide ?v=28 — llave que NO existe en el
  // cache v20, asi que el mismo handler generico baja de la red
  for (const u of ["http://pw.test/js/app.js?v=28",
                   "http://pw.test/styles.css?v=28"]) {
    const r = await fire("fetch", fetchEv(
      { method: "GET", url: u, mode: "cors" }));
    assert.equal(await r.text(), "/* NUEVO */",
      `versionado ${u}: ninguna llave vieja colisiona`);
  }
});

test("precache real: install -> offline sirve copia marcada, dos veces", async () => {
  // el camino completo: addAll precachea data.json -> la red muere ->
  // el fetch cae a la copia guardada marcada — y el match clonado
  // deja la entrada legible para la siguiente lectura
  const { store, fire } = makeSW();
  await fire("install", waitEv());
  for (let i = 1; i <= 2; i++) {
    const r = await fire("fetch", fetchEv({ method: "GET",
      url: "http://pw.test/data.json", mode: "cors" }));
    assert.equal(r.headers.get("x-pricewatch-cache"), "1",
      `lectura ${i}: marcada como copia`);
    assert.equal((await r.json()).generated, DATA.generated,
      `lectura ${i}: cuerpo valido`);
  }
  const stored = store[CACHE].get(keyOf("./data.json"));
  assert.ok(stored, "la entrada precacheada existe");
  assert.equal((await stored.json()).generated, DATA.generated,
    "el cuerpo almacenado no se consumio en las lecturas");
});

test("sin red ni cache: pagina offline legible, nunca en blanco", async () => {
  const { fire } = makeSW({
    net: () => Promise.reject(new Error("offline")) });
  const ev = fetchEv({ method: "GET", url: "http://pw.test/x",
                       mode: "navigate" });
  const r = await fire("fetch", ev);
  assert.match(await r.text(), /Sin conexión/);
});

test("nada de red durante install/activate ni requests ajenos", async () => {
  let netCalls = 0;
  const { fire } = makeSW({
    store: { [CACHE]: new Map(), "pricewatch-v1": new Map() },
    net: () => { netCalls++; return Promise.reject(new Error("x")); },
  });
  await fire("install", waitEv());
  await fire("activate", waitEv());
  const cross = fetchEv({ method: "GET", url: "https://otro.dev/x",
                          mode: "cors" });
  assert.equal(await fire("fetch", cross), undefined);
  assert.equal(netCalls, 0, "ningún fetch real debió dispararse");
});

test("release 28: toda URL local js/css del template esta en CORE", () => {
  const TPL = fs.readFileSync(path.join(__dirname, "..", "..",
    "scripts", "template.html"), "utf8");
  const head = /<head>([\s\S]*?)<\/head>/.exec(TPL)[1];
  const urls = [...head.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map(m => m[1]).filter(u => /\.(?:js|css)(?:\?|$)/.test(u));
  const inline = /<script>([\s\S]*?)<\/script>/.exec(TPL)[1];
  const mods = [...inline.matchAll(/"(js\/[^"]+)"/g)].map(m => m[1]);
  assert.ok(urls.length >= 10, `paridad: ${urls.length} urls locales`);
  assert.ok(mods.length >= 7, `loader: ${mods.length} modulos`);
  for (const u of [...urls, ...mods]) {
    assert.ok(u.includes("?v=28"), `sin version de release: ${u}`);
    assert.ok(CORE.includes("./" + u), `${u} falta en CORE del SW`);
  }
  for (const c of CORE.filter(x => /\.(?:js|css)(?:\?|$)/.test(x)))
    assert.ok(c.includes("?v=28"), `CORE sin version: ${c}`);
  assert.equal(CACHE, "pricewatch-v28");
});
