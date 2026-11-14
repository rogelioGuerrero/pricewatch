"use strict";
// sync.test.js — outbox durable, merge 3-vias y limites de cuenta de
// sync.js. Regresiones de la auditoria 2026-11-11 + rework:
// - compra borrada offline que resucitaba por la lectura remota vieja
// - delete fallido que perdia el reintento y resucitaba la fila
// - data local subida automaticamente a otra cuenta al loguear
// - compra duplicada por reintento con un segundo ID.unique
// - cambio de cuenta DURANTE un await (respuestas obsoletas no
//   confirman, no importan ni escriben en el namespace nuevo)
// - identidad de compra = rid/$id: dos compras identicas son filas
// Todo contra el mock Appwrite del harness — nunca red real.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, DEMO_D, APPWRITE_STUB, vm } =
  require("./harness.js");

const get = (ctx, expr) =>
  JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));

function context(stored = {}, data = DEMO_D, appwrite = APPWRITE_STUB) {
  const ctx = makeCtx({ stored, data, appwrite });
  boot(ctx);
  return ctx;
}
// simula recarga completa: mismo localStorage, ctx nuevo (los
// modulos re-evaluan y releen todo el estado persistido)
const reload = ctx => {
  const stored = Object.fromEntries(ctx.localStorage._mem);
  const ctx2 = makeCtx({ stored, data: ctx.D,
                         appwrite: ctx.__appwrite || APPWRITE_STUB });
  boot(ctx2);
  return ctx2;
};
// mock de tablas: semilla remota, registro de llamadas y fallos por
// tipo; fail.{create,update,delete,get,list} puede ser Error o fn.
// hooks deja promesas diferidas para probar carreras (kind->promise).
// `rows` queda capturado EN EL CLOSURE: una request del dueno viejo
// que responde tarde devuelve SUS filas (no las del mock nuevo) —
// reproducir la carrera real exige no releer ctx.__remote tras await
function db(ctx, rows, fail = {}, uid = "u1", hooks = {}) {
  ctx.__calls = [];
  ctx.__remote = rows;             // alias para inspeccion del test
  const mayFail = (k, a) => {
    const f = fail[k];
    if (!f) return;
    const v = typeof f === "function" ? f(a) : f;
    if (v) throw v instanceof Error ? v : new Error(String(v));
  };
  const wait = async k => { if (hooks[k]) await hooks[k](); };
  ctx.__dbs = {
    listRows: async ({ tableId, queries }) => {
      ctx.__calls.push({ op: "list", tableId });
      await wait("list");
      mayFail("list", tableId);
      const t = rows[tableId] || [];
      // cursor simple: cursorAfter devuelve las filas tras ese $id
      const cur = (queries || []).find(q => q && q.q === "after");
      const i = cur ? t.findIndex(r => r.$id === cur.c) : -1;
      const from = i < 0 ? (cur ? t.length : 0) : i + 1;
      return { rows: t.slice(from, from + 500) };
    },
    getRow: async a => {
      ctx.__calls.push({ op: "get", ...a });
      await wait("get");
      mayFail("get", a);
      const d = (rows[a.tableId] || []).find(r => r.$id === a.rowId);
      if (!d) { const e = new Error("no existe"); e.code = 404; throw e; }
      return d;
    },
    createRow: async a => {
      ctx.__calls.push({ op: "create", ...a });
      await wait("create");
      mayFail("create", a);
      const t = (rows[a.tableId] ||= []);
      if (t.some(r => r.$id === a.rowId)) {
        const e = new Error("dup"); e.code = 409; throw e;
      }
      t.push({ $id: a.rowId, ...a.data });
      return { $id: a.rowId };
    },
    updateRow: async a => {
      ctx.__calls.push({ op: "update", ...a });
      await wait("update");
      mayFail("update", a);
      const t = rows[a.tableId] || [];
      const i = t.findIndex(r => r.$id === a.rowId);
      if (i < 0) { const e = new Error("no existe"); e.code = 404; throw e; }
      Object.assign(t[i], a.data);
      return {};
    },
    deleteRow: async a => {
      ctx.__calls.push({ op: "delete", ...a });
      await wait("delete");
      mayFail("delete", a);
      const t = rows[a.tableId] || [];
      const i = t.findIndex(r => r.$id === a.rowId);
      if (i < 0) { const e = new Error("no existe"); e.code = 404; throw e; }
      t.splice(i, 1);
      return {};
    },
  };
  vm.runInContext("AW.dbs = __dbs", ctx);
  // mismo orden que doAuth: ligar namespace, rehidratar, user activo
  vm.runInContext(
    `AW.user = {$id:'${uid}', email:'${uid}@x.sv'};`
    + ` PWStore.activate('${uid}'); hydrateNS()`, ctx);
  return ctx;
}
const switchTo = (ctx, uid) =>
  vm.runInContext(
    `AW.user = {$id:'${uid}', email:'${uid}@x.sv'};`
    + ` PWStore.activate('${uid}'); hydrateNS()`, ctx);
// promesa diferida controlada manualmente: go resuelve, bad rechaza
const gate = () => { let go, bad;
                     const p = new Promise((res, rej) => {
                       go = res; bad = rej; });
                     return { p, go, bad }; };

