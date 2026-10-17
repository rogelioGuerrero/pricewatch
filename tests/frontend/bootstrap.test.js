"use strict";
// bootstrap.test.js — evalúa el <script> inline REAL de
// scripts/template.html (el loader de data.json + módulos).
// Regresión: los módulos podían agregarse antes de que ejecutaran los
// CDN defer (echarts/appwrite) → AW.ok quedaba false para siempre.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("node:vm");
const { makeCtx, DEMO_D } = require("./harness.js");

const HTML = fs.readFileSync(
  path.join(__dirname, "..", "..", "scripts", "template.html"), "utf8");
const INLINE = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
const MODS = ["js/state.js", "js/siman.js", "js/sync.js",
              "js/render.js", "js/app.js"];
const tick = () => new Promise(r => setImmediate(r));

// corre el bootstrap con fetch/data stubs; devuelve lo anexado a <head>
function runBootstrap({ readyState = "loading", fail = false } = {}) {
  const ctx = makeCtx();
  const doc = ctx.__doc;
  doc.readyState = readyState;
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
    return Promise.resolve({ ok: true, json: () => Promise.resolve(DEMO_D) });
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
  assert.deepEqual(appended, MODS, "los 5 módulos en orden");
  await done;
  assert.equal(doc.getElementById("boot"), null, "boot removido");
  assert.deepEqual(ctx.__netCalls, ["data.json"], "solo data.json");
});

test("readyState distinto de loading no espera el evento", async () => {
  const { appended, done } = runBootstrap({ readyState: "complete" });
  await done;
  assert.deepEqual(appended, MODS);
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
