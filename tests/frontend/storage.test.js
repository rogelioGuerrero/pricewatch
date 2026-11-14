"use strict";
// storage.test.js — adaptador PWStore: lectura defensiva, rescate de
// corruptos, namespace por cuenta y migracion legacy->guest.
// Regresion: un valor corrupto de localStorage abortaba el arranque
// (SyntaxError en el primer JSON.parse) y la data quedaba irrecuperable.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, APPWRITE_STUB, vm } = require("./harness.js");

const get = (ctx, expr) =>
  JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, ctx));
const DOMAIN = ["pw-favs", "pw-compras", "pw-targets", "pw-cart",
                "pw-siman-watch", "pw-siman-mute", "pw-siman-seen",
                "pw-sync-snap", "pw-outbox"];

test("JSON corrupto en cada coleccion: arranca con fallback", () => {
  for (const k of DOMAIN) {
    const ctx = makeCtx({ stored: { [k]: "{broken" },
                          appwrite: APPWRITE_STUB });
    boot(ctx);   // ningun throw
    // el original legacy sigue intacto Y la copia corrupta queda
    // rescatada bajo pw-corrupt-<ns><key> — nunca se borra nada
    assert.equal(ctx.localStorage.getItem(k), "{broken", k);
    assert.equal(
      ctx.localStorage.getItem("pw-corrupt-pw:guest:" + k), "{broken",
      `rescate de ${k}`);
  }
});

test("formas validas-pero-incorrectas caen al fallback sin tumbar", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB, stored: {
    "pw-favs": '{"a":1}',                  // objeto donde va lista
    "pw-targets": "[1,2]",                 // lista donde va mapa
    "pw-compras": '["x",1,null]',          // entradas sin forma minima
    "pw-siman-seen": '"texto"',            // string donde va mapa
    "pw-siman-mute": '{"a":1}',
    "pw-siman-watch": '[{"x":1}]',         // watch sin q
    "pw-sync-snap": '[1]',                 // lista donde va objeto
    "pw-outbox": '[{"x":1}]',              // op sin rowId/kind
    "pw-cart": '42',
  } });
  boot(ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), []);
  assert.deepEqual(get(ctx, "COMPRAS"), []);
  assert.deepEqual(get(ctx, "TARGETS"), {});
  assert.deepEqual(get(ctx, "snapJ"), {});
  assert.deepEqual(get(ctx, "OUTBOX"), []);
  // watch invalido cae a la semilla SIMAN.watches (vacia en DEMO_D)
  assert.deepEqual(get(ctx, "SWATCH"), []);
});

test("localStorage que lanza: arranca en memoria, marca no-persistido", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB });
  ctx.localStorage.getItem = () => { throw new Error("denegado"); };
  ctx.localStorage.setItem = () => { throw new Error("denegado"); };
  boot(ctx);
  const st = get(ctx, "PWStore.status()");
  assert.equal(st.persisted, false, "status debe decir no persistido");
  // la app sigue usable en memoria aunque nada persista
  vm.runInContext("FAV.add('111'); saveFavs();", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"]);
});

test("data legacy sin namespace: copia a guest conservando el original", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB, stored: {
    "pw-favs": '["111","222"]',
    "pw-compras": '[{"sku":"111","paid":100,"date":"2026-01-01"}]',
  } });
  boot(ctx);
  assert.equal(ctx.localStorage.getItem("pw-favs"), '["111","222"]',
    "el original legacy nunca se borra");
  assert.equal(ctx.localStorage.getItem("pw:guest:pw-favs"),
    '["111","222"]', "copiado al namespace guest");
  assert.equal(ctx.localStorage.getItem("pw:guest:pw-compras"),
    '[{"sku":"111","paid":100,"date":"2026-01-01"}]');
  assert.deepEqual(get(ctx, "[...FAV].sort()"), ["111", "222"]);
  assert.equal(get(ctx, "COMPRAS.length"), 1);
});

test("namespaces por cuenta: activate cambia el prefijo sin mezclar", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB, stored: {
    "pw-favs": '["111"]',
    "pw:user:u-b:pw-favs": '["999"]',
  } });
  boot(ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"]);      // guest
  vm.runInContext(
    "PWStore.activate('u-b'); hydrateNS();", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["999"], "datos de u-b");
  assert.equal(PWStoreStatus(ctx).ns, "pw:user:u-b:");
  vm.runInContext(
    "PWStore.activate(null); hydrateNS();", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"], "guest conserva lo suyo");
});
const PWStoreStatus = ctx => get(ctx, "PWStore.status()");

test("el hint restaura el ultimo namespace ligado al reabrir", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB, stored: {
    "pw-uid-hint": "u-b",
    "pw:user:u-b:pw-favs": '["999"]',
    "pw:guest:pw-favs": '["111"]',
  } });
  boot(ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["999"],
    "arranca con los datos del ultimo usuario ligado");
});