test("compra borrada offline: sync intenta DELETE y no resucita", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-compras": "[]",
    "pw:user:u1:pw-sync-snap":
      JSON.stringify({ compras: ["111|2026-10-01|10"] }),
  });
  db(ctx, { compras: [{ $id: "p1", sku: "111", paid: 10,
                        date: "2026-10-01" }] });
  await vm.runInContext("syncAll()", ctx);
  const dels = ctx.__calls.filter(c => c.op === "delete");
  assert.equal(dels.length, 1, "se intento el borrado remoto");
  assert.equal(dels[0].rowId, "p1");
  assert.equal(get(ctx, "COMPRAS.length"), 0,
    "la lectura vieja que aun tenia la fila no la reimporto");
  await vm.runInContext("syncAll()", ctx);   // segundo sync: estable
  assert.equal(get(ctx, "COMPRAS.length"), 0);
  assert.equal(ctx.__remote.compras.length, 0);
});

test("dos compras identicas con rid distinto: borrar una deja la otra", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-compras": JSON.stringify([
      { sku: "111", paid: 10, date: "2026-10-01", rid: "p1" },
      { sku: "111", paid: 10, date: "2026-10-01", rid: "p2" }]),
    "pw:user:u1:pw-sync-snap":
      JSON.stringify({ compras: ["p1", "p2"] }),
  });
  const row = id => ({ $id: id, sku: "111", paid: 10,
                       date: "2026-10-01" });
  db(ctx, { compras: [row("p1"), row("p2")] });
  await vm.runInContext("syncAll()", ctx);
  assert.equal(get(ctx, "COMPRAS.length"), 2, "ambas sobreviven");
  // borro SOLO p2 (mismo tuple): la identidad es el rid, no el ckey
  await vm.runInContext(
    "(async () => { const i = COMPRAS.findIndex(c => c.rid === 'p2');"
    + " COMPRAS.splice(i,1); saveCompras();"
    + " await compraDown('p2'); })()", ctx);
  assert.equal(ctx.__remote.compras.length, 1);
  assert.equal(ctx.__remote.compras[0].$id, "p1");
  await vm.runInContext("syncAll()", ctx);
  const left = get(ctx, "COMPRAS");
  assert.equal(left.length, 1);
  assert.equal(left[0].rid, "p1", "p1 intacta, p2 no resucito");
  // recarga: las dos identidades siguen distinguidas
  const ctx2 = reload(ctx);
  db(ctx2, ctx.__remote);
  assert.equal(get(ctx2, "COMPRAS.length"), 1);
  assert.equal(get(ctx2, "COMPRAS[0].rid"), "p1");
});

test("fav delete fallido: tombstone persiste y el retry borra la fila", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-favs": '["111"]',
    "pw:user:u1:pw-sync-snap": JSON.stringify({ favs: ["111"] }),
  });
  db(ctx, { favs: [{ $id: "u1-111", sku: "111" }] },
     { delete: new Error("sin senal") });
  // mismo orden que toggleFav en la UI: local persiste primero,
  // luego la intencion remota entra al outbox
  await vm.runInContext(
    "(async () => { FAV.delete('111'); saveFavs();"
    + " await favDown('111'); })()", ctx);
  assert.equal(get(ctx, "[...FAV].length"), 0);
  assert.equal(ctx.__remote.favs.length, 1, "remoto aun tiene la fila");
  assert.equal(get(ctx, "OUTBOX.length"), 1,
    "la intencion quedo en el outbox (tombstone durable)");
  // recarga: el tombstone sigue ahi y el proximo sync lo reintenta
  const ctx2 = reload(ctx);
  db(ctx2, { favs: [{ $id: "u1-111", sku: "111" }] });
  assert.equal(get(ctx2, "OUTBOX.length"), 1, "tombstone tras reload");
  await vm.runInContext("syncAll()", ctx2);
  assert.equal(ctx2.__remote.favs.length, 0, "reintento borro la fila");
  assert.equal(get(ctx2, "[...FAV].length"), 0, "sin resurreccion");
  await vm.runInContext("syncAll()", ctx2);   // idempotente
  assert.equal(get(ctx2, "[...FAV].length"), 0);
  assert.equal(ctx2.__remote.favs.length, 0);
});

test("delete generico via outbox: watch y target sobreviven reload", async () => {
  // watch: fila remota existe, el delete falla una vez
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-siman-watch": '[{"q":"zapato","talla":"L"}]',
    "pw:user:u1:pw-sync-snap":
      JSON.stringify({ watch: ["zapato|L"] }),
  });
  const wid = await vm.runInContext("`u1-${h16('zapato|L')}`", ctx);
  db(ctx, { siman_watch: [{ $id: wid, q: "zapato", talla: "L",
                            filtro: "" }] },
     { delete: new Error("caido") });
  await vm.runInContext(
    "(async () => { SWATCH = []; saveSWatch();"
    + " await watchDown('zapato','L'); })()", ctx);
  assert.equal(ctx.__remote.siman_watch.length, 1);
  assert.equal(get(ctx, "OUTBOX.length"), 1);
  const ctx2 = reload(ctx);
  db(ctx2, { siman_watch: [{ $id: wid, q: "zapato", talla: "L",
                             filtro: "" }] });
  await vm.runInContext("syncAll()", ctx2);
  assert.equal(ctx2.__remote.siman_watch.length, 0);
  assert.deepEqual(get(ctx2, "SWATCH"), []);

  // target: mismo camino generico
  const ctx3 = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-targets": '{"111":500}',
    "pw:user:u1:pw-sync-snap": JSON.stringify({ targets: ["111"] }),
  });
  db(ctx3, { targets: [{ $id: "u1-111", sku: "111", target: 500 }] },
     { delete: new Error("caido") });
  await vm.runInContext(
    "(async () => { delete TARGETS['111']; saveTargets();"
    + " await tgtDel('111'); })()", ctx3);
  assert.equal(get(ctx3, "OUTBOX.length"), 1);
  const ctx4 = reload(ctx3);
  db(ctx4, { targets: [{ $id: "u1-111", sku: "111", target: 500 }] });
  await vm.runInContext("syncAll()", ctx4);
  assert.equal(ctx4.__remote.targets.length, 0);
  assert.deepEqual(get(ctx4, "TARGETS"), {});
});

