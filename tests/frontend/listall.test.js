"use strict";
// listall.test.js — paginacion por cursor de sync.js listAll().
// Regresion: limit(500) sin cursor devolvia solo la primera pagina —
// el merge leia el resto como "borrado remoto" y vaciaba favs/compras
// locales. Requisito: all-or-nothing, cursor con avance forzado.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, APPWRITE_STUB, vm } = require("./harness.js");

// evalua solo sync.js (basta para listAll) con AW.dbs sustituido por
// el mock del test — Appwrite real jamas se toca
function ctxSync(listRows) {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB });
  boot(ctx, ["sync.js"]);
  ctx.__dbs = { listRows };
  vm.runInContext("AW.dbs = __dbs", ctx);
  return ctx;
}

const mk = n => ({ $id: "r" + String(n).padStart(4, "0"), sku: "s" + n });
const page = (from, n) => Array.from({ length: n }, (_, i) => mk(from + i));
const hasCursor = queries => queries.find(q => q.q === "after");

test(">500 filas: devuelve TODAS las paginas con cursorAfter", async () => {
  const calls = [];
  const ctx = ctxSync(async ({ queries }) => {
    calls.push(queries);
    const after = hasCursor(queries);
    return { rows: after ? page(500, 120) : page(0, 500) };
  });
  const rows = await vm.runInContext("listAll('favs')", ctx);
  assert.equal(rows.length, 620);
  assert.equal(rows[0].$id, "r0000");
  assert.equal(rows[619].$id, "r0619");
  assert.equal(calls.length, 2);
  // orden estable por $id y cursor = ultimo id de la pagina anterior
  assert.deepEqual(calls[0].find(q => q.q === "asc"), { q: "asc", f: "$id" });
  assert.deepEqual(calls[0].find(q => q.q === "limit"), { q: "limit", n: 500 });
  assert.deepEqual(hasCursor(calls[1]), { q: "after", c: "r0499" });
});

test("pagina corta primera: una sola llamada", async () => {
  let n = 0;
  const ctx = ctxSync(async () => { n++; return { rows: page(0, 37) }; });
  const rows = await vm.runInContext("listAll('favs')", ctx);
  assert.equal(rows.length, 37);
  assert.equal(n, 1);
});

test("exactamente 500: la pagina vacia terminal cierra el loop", async () => {
  let n = 0;
  const ctx = ctxSync(async ({ queries }) => {
    n++;
    return { rows: hasCursor(queries) ? [] : page(0, 500) };
  });
  const rows = await vm.runInContext("listAll('favs')", ctx);
  assert.equal(rows.length, 500);
  assert.equal(n, 2);
});

test("una pagina que falla rechaza TODO — nunca filas parciales", async () => {
  const ctx = ctxSync(async ({ queries }) => {
    if (hasCursor(queries)) throw new Error("boom-red");
    return { rows: page(0, 500) };
  });
  await assert.rejects(vm.runInContext("listAll('favs')", ctx), /boom-red/);
});

test("primera pagina que falla tambien rechaza", async () => {
  const ctx = ctxSync(async () => { throw new Error("offline"); });
  await assert.rejects(vm.runInContext("listAll('favs')", ctx), /offline/);
});

test("cursor estancado (misma ultima $id) rechaza — progreso obligatorio", async () => {
  const ctx = ctxSync(async () => ({ rows: page(0, 500) })); // ignora cursor
  await assert.rejects(vm.runInContext("listAll('favs')", ctx),
    /cursor sin avance/);
});

test("fila sin $id en el borde de pagina rechaza", async () => {
  const ctx = ctxSync(async ({ queries }) => {
    if (hasCursor(queries)) return { rows: [] };
    const rows = page(0, 500);
    rows[499] = { sku: "sin-id" };
    return { rows };
  });
  await assert.rejects(vm.runInContext("listAll('favs')", ctx),
    /cursor sin avance/);
});