test("reglas Siman con hash corrupto no revientan el matching", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB, stored: {
    // hash no-hex (BigInt habria lanzado) y un hash hex valido
    "pw-siman-mute": '["s2|tkeyX|zzz","s3|tkeyY|0000000000000000"]',
    "pw-siman-seen": '{"s2|tkeyX|zzz": 10}',
  } });
  boot(ctx);
  // hash corrupto: hDist devuelve 99 ("no parecido"), no un throw —
  // y pid/tkey no matchean, asi que la regla llega a la rama de hash
  assert.equal(vm.runInContext(
    "isMuted({pid:'s1', t:'zapato azul', ihs:['zzz','bad']})", ctx),
    false);
  // hash valido cercano (distancia 1) sigue matcheando
  assert.equal(vm.runInContext(
    "isMuted({pid:'s1', t:'zapato azul', ihs:['0000000000000001']})",
    ctx), true);
});

test("disco roto: overlay en memoria conserva writes entre hydrate", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB });
  ctx.localStorage.setItem = () => { throw new Error("lleno"); };
  boot(ctx);
  assert.equal(get(ctx, "PWStore.status().persisted"), false);
  // add + save + rehidratacion: la data esta viva en el overlay
  vm.runInContext(
    "FAV.add('111'); saveFavs(); TARGETS['111']=500; saveTargets();",
    ctx);
  vm.runInContext("hydrateNS()", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"],
    "el overlay sobrevive a la rehidratacion");
  assert.deepEqual(get(ctx, "TARGETS"), { "111": 500 });
});

test("disco roto + cambio A->B->A: memoria de cada namespace intacta", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB });
  ctx.localStorage.setItem = () => { throw new Error("denegado"); };
  boot(ctx);
  vm.runInContext(
    "AW.user={$id:'u-a',email:'a@x'}; PWStore.activate('u-a');"
    + " hydrateNS(); FAV.add('fa'); saveFavs();", ctx);
  vm.runInContext(
    "AW.user={$id:'u-b',email:'b@x'}; PWStore.activate('u-b');"
    + " hydrateNS(); FAV.add('fb'); saveFavs();", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["fb"], "B ve solo lo suyo");
  vm.runInContext(
    "AW.user={$id:'u-a',email:'a@x'}; PWStore.activate('u-a');"
    + " hydrateNS();", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["fa"],
    "la memoria de A sigue ahi al volver");
});

test("getItem lanza: writes en memoria siguen legibles", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB });
  ctx.localStorage.getItem = () => { throw new Error("roto"); };
  boot(ctx);
  vm.runInContext("FAV.add('111'); saveFavs();", ctx);
  // lectura directa por el adapter: el overlay responde aunque el
  // disco este inaccesible
  assert.deepEqual(
    get(ctx, "PWStore.read('pw-favs', [], PWStore.valid.strList)"),
    ["111"]);
  vm.runInContext("hydrateNS()", ctx);
  assert.deepEqual(get(ctx, "[...FAV]"), ["111"]);
});

test("snap con forma anidada mala y 1e999 caen al fallback", () => {
  const ctx = makeCtx({ appwrite: APPWRITE_STUB, stored: {
    // {favs:{}} NO es una coleccion valida: los valores deben ser
    // arrays de strings; 1e999 parsea como Infinity y no es finito
    "pw-sync-snap": '{"favs":{"a":1}}',
    "pw-targets": '{"111":1e999}',
    "pw-siman-seen": '{"r1":-5}',
    "pw-compras": '[{"sku":"111","paid":1e999},'
                  + '{"sku":{},"paid":10,"date":"2026-01-01"},'
                  + '{"sku":"222","paid":5,"date":"ayer"}]',
    "pw-siman-watch": '[{"q":"x","talla":{}},'
                      + '{"q":"y","solo":"L"}]',
    "pw-outbox": '[{"rowId":"r","kind":"nuke","tableId":"favs"},'
                 + '{"rowId":"r2","kind":"create","tableId":"otra"},'
                 + '{"rowId":"r3","kind":"create","tableId":"favs",'
                 + '"data":{"paid":1e999}}]',
  } });
  boot(ctx);   // nada de esto tira ni llega al dominio
  assert.deepEqual(get(ctx, "snapJ"), {});
  assert.deepEqual(get(ctx, "TARGETS"), {});
  assert.deepEqual(get(ctx, "SSEEN"), {});
  assert.deepEqual(get(ctx, "COMPRAS"), []);
  assert.deepEqual(get(ctx, "SWATCH"), []);
  assert.deepEqual(get(ctx, "OUTBOX"), []);
});