test("compra: respuesta perdida + retry 409 = una sola fila, mismo rid", async () => {
  let idCalls = 0;
  const stub = { ...APPWRITE_STUB,
    ID: { unique: () => { idCalls++; return "rid-" + idCalls; } } };
  const ctx = makeCtx({ stored: { "pw-uid-hint": "u1" },
                        data: DEMO_D, appwrite: stub });
  boot(ctx);
  ctx.__appwrite = stub;
  let first = true;
  ctx.__calls = [];
  ctx.__remote = { compras: [] };
  ctx.__dbs = {
    listRows: async ({ tableId }) =>
      ({ rows: ctx.__remote[tableId] || [] }),
    getRow: async a => {
      const d = (ctx.__remote[a.tableId] || [])
        .find(r => r.$id === a.rowId);
      if (!d) { const e = new Error("nf"); e.code = 404; throw e; }
      return d;
    },
    createRow: async a => {
      ctx.__calls.push({ op: "create", ...a });
      if (first) {
        first = false;
        // la fila SI se creo pero la respuesta "se perdio"
        ctx.__remote.compras.push({ $id: a.rowId, ...a.data });
        throw new Error("timeout de respuesta");
      }
      const e = new Error("dup"); e.code = 409; throw e;
    },
    updateRow: async () => ({}),
    deleteRow: async () => ({}),
  };
  vm.runInContext(
    "AW.user = {$id:'u1'}; AW.dbs = __dbs;"
    + " PWStore.activate('u1'); hydrateNS()", ctx);
  const r = await vm.runInContext(
    "(async () => { const c = {sku:'111',paid:10,date:'2026-01-01'};"
    + " COMPRAS.push(c); const d = await compraUp(c);"
    + " return {rid:c.rid, pend:d.pending}; })()", ctx);
  assert.equal(r.rid, "rid-1", "rid estable asignado una vez");
  assert.equal(r.pend, true, "la respuesta perdida deja el op pendiente");
  assert.equal(ctx.__remote.compras.length, 1);
  // reload + retry: reusa el mismo rid, el 409 se VERIFICA y confirma
  // — jamas un segundo ID.unique ni una segunda fila remota
  const ctx2 = reload(ctx);
  db(ctx2, { compras: ctx.__remote.compras });
  await vm.runInContext("syncAll()", ctx2);
  assert.equal(ctx2.__remote.compras.length, 1, "una sola fila remota");
  assert.equal(ctx2.__calls.filter(c => c.op === "create"
    && c.rowId === "rid-1").length >= 1, true, "reintento con mismo rid");
  assert.ok(ctx2.__calls.some(c => c.op === "get"
    && c.rowId === "rid-1"), "el 409 se verifico con getRow");
  assert.equal(get(ctx2, "OUTBOX.length"), 0, "confirmado tras verificar");
  assert.equal(idCalls, 1, "jamis se genero un segundo rid");
});

test("409 de otra fila: no se confirma, la intencion se retiene", async () => {
  const ctx = context({ "pw-uid-hint": "u1" });
  // remoto tiene rid-1 con datos DISTINTOS: un create que choque no
  // es "ya subi la mia" — es conflicto real y queda pendiente
  db(ctx, { compras: [{ $id: "rid-1", sku: "999", paid: 50,
                        date: "2020-01-01" }] });
  const r = await vm.runInContext(
    "(async () => { const c = {sku:'111',paid:10,date:'2026-01-01',"
    + " rid:'rid-1'}; COMPRAS.push(c); return compraUp(c); })()", ctx);
  assert.equal(r.pending, true, "409 ajeno: queda pendiente");
  assert.equal(get(ctx, "OUTBOX.length"), 1);
  assert.equal(ctx.__remote.compras.length, 1,
    "la fila ajena no se toco ni se confirmo como propia");
});

test("fav pendiente sobrevive lectura caida; snap no lo marca borrado", async () => {
  const ctx = context({ "pw-uid-hint": "u1",
                        "pw:user:u1:pw-favs": '["111"]' });
  db(ctx, {}, { list: () => true });
  await vm.runInContext("syncAll()", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"],
    "la lectura caida no vacio el estado local");
  assert.deepEqual(get(ctx, "snapJ.favs || []"), [],
    "nunca se confirmo: no entra ni sale del snapshot");
  assert.equal(get(ctx, "SYNC.state"), "error");
});

test("tabla opcional ilegible conserva su data local", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-siman-watch": '[{"q":"zapato"}]',
    "pw:user:u1:pw-siman-mute": '["regla|x"]',
  });
  db(ctx, {}, { list: t => t === "siman_watch"
                           || t === "siman_muted" });
  await vm.runInContext("syncAll()", ctx);
  assert.deepEqual(get(ctx, "SWATCH"), [{ q: "zapato" }],
    "watch ilegible no se interpreta como vacio");
  assert.deepEqual(get(ctx, "[...SMUTE]"), ["regla|x"]);
  assert.equal(get(ctx, "SYNC.state"), "error");
});

