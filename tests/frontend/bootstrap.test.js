"use strict";
// bootstrap.test.js — evalúa el <script> inline REAL de
// scripts/template.html (el loader de data.json + módulos).
// Regresión: los módulos podían agregarse antes de que ejecutaran los
// CDN defer (echarts/appwrite) → AW.ok quedaba false para siempre.
// v28: el fallback offline itera SOLO caches pricewatch-* preferiendo
// el release vigente, valida el cuerpo con el mismo predicado del SW
// y confiesa X-PriceWatch-Cache cuando el SW sirvio la copia.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("node:vm");
const { makeCtx, DEMO_D } = require("./harness.js");

const HTML = fs.readFileSync(
  path.join(__dirname, "..", "..", "scripts", "template.html"), "utf8");
const INLINE = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
const MODS = ["js/storage.js?v=28", "js/freshness.js?v=28",
              "js/state.js?v=28", "js/siman.js?v=28", "js/sync.js?v=28",
              "js/render.js?v=28", "js/app.js?v=28"];
const tick = () => new Promise(r => setImmediate(r));
const resp = (d, hdrs = {}) => ({ ok: true,
  json: () => Promise.resolve(d),
  headers: { get: k => hdrs[k] ?? null } });

// CacheStorage falso: registra que namespaces se abrieron (probar que
// los ajenos jamas se consultan)
const cachesStub = (store, opened) => ({
  keys: () => Promise.resolve(Object.keys(store)),
  open: n => { opened.push(n);
    return Promise.resolve(store[n]
      ? { match: u => Promise.resolve(store[n].get(u)) }
      : undefined); },
});

// corre el bootstrap con fetch/data stubs; devuelve lo anexado a <head>
function runBootstrap({ readyState = "loading", fail = false,
                        headers, caches } = {}) {
  const ctx = makeCtx();
  const doc = ctx.__doc;
  doc.readyState = readyState;
  if (caches) ctx.caches = caches;
  const appended = [];
  const realAppend = doc.head.appendChild.bind(doc.head);
  doc.head.appendChild = c => {
    appended.push(c.src);
    const r = realAppend(c);
    queueMicrotask(() => { if (c.onload) c.onload(); });
    return r;
  };
  let dcl = null;
  const realAdd = doc.addEventListener.bind(doc);
  doc.addEventListener = (t, f) => {
    if (t === "DOMContentLoaded") dcl = f;
    return realAdd(t, f);
  };
  ctx.fetch = u => {
    ctx.__netCalls.push(String(u));
    if (fail) return Promise.reject(new Error("sin señal"));
    return Promise.resolve(resp(DEMO_D, headers));
  };
  const done = vm.runInContext(INLINE, ctx, { filename: "inline-boot" });
  return { ctx, doc, appended, done, fireDCL: () => dcl && dcl() };
}

test("módulos esperan DOMContentLoaded (defer CDN) y cargan en orden",
async () => {
  const { ctx, doc, appended, done, fireDCL } = runBootstrap();
  await tick(); await tick();
  assert.equal(ctx.D, DEMO_D, "data.json ya llegó");
  assert.deepEqual(appended, [], "ningún módulo antes de DCL");
  fireDCL();
  await tick(); await tick(); await tick();
  assert.deepEqual(appended, MODS, "los módulos versionados en orden");
  await done;
  assert.equal(doc.getElementById("boot"), null, "boot removido");
  assert.deepEqual(ctx.__netCalls, ["data.json"], "solo data.json");
  assert.equal(ctx.DATA_FROM_CACHE, false, "red fresca no marcada");
});

test("readyState distinto de loading no espera el evento", async () => {
  const { appended, done } = runBootstrap({ readyState: "complete" });
  await done;
  assert.deepEqual(appended, MODS);
});

test("copia servida por el SW (X-PriceWatch-Cache) se confiesa", async () => {
  const { ctx, done } = runBootstrap({ readyState: "complete",
    headers: { "X-PriceWatch-Cache": "1" } });
  await done;
  assert.equal(ctx.D, DEMO_D);
  assert.equal(ctx.DATA_FROM_CACHE, true,
    "el datastrip puede anunciar 'copia guardada'");
});

test("falla de red muestra error de boot y no agrega módulos", async () => {
  const { doc, appended, done, fireDCL } = runBootstrap({ fail: true });
  await done;
  fireDCL();   // aunque llegue el evento no hay nada que cargar
  await tick();
  assert.deepEqual(appended, []);
  const boot = doc.getElementById("boot");
  assert.ok(boot);
  assert.match(boot.textContent, /No se pudieron cargar/);
});

test("offline: fallback valida caches propios, salta copias invalidas", async () => {
  const opened = [];
  const store = {
    // la copia mas nueva esta truncada: NO tapa la buena mas vieja
    "pricewatch-v28": new Map([["data.json",
      { json: () => Promise.reject(new SyntaxError("truncado")) }]]),
    "pricewatch-v20": new Map([["data.json",
      { json: () => Promise.resolve({ ...DEMO_D,
        generated: "2026-11-04" }) }]]),
    // un cache ajeno con dato valido JAMAS se consulta
    "otro-proyecto": new Map([["data.json",
      { json: () => Promise.resolve(DEMO_D) }]]),
  };
  const { ctx, appended, done } = runBootstrap({ fail: true,
    readyState: "complete", caches: cachesStub(store, opened) });
  await done;
  assert.equal(ctx.D.generated, "2026-11-04",
    "la copia valida mas vieja gana sobre la invalida nueva");
  assert.equal(ctx.DATA_FROM_CACHE, true, "confiesa copia guardada");
  assert.deepEqual(appended, MODS, "modulos cargan con la copia");
  assert.ok(!opened.includes("otro-proyecto"),
    "cache ajeno nunca consultado: " + opened.join(","));
});

test("offline: esquema invalido en caches propios no se acepta", async () => {
  const opened = [];
  const store = {
    "pricewatch-v28": new Map([["data.json",
      { json: () => Promise.resolve({ html: "<b>error proxy</b>" }) }]]),
    "otro-proyecto": new Map([["data.json",
      { json: () => Promise.resolve({ ...DEMO_D,
        generated: "2020-01-01" }) }]]),
  };
  const { ctx, doc, appended, done } = runBootstrap({ fail: true,
    caches: cachesStub(store, opened) });
  await done;
  // el harness precarga D=DEMO_D: si un cache se hubiera consultado
  // mal, la copia ajena (2020-01-01) o el esquema roto lo pisaria
  assert.equal(ctx.D, DEMO_D, "no se piso el dataset ni se invento");
  assert.notEqual(ctx.DATA_FROM_CACHE, true,
    "nunca se declaro copia guardada");
  assert.deepEqual(appended, []);
  assert.match(doc.getElementById("boot").textContent,
    /No se pudieron cargar/);
  assert.ok(doc.getElementById("boot").textContent
      .includes("Reintentar"), "boton de reintento visible");
  assert.ok(!opened.includes("otro-proyecto"),
    "el dato valido del cache ajeno no se usa");
});
