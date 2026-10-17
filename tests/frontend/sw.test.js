"use strict";
// sw.test.js — ejecuta docs/sw.js real contra caches/clients falsos.
// Regresión: activate borraba TODOS los caches de CacheStorage — en
// GitHub Pages el origin de usuario se comparte entre proyectos y
// destruía caches ajenos. También: clients.claim() corría fuera del
// waitUntil (podía clamar antes de terminar el borrado).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("node:vm");

const SW = fs.readFileSync(
  path.join(__dirname, "..", "..", "docs", "sw.js"), "utf8");
const CACHE = /const CACHE = "([^"]+)"/.exec(SW)[1];
const CORE_N = /const CORE = \[([\s\S]*?)\];/.exec(SW)[1]
  .split(",").filter(x => x.includes('"')).length;
const keyOf = r => typeof r === "string" ? r : r.url;

function makeSW({ store = {}, net = null } = {}) {
  const log = [];
  const listeners = {};
  const ctx = {
    console, URL,
    location: { origin: "http://pw.test" },
    fetch: net || (() => Promise.reject(new Error("sin red en tests"))),
    caches: {
      open: n => Promise.resolve({
        add: u => Promise.resolve((store[n] ||= new Map()).set(u, u)),
        put: (req, r) => Promise.resolve(
          (store[n] ||= new Map()).set(keyOf(req), r)),
        match: req =>
          Promise.resolve((store[n] || new Map()).get(keyOf(req))),
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
  vm.runInContext(SW, ctx, { filename: "docs/sw.js" });
  const fire = (t, ev = {}) => {
    for (const f of listeners[t] || []) f.call(ctx, ev);
    return ev.wait || ev.rsp || Promise.resolve();
  };
  return { ctx, store, log, fire };
}
const waitEv = () => ({ waitUntil(p) { this.wait = p; } });
const fetchEv = req => ({ request: req,
                          respondWith(p) { this.rsp = p; } });

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

test("install precarga el shell completo en el cache actual", async () => {
  const { store, fire } = makeSW();
  await fire("install", waitEv());
  assert.equal(store[CACHE].size, CORE_N);
  assert.ok(store[CACHE].has("./data.json"));
});

test("data.json: sin señal cae al snapshot del cache ACTUAL", async () => {
  const { fire } = makeSW({ store: {
    [CACHE]: new Map([["http://pw.test/data.json", "SNAP"]]),
    "pricewatch-v1": new Map([["http://pw.test/data.json", "VIEJO"]]),
  } });
  const ev = fetchEv({ method: "GET", url: "http://pw.test/data.json",
                       mode: "cors" });
  assert.equal(await fire("fetch", ev), "SNAP");
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