test("syncAll concurrente: un solo vuelo compartido", async () => {
  const ctx = context({ "pw-uid-hint": "u1" });
  let calls = 0;
  db(ctx, {});
  const orig = ctx.__dbs.listRows;
  ctx.__dbs.listRows = async a => { calls++; return orig(a); };
  // dos llamadas concurrentes comparten el mismo vuelo: las tablas
  // se leen UNA sola vez (syncAll es async — cada llamada devuelve
  // su propia envoltura del mismo _syncing interno)
  const p1 = vm.runInContext("syncAll()", ctx);
  const p2 = vm.runInContext("syncAll()", ctx);
  await Promise.all([p1, p2]);
  assert.equal(calls, 6, "seis tablas, una sola lectura cada una");
});

test("cambio de cuenta jamas procesa el outbox del otro usuario", async () => {
  const ctx = context();
  db(ctx, {}, { create: new Error("sin senal") }, "u-a");
  // op pendiente de u-a (el create fallo, queda retenido)
  await vm.runInContext(
    "(async () => { FAV.add('111'); await favUp('111'); saveFavs(); })()",
    ctx);
  assert.equal(get(ctx, "OUTBOX.length"), 1);
  // entra u-b: su namespace tiene outbox propio (vacio)
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  await vm.runInContext("syncAll()", ctx);
  assert.equal(ctx.__calls.filter(c =>
    c.op === "create" && c.rowId === "u-a-111").length, 0,
    "nunca se ejecuto el op del usuario A");
});

test("create de A obsoleto tras cambio: no confirma en B ni manda mas", async () => {
  const ctx = context();
  const g = gate();
  db(ctx, {}, {}, "u-a", { create: () => g.p });
  // el create de A queda bloqueado a mitad de request
  const op = vm.runInContext(
    "FAV.add('111'); saveFavs(); favUp('111')", ctx);
  await new Promise(r => setImmediate(r));
  // cambia a B ANTES de que el request de A termine
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  g.go();                                     // A's request responde ya
  assert.equal(await op, false,
    "el helper NO reporta confirmado: el op esta en la cola de A, "
    + "no en el OUTBOX de B");
  // el ack obsoleto NO escribio el snap ni el outbox de B
  assert.deepEqual(get(ctx, "snapJ"), {});
  assert.deepEqual(get(ctx, "OUTBOX"), []);
  // el sync de B corre limpio y no incluye requests del outbox de A
  await vm.runInContext("syncAll()", ctx);
  assert.equal(ctx.__calls.filter(c =>
    c.op === "create" && c.rowId === "u-a-111").length, 0);
  // la intencion de A sigue guardada en SU namespace (reintentable)
  const ctxA = reload(ctx);
  switchTo(ctxA, "u-a");
  assert.equal(get(ctxA, "OUTBOX.length"), 1,
    "el op de A sobrevivio en su propio namespace");
});

test("lecturas de A obsoletas no importan nada a B", async () => {
  const ctx = context();
  const g = gate();
  // la pagina 1 de compras trae 500+ filas DE A: al resolverse tarde
  // el sync jamas pide pagina 2 ni importa nada al namespace de B
  const comprasA = Array.from({ length: 501 },
    (_, i) => ({ $id: "pa" + i, sku: "s" + i, paid: 1,
                 date: "2026-01-01" }));
  db(ctx, { favs: [{ $id: "u-a-111", sku: "111" }],
            compras: comprasA }, {}, "u-a", { list: () => g.p });
  const s = vm.runInContext("syncAll()", ctx);
  await new Promise(r => setImmediate(r));
  const callsA = ctx.__calls;      // registro del mock de A
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  g.go();                          // pagina 1 de A responde tarde
  await s;
  assert.deepEqual(get(ctx, "[...FAV]"), [],
    "las filas de A no entraron al namespace de B");
  assert.deepEqual(get(ctx, "COMPRAS"), [],
    "las 501 compras de A tampoco");
  assert.deepEqual(get(ctx, "snapJ"), {});
  assert.equal(callsA.filter(c => c.op === "list").length, 6,
    "solo la pagina 1 de cada tabla — jamas una pagina 2 de A");
  assert.equal(callsA.filter(c =>
    c.op === "list" && c.tableId === "compras").length, 1);
  await vm.runInContext("syncAll()", ctx);    // B sync normal
  assert.equal(get(ctx, "SYNC.state"), "ok");
});

test("upsert de A obsoleto: su 404 jamas dispara create bajo B", async () => {
  const ctx = context();
  const g = gate();
  db(ctx, {}, {}, "u-a", { update: () => g.p });
  const op = vm.runInContext(
    "TARGETS['111'] = 500; saveTargets(); tgtSet('111',500)", ctx);
  await new Promise(r => setImmediate(r));
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  // el update de A responde tarde con 404: el codigo viejo habria
  // creado la fila con la sesion de B — jamas debe pasar
  const e404 = new Error("nf"); e404.code = 404;
  g.bad(e404);
  await op;
  assert.equal(ctx.__calls.filter(c => c.op === "create").length, 0,
    "ningun create del upsert de A bajo la sesion de B");
  assert.deepEqual(get(ctx, "OUTBOX"), [],
    "el outbox de B no heredo el op de A");
});

test("create de A obsoleto: su 409 jamas dispara getRow bajo B", async () => {
  const ctx = context();
  const g = gate();
  db(ctx, {}, {}, "u-a", { create: () => g.p });
  const op = vm.runInContext(
    "FAV.add('111'); saveFavs(); favUp('111')", ctx);
  await new Promise(r => setImmediate(r));
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  const e409 = new Error("dup"); e409.code = 409;
  g.bad(e409);
  await op;
  assert.equal(ctx.__calls.filter(c => c.op === "get").length, 0,
    "ningun getRow de verificacion bajo la sesion de B");
  assert.equal(ctx.__calls.filter(c => c.op === "create").length, 0,
    "ningun reintento de create bajo B");
});

test("tabla opcional caida no impide importar la tabla sana", async () => {
  const ctx = context({ "pw-uid-hint": "u1" });
  db(ctx, { favs: [{ $id: "u1-999", sku: "999" }] },
     { list: t => t === "siman_watch" });
  await vm.runInContext("syncAll()", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["999"],
    "favs importo la fila remota aunque watch fallo");
  assert.equal(get(ctx, "SYNC.state"), "error",
    "pero el estado dice la verdad: sync incompleto");
});

test("A -> B -> A: cada cuenta ve solo lo suyo", async () => {
  const ctx = context();
  db(ctx, {}, {}, "u-a");
  await vm.runInContext(
    "(async () => { FAV.add('111'); await favUp('111'); saveFavs(); })()",
    ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"]);
  // a u-b: no hereda nada de u-a
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  assert.deepEqual(get(ctx, "[...FAV]"), [], "u-b sin datos de A");
  await vm.runInContext("syncAll()", ctx);
  assert.equal(ctx.__calls.filter(c => c.op === "create").length, 0,
    "u-b no subio filas de u-a");
  // de vuelta a u-a: su lista sigue ahi
  switchTo(ctx, "u-a");
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"], "u-a restaurado");
});

test("login de otra cuenta no sube la data guest automaticamente", async () => {
  const ctx = context({ "pw-favs": '["111"]' });
  db(ctx, {}, {}, "u-b");
  await vm.runInContext("syncAll()", ctx);
  assert.equal(ctx.__calls.filter(c => c.op === "create").length, 0,
    "ningun create automatico de la data guest");
  assert.deepEqual(get(ctx, "[...FAV]"), [], "u-b ve SU lista (vacia)");
  assert.equal(ctx.localStorage.getItem("pw:guest:pw-favs"), '["111"]',
    "la data guest queda intacta");
});

test("importar guest: rid nuevo por cuenta, sin duplicar ni borrar", async () => {
  const ctx = context({
    "pw-favs": '["111"]',
    "pw-compras": JSON.stringify([
      { sku: "111", paid: 10, date: "2026-01-01", rid: "g-rid" },
      { sku: "111", paid: 10, date: "2026-01-01" }]),
    "pw-targets": '{"111":500}',
  });
  db(ctx, { favs: [{ $id: "u-b-999", sku: "999" }],
            targets: [{ $id: "u-b-111", sku: "111", target: 800 }] },
      {}, "u-b");
  await vm.runInContext("syncAll()", ctx);
  assert.deepEqual(get(ctx, "[...FAV].sort()"), ["999"]);
  assert.deepEqual(get(ctx, "TARGETS"), { "111": 800 });
  const n = await vm.runInContext("importGuest()", ctx);
  assert.equal(n, 3, "fav + 2 compras (targets ya existia)");
  const cs = get(ctx, "COMPRAS");
  assert.equal(cs.length, 2, "las DOS compras identicas entran");
  assert.ok(cs.every(c => c.rid && c.rid !== "g-rid"),
    "rid nuevo por cuenta, jamas el rid guest");
  assert.ok(cs.every(c => typeof c._imported_from === "string"));
  assert.equal(cs[0]._imported_from, "g-rid",
    "recuerda el origen para importacion idempotente");
  // segunda importacion: cero duplicados
  const n2 = await vm.runInContext("importGuest()", ctx);
  assert.equal(get(ctx, "COMPRAS.length"), 2);
  assert.equal(n2, 0);
  // lo guest sigue intacto (recuperable)
  assert.equal(ctx.localStorage.getItem("pw:guest:pw-favs"), '["111"]');
  assert.ok(ctx.localStorage.getItem("pw:guest:pw-compras")
    .includes("g-rid"));
});

test("merge: upsert local pendiente sobrevive borrado remoto", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-targets": '{"111":1200}',
    "pw:user:u1:pw-sync-snap": JSON.stringify({ targets: ["111"] }),
    "pw:user:u1:pw-outbox": JSON.stringify([{
      id: "op-x", uid: "u1", tableId: "targets", rowId: "u1-111",
      kind: "upsert", key: "111",
      data: { sku: "111", target: 1200 }, createdAt: "2026-11-10",
      attempts: 1 }]),
  });
  db(ctx, { targets: [] },                       // remoto la borro
     { update: new Error("sin senal") });        // y el retry falla
  await vm.runInContext("syncAll()", ctx);
  assert.equal(get(ctx, "TARGETS['111']"), 1200,
    "el valor local pendiente sobrevive al borrado remoto");
  assert.equal(get(ctx, "OUTBOX.length"), 1,
    "el upsert sigue retenido para reintento");
});

test("merge: targets/seen existentes importan updates remotos", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-targets": '{"111":1000}',
    "pw:user:u1:pw-siman-seen": '{"r1":5}',
    "pw:user:u1:pw-sync-snap": JSON.stringify({
      targets: ["111"], seen: ["r1"] }),
  });
  db(ctx, { targets: [{ $id: "u1-111", sku: "111", target: 800 }],
            siman_seen: [{ $id: "u1-x", tkey: "r1", price: 8 }] });
  await vm.runInContext("syncAll()", ctx);
  assert.equal(get(ctx, "TARGETS['111']"), 800,
    "target cambiado en otro dispositivo si actualiza");
  assert.equal(get(ctx, "SSEEN['r1']"), 8, "seen gana el mayor");
});

test("merge: seen local pendiente no se pisa por remoto mayor", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-siman-seen": '{"r1":4}',
    "pw:user:u1:pw-sync-snap": JSON.stringify({ seen: ["r1"] }),
    "pw:user:u1:pw-outbox": JSON.stringify([{
      id: "op-s", uid: "u1", tableId: "siman_seen", rowId: "u1-h1",
      kind: "upsert", key: "r1",
      data: { tkey: "r1", price: 4 }, createdAt: "2026-11-10",
      attempts: 0 }]),
  });
  db(ctx, { siman_seen: [{ $id: "u1-h1", tkey: "r1", price: 8 }] },
     { update: new Error("caido") });
  await vm.runInContext("syncAll()", ctx);
  assert.equal(get(ctx, "SSEEN['r1']"), 4,
    "intent local pendiente gana hasta confirmarse");
});

test("outbox reentrante: delete durante create pendiente drena", async () => {
  const ctx = context({ "pw-uid-hint": "u1" });
  const g = gate();
  db(ctx, {}, {}, "u1", { create: () => g.p });
  const done = vm.runInContext(
    "FAV.add('111'); saveFavs(); favUp('111')", ctx);
  await new Promise(r => setImmediate(r));
  // mientras el create esta en vuelo llega la intencion opuesta
  await vm.runInContext(
    "(async () => { FAV.delete('111'); saveFavs(); favDown('111'); })()",
    ctx);
  g.go();
  await done;
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(ctx.__remote.favs.length, 0,
    "create respondio tarde pero el delete dreno despues");
  assert.equal(get(ctx, "OUTBOX.length"), 0,
    "nada quedo pendiente tras drenar");
  assert.deepEqual(get(ctx, "[...FAV]"), []);
});

test("outbox reentrante: upsert cambiado durante await gana el ultimo", async () => {
  const ctx = context({ "pw-uid-hint": "u1" });
  const g = gate();
  db(ctx, {}, {}, "u1", { update: () => g.p });
  const done = vm.runInContext(
    "TARGETS['111'] = 500; saveTargets(); tgtSet('111',500)", ctx);
  await new Promise(r => setImmediate(r));
  // sin await: la intencion queda encolada mientras el request de 500
  // sigue en vuelo — el drenaje posterior debe mandar el 800
  vm.runInContext(
    "TARGETS['111'] = 800; saveTargets(); tgtSet('111',800)", ctx);
  g.go();
  await done;
  await new Promise(r => setImmediate(r));
  assert.equal(ctx.__remote.targets[0].target, 800,
    "la ultima intencion gano, no la request vieja");
  assert.equal(get(ctx, "OUTBOX.length"), 0);
});

test("estado de cuenta: no dice sincronizado solo por tener sesion", async () => {
  const ctx = context();
  db(ctx, {});
  vm.runInContext("paintAcct()", ctx);
  assert.equal(ctx.__doc.getElementById("lg-who").textContent,
    "u1@x.sv");
  const ss = ctx.__doc.getElementById("sync-status").textContent;
  assert.match(ss, /pendiente de sincronizar/,
    `estado honesto sin sync aun: ${ss}`);
  assert.equal(ctx.__doc.getElementById("sync-status")
    .getAttribute("aria-live"), "polite");
});

test("sync completo exitoso reporta sincronizado", async () => {
  const ctx = context();
  db(ctx, {});
  await vm.runInContext("syncAll()", ctx);
  assert.equal(get(ctx, "SYNC.state"), "ok");
  assert.equal(ctx.__doc.getElementById("sync-status").textContent,
    "sincronizado");
});

test("compra ambigua: tuple heredado con 2 filas remotas = revisar", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-compras": JSON.stringify([
      { sku: "111", paid: 10, date: "2026-10-01", rid: "p1" }]),
    "pw:user:u1:pw-sync-snap":
      JSON.stringify({ compras: ["111|2026-10-01|10"] }),
  });
  const row = id => ({ $id: id, sku: "111", paid: 10,
                       date: "2026-10-01" });
  db(ctx, { compras: [row("p1"), row("p2")] });
  await vm.runInContext("syncAll()", ctx);
  assert.equal(ctx.__remote.compras.length, 2,
    "ninguna fila remota borrada por ambiguedad");
  assert.equal(ctx.__calls.filter(c => c.op === "delete").length, 0,
    "ningun DELETE emitido");
  assert.deepEqual(get(ctx, "COMPRAS"), [
    { sku: "111", paid: 10, date: "2026-10-01", rid: "p1" }],
    "la local intacta — conservar, no decidir");
  assert.equal(get(ctx, "SYNC.state"), "error");
  assert.match(get(ctx, "SYNC.err"), /ambiguas/);
  const ss = ctx.__doc.getElementById("sync-status").textContent;
  assert.match(ss, /errores|ambiguas/,
    `el usuario ve la advertencia: ${ss}`);
  // segundo sync: misma ambiguedad, misma advertencia — nunca ok
  await vm.runInContext("syncAll()", ctx);
  assert.equal(get(ctx, "SYNC.state"), "error");
  assert.equal(ctx.__remote.compras.length, 2);
});

test("watch upsert: filtro local llega aunque la fila ya exista", async () => {
  const ctx = context({ "pw-uid-hint": "u1" });
  const wid = await vm.runInContext("`u1-${h16('zapato|L')}`", ctx);
  // la fila ya existe remota con filtro distinto: upsert lleva el
  // deseado local en vez de confirmar a ciegas
  db(ctx, { siman_watch: [{ $id: wid, q: "zapato", talla: "L",
                            filtro: "" }] });
  await vm.runInContext(
    "(async () => { SWATCH = [{q:'zapato',talla:'L',solo:['M']}];"
    + " saveSWatch(); await watchUp({q:'zapato',talla:'L',"
    + " solo:['M']}); })()", ctx);
  assert.equal(ctx.__remote.siman_watch[0].filtro, "M",
    "el filtro local gano en la fila existente");
});

// ---- cuenta ligada offline (hint uid, AW.user=null) ----
// arrancar sin red conserva PWStore.currentUser()=A sin sesion: una
// mutacion local DEBE encolar la intencion para ESA cuenta — sin op
// pendiente, el login posterior lee el remoto viejo y applyRemote
// pisa el cambio local (el bug que motiva todo esto)

test("offline-bound: target edit encola y login confirma el 1200", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-targets": '{"111":1000}',
    "pw:user:u1:pw-sync-snap": JSON.stringify({ targets: ["111"] }),
  });
  // sin sesion, cuenta ligada por hint
  assert.equal(get(ctx, "PWStore.currentUser()"), "u1");
  assert.equal(get(ctx, "AW.user"), null);
  await vm.runInContext(
    "(async () => { TARGETS['111'] = 1200; saveTargets();"
    + " await tgtSet('111',1200); })()", ctx);
  assert.equal(get(ctx, "OUTBOX.length"), 1,
    "la intencion se encolo durable aun sin sesion");
  assert.equal(get(ctx, "OUTBOX[0].uid"), "u1",
    "el op pertenece a la cuenta ligada, nunca a un uid adivinado");
  assert.equal(get(ctx, "OUTBOX[0].rowId"), "u1-111");
  assert.equal(get(ctx, "OUTBOX[0].kind"), "upsert");
  // recarga offline: la intencion y el valor sobreviven
  const ctx2 = reload(ctx);
  assert.equal(get(ctx2, "TARGETS['111']"), 1200);
  assert.equal(get(ctx2, "OUTBOX.length"), 1, "op tras reload");
  // login de la MISMA cuenta con remoto viejo: el op drena primero —
  // el 1000 remoto jamas pisa el 1200 local
  db(ctx2, { targets: [{ $id: "u1-111", sku: "111", target: 1000 }] });
  await vm.runInContext("syncAll()", ctx2);
  assert.equal(ctx2.__remote.targets[0].target, 1200,
    "remoto actualizado al valor local");
  assert.equal(get(ctx2, "TARGETS['111']"), 1200,
    "applyRemote no lo regreso a 1000");
  assert.equal(get(ctx2, "OUTBOX.length"), 0, "confirmado");
  assert.equal(get(ctx2, "SYNC.state"), "ok");
});

test("offline-bound: seen y filtro watch encolan sin sesion", async () => {
  const ctx = context({
    "pw-uid-hint": "u1",
    "pw:user:u1:pw-siman-seen": '{"r1":5}',
    "pw:user:u1:pw-siman-watch": '[{"q":"zapato","talla":"L"}]',
  });
  await vm.runInContext(
    "(async () => { SSEEN['r1'] = 8; saveSSeen();"
    + " await seenUp('r1',8);"
    + " SWATCH = [{q:'zapato',talla:'L',solo:['M']}]; saveSWatch();"
    + " await watchUp({q:'zapato',talla:'L',solo:['M']}); })()", ctx);
  const ops = get(ctx, "OUTBOX");
  assert.equal(ops.length, 2, "ambas intenciones encoladas offline");
  assert.ok(ops.every(o => o.uid === "u1"),
    "todas son de la cuenta ligada");
  const sid = await vm.runInContext("`u1-${h16('r1')}`", ctx);
  const wid = await vm.runInContext("`u1-${h16('zapato|L')}`", ctx);
  const ctx2 = reload(ctx);
  db(ctx2, { siman_seen: [{ $id: sid, tkey: "r1", price: 5 }],
             siman_watch: [{ $id: wid, q: "zapato", talla: "L",
                             filtro: "" }] });
  await vm.runInContext("syncAll()", ctx2);
  assert.equal(ctx2.__remote.siman_seen[0].price, 8,
    "seen remoto actualizado al local");
  assert.equal(ctx2.__remote.siman_watch[0].filtro, "M",
    "filtro watch remoto actualizado al local");
  assert.equal(get(ctx2, "SSEEN['r1']"), 8);
  assert.deepEqual(get(ctx2, "SWATCH"),
    [{ q: "zapato", talla: "L", solo: ["M"] }]);
  assert.equal(get(ctx2, "OUTBOX.length"), 0);
});

test("offline-bound: login de otra cuenta no procesa la cola de A", async () => {
  const ctx = context({ "pw-uid-hint": "u1",
                        "pw:user:u1:pw-targets": '{"111":1000}' });
  await vm.runInContext(
    "(async () => { TARGETS['111'] = 1200; saveTargets();"
    + " await tgtSet('111',1200); })()", ctx);
  assert.equal(get(ctx, "OUTBOX.length"), 1);
  // login B: ve su outbox vacio y jamas ejecuta el op de A
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  assert.equal(get(ctx, "OUTBOX.length"), 0,
    "B ve su propio namespace (vacio)");
  await vm.runInContext("syncAll()", ctx);
  assert.equal(ctx.__calls.filter(c =>
    (c.op === "update" || c.op === "create") && c.rowId === "u1-111")
    .length, 0, "ningun request del op de A bajo la sesion de B");
  assert.equal(
    JSON.parse(ctx.localStorage.getItem("pw:user:u1:pw-outbox")).length,
    1, "la intencion de A sigue guardada en SU namespace");
});

test("guest: mutaciones locales jamas encolan ni se suben", async () => {
  const ctx = context();       // sin hint ni sesion: guest puro
  const r = await vm.runInContext(
    "(async () => { FAV.add('111'); saveFavs();"
    + " const a = await favUp('111');"
    + " TARGETS['111'] = 500; saveTargets();"
    + " const b = await tgtSet('111',500);"
    + " const c = {sku:'111',paid:10,date:'2026-01-01'};"
    + " COMPRAS.push(c); saveCompras();"
    + " const d = await compraUp(c);"
    + " return {a, b, pend:d.pending}; })()", ctx);
  assert.equal(get(ctx, "OUTBOX.length"), 0,
    "guest nunca genera intencion remota");
  assert.equal(ctx.localStorage.getItem("pw:guest:pw-outbox"), null,
    "ni siquiera se persiste un outbox guest");
  assert.equal(r.pend, true, "la compra guest queda local (pendiente)");
  // login posterior: nada del guest se sube sin importacion explicita
  const ctx2 = reload(ctx);
  db(ctx2, {}, {}, "u9");
  await vm.runInContext("syncAll()", ctx2);
  assert.equal(ctx2.__calls.filter(c =>
    c.op === "create" || c.op === "update").length, 0,
    "ninguna fila guest subio sola");
  assert.deepEqual(get(ctx2, "TARGETS"), {},
    "el target guest no se heredo a la cuenta");
});

// ---- el dataset publico jamas siembra estado de watches ----
// D.siman.watches son las queries del radar (data publica), no el
// estado del usuario: sembrarlas las subia a una cuenta nueva como
// si fueran suyas. Solo migra el valor legacy local via PWStore.

test("dataset publico no siembra watches en guest ni en cuenta B", async () => {
  const d = { ...DEMO_D,
    siman: { items: [], events: [],
             watches: [{ q: "seed-del-dataset", talla: "L" }] } };
  // guest puro: el dataset no es estado
  const ctx = context({}, d);
  assert.deepEqual(get(ctx, "SWATCH"), [],
    "D.siman.watches no siembra el namespace guest");
  // cuenta nueva B con nube vacia: SWATCH vacio y nada se sube
  const ctx2 = context({ "pw-uid-hint": "u-b" }, d);
  db(ctx2, {}, {}, "u-b");
  assert.deepEqual(get(ctx2, "SWATCH"), [],
    "B arranca vacia aunque el dataset traiga seeds");
  await vm.runInContext("syncAll()", ctx2);
  assert.equal(ctx2.__calls.filter(c =>
    c.op === "create" && c.tableId === "siman_watch").length, 0,
    "ninguna watch del dataset se subio como si fuera de B");
  assert.deepEqual(ctx2.__remote.siman_watch || [], [],
    "la nube de B quedo limpia");
  // una watch ligada a B se conserva (no la pisa el dataset)
  const ctx3 = context(
    { "pw-uid-hint": "u-b",
      "pw:user:u-b:pw-siman-watch":
        JSON.stringify([{ q: "mio", talla: "M" }]) }, d);
  db(ctx3, {}, {}, "u-b");
  assert.deepEqual(get(ctx3, "SWATCH"), [{ q: "mio", talla: "M" }],
    "la watch local ligada a B sobrevive");
  // y una watch legacy local (sin namespace) migra a guest intacta
  const ctx4 = context(
    { "pw-siman-watch": JSON.stringify([{ q: "vieja", talla: "S" }]) },
    d);
  assert.deepEqual(get(ctx4, "SWATCH"), [{ q: "vieja", talla: "S" }],
    "la watch legacy migra a guest via PWStore, no se pierde");
});

test("compra de A obsoleto: pendiente, jamas confirmado en B", async () => {
  const ctx = context();
  const g = gate();
  db(ctx, {}, {}, "u-a", { create: () => g.p });
  const p = vm.runInContext(
    "(async () => { const c = {sku:'111',paid:10,date:'2026-01-01'};"
    + " COMPRAS.push(c); const d = await compraUp(c);"
    + " return d.pending; })()", ctx);
  await new Promise(r => setImmediate(r));
  switchTo(ctx, "u-b");
  db(ctx, {}, {}, "u-b");
  g.go();
  assert.equal(await p, true,
    "pending=true: el op viejo no confirmo solo por no estar en B");
  assert.equal(
    JSON.parse(ctx.localStorage.getItem("pw:user:u-a:pw-outbox")).length,
    1, "la cola persistida de A conserva el op para reintento");
});
