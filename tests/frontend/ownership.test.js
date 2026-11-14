"use strict";
// ownership.test.js — fase 4: un formulario abierto o un callback
// retenido pertenece al dueno que lo creo ({uid, epoch} estampados al
// abrir). Cambiar de namespace cierra los dialogos vencidos y ningun
// submit/input/click tardio escribe en la cuenta nueva; el mismo
// uid+epoch conserva borradores y el autosave de blur legitimo.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, vm } = require("./harness.js");

const run = (ctx, js) => vm.runInContext(js, ctx);
const tick = () => new Promise(r => setImmediate(r));
const startup = opts => { const ctx = makeCtx(opts); boot(ctx); return ctx; };
// el stub guarda los atributos crudos (con entidades); decodificar
// como hace el browser antes de evaluar el handler
const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("propiedad: draft de compra guest no escribe en la cuenta B", () => {
  const ctx = startup({ stored: {
    "pw-compras": '[{"sku":"111","paid":5,"date":"2026-11-01","rid":"g1"}]',
  }});
  const doc = ctx.__doc;
  run(ctx, `openPurchase("111")`);
  const dlgP = doc.getElementById("dlg-purchase");
  assert.equal(dlgP.open, true);
  doc.getElementById("pu-price").value = "10.00";
  doc.getElementById("pu-qty").value = "2";
  doc.getElementById("pu-date").value = "2026-11-01";
  // cambio de cuenta: activar B rehidrata y cierra el formulario guest
  run(ctx, `PWStore.activate("b"); hydrateNS()`);
  assert.equal(dlgP.open, false, "dialogo guest cerrado al hidratar B");
  // submit tardio sobre el dialogo ya cerrado: no-op total (fase 1)
  doc.getElementById("pu-form")._fire("submit", { preventDefault() {} });
  assert.equal(run(ctx, `COMPRAS.length`), 0);
  assert.equal(ctx.localStorage.getItem("pw:user:b:pw-compras"), null);
  assert.equal(run(ctx, `OUTBOX.length`), 0);
  // aun reabriendo la caja por DOM el sello quedo guest: nada se muta
  dlgP.showModal();
  doc.getElementById("pu-form")._fire("submit", { preventDefault() {} });
  assert.match(doc.getElementById("pu-err").textContent, /cuenta cambi/);
  assert.equal(run(ctx, `COMPRAS.length`), 0);
  // la data guest quedo intacta en su propio namespace
  assert.equal(ctx.localStorage.getItem("pw-compras"),
    '[{"sku":"111","paid":5,"date":"2026-11-01","rid":"g1"}]');
});

test("propiedad: checkout de A no toca el carrito de B (filas con epoch)", () => {
  const ctx = startup({ stored: {
    "pw:user:a:pw-cart": '["111"]',
    "pw:user:a:pw-cart-lines": '{"111":{"quantity":2,"unitCents":500}}',
    "pw:user:b:pw-cart": '["111"]',
    "pw:user:b:pw-cart-lines": '{"111":{"quantity":9,"unitCents":900}}',
  }});
  const doc = ctx.__doc;
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  run(ctx, `openCheckout()`);
  const rows = doc.getElementById("ck-rows");
  const aRow = rows.querySelector(".ckrow");
  assert.equal(aRow.dataset.formEpoch,
    String(run(ctx, `PWStore.currentEpoch()`)));
  // A->B: el checkout abierto de A se cierra
  run(ctx, `PWStore.activate("b"); hydrateNS()`);
  assert.equal(doc.getElementById("dlg-checkout").open, false);
  // input tardio en la fila retenida de A no toca la linea de B
  aRow.querySelector(".ck-q").value = "1";
  aRow.querySelector(".ck-p").value = "0.01";
  rows._fire("input", { target: aRow.querySelector(".ck-q") });
  assert.equal(run(ctx, `CART_LINES["111"].quantity`), 9);
  assert.equal(run(ctx, `CART_LINES["111"].unitCents`), 900);
  // delete tardio tampoco quita la membresia de B
  rows._fire("click", { target: aRow.querySelector(".ck-del") });
  assert.equal(run(ctx, `CART.has("111")`), true);
  // submit tardio con el dialogo cerrado: no confirma nada
  doc.getElementById("ck-ok").click();
  assert.equal(run(ctx, `COMPRAS.length`), 0);
  assert.equal(run(ctx, `CART.has("111")`), true);
  // B reabre SU checkout: las filas nuevas llevan la epoch de B...
  run(ctx, `openCheckout()`);
  const bRow = rows.querySelector(".ckrow");
  assert.equal(bRow.dataset.formEpoch,
    String(run(ctx, `PWStore.currentEpoch()`)));
  // ...y los eventos de la fila vieja de A siguen sin aplicar
  rows._fire("input", { target: aRow.querySelector(".ck-q") });
  rows._fire("click", { target: aRow.querySelector(".ck-del") });
  assert.equal(run(ctx, `CART_LINES["111"].quantity`), 9);
  assert.equal(run(ctx, `CART_LINES["111"].unitCents`), 900);
  assert.equal(run(ctx, `CART.has("111")`), true);
  assert.equal(ctx.localStorage.getItem("pw:user:b:pw-cart-lines"),
    '{"111":{"quantity":9,"unitCents":900}}');
  // volver a A restaura su carrito y su draft
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  assert.equal(run(ctx, `CART_LINES["111"].quantity`), 2);
  assert.equal(run(ctx, `CART_LINES["111"].unitCents`), 500);
  run(ctx, `openCheckout()`);
  assert.equal(rows.querySelector(".ckrow .ck-q").value, "2");
  // cancelar con la fila a la vista: input/delete tardios no escriben
  const aRow2 = rows.querySelector(".ckrow");
  doc.getElementById("ck-cancel").click();
  aRow2.querySelector(".ck-q").value = "5";
  rows._fire("input", { target: aRow2.querySelector(".ck-q") });
  rows._fire("click", { target: aRow2.querySelector(".ck-del") });
  assert.equal(run(ctx, `CART_LINES["111"].quantity`), 2);
  assert.equal(run(ctx, `CART.has("111")`), true);
  // reabrir en la MISMA cuenta sella otro owner: la fila vieja queda
  // huerfana aunque uid+epoch no cambiaron
  run(ctx, `openCheckout()`);
  aRow2.querySelector(".ck-q").value = "8";
  rows._fire("input", { target: aRow2.querySelector(".ck-q") });
  rows._fire("click", { target: aRow2.querySelector(".ck-del") });
  assert.equal(run(ctx, `CART_LINES["111"].quantity`), 2);
  assert.equal(run(ctx, `CART.has("111")`), true);
  // la fila vigente si edita el carrito
  const cur = rows.querySelector(".ckrow");
  cur.querySelector(".ck-q").value = "4";
  rows._fire("input", { target: cur.querySelector(".ck-q") });
  assert.equal(run(ctx, `CART_LINES["111"].quantity`), 4);
});

test("propiedad: callbacks de ficha de A no mutan bajo B", () => {
  const ctx = startup({ stored: {
    "pw:user:a:pw-compras":
      '[{"sku":"111","paid":10,"date":"2026-11-01","rid":"p1"}]',
    "pw:user:b:pw-compras":
      '[{"sku":"111","paid":20,"date":"2026-11-02","rid":"b1"}]',
  }});
  const doc = ctx.__doc;
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  run(ctx, `openProd("111")`);
  const aEp = run(ctx, `PWStore.currentEpoch()`);
  const dt = doc.getElementById("dtgt");
  dt.value = "9.99";
  const oldTarget = dt.onchange;
  const oldStar = doc.getElementById("dstar").onclick;
  const oldCart = doc.getElementById("dcart").onclick;
  const oldBuy = doc.getElementById("dbuy").onchange;
  const oldDel = doc.querySelector("#dbuys [data-compra-index]");
  assert.ok(oldDel, "boton de borrado con data-compra-index");
  assert.equal(oldDel.dataset.formEpoch, String(aEp));
  // el HTML generado bajo A tambien viaja con la epoch de A: el sku
  // va como literal JS escapado (jsArg), la epoch como numero
  const holder = doc.createElement("div");
  holder.innerHTML = run(ctx, `star("111")`);
  const oc = unesc(holder.querySelector("button")
    .getAttribute("onclick"));
  assert.ok(oc.includes(`toggleFav("111",event,${aEp})`),
    `epoch ${aEp} capturada en el handler inline: ${oc}`);
  // A->B: la ficha abierta se cierra y B toma el namespace
  run(ctx, `PWStore.activate("b"); hydrateNS()`);
  assert.equal(doc.getElementById("dlg").open, false);
  run(ctx, `openProd("111")`);   // ficha legitima de B (mismo sku)
  // ningun callback retenido de A muta el estado de B
  oldTarget();
  oldStar();
  oldCart();
  oldBuy();
  assert.equal(run(ctx, `TARGETS["111"]`), undefined);
  assert.equal(run(ctx, `FAV.has("111")`), false);
  assert.equal(run(ctx, `CART.has("111")`), false);
  assert.equal(run(ctx, `COMPRAS.length`), 1, "compra de B intacta");
  assert.equal(run(ctx, `OUTBOX.length`), 0);
  // el boton viejo de historial no borra la compra de B
  doc.getElementById("dbuys")._fire("click", { target: oldDel });
  assert.equal(run(ctx, `COMPRAS.length`), 1);
  // las funciones inline con la epoch vieja tampoco mutan
  run(ctx, `toggleFav("111", {stopPropagation(){}}, ${aEp})`);
  run(ctx, `cartToggle("111", true, ${aEp})`);
  run(ctx, `buyToggled("111", {checked:true}, ${aEp})`);
  assert.equal(run(ctx, `FAV.has("111")`), false);
  assert.equal(run(ctx, `CART.has("111")`), false);
  assert.equal(doc.getElementById("dlg-purchase").open, false);
  assert.equal(run(ctx, `OUTBOX.length`), 0);
  // el boton delegado legitimo de B SI borra (epoch vigente)
  const bDel = doc.querySelector("#dbuys [data-compra-index]");
  doc.getElementById("dbuys")._fire("click", { target: bDel });
  assert.equal(run(ctx, `COMPRAS.length`), 0);
});

test("propiedad: misma cuenta + epoch conserva formularios, drafts y autosave", async () => {
  const ctx = startup({ stored: {
    "pw:user:a:pw-cart": '["111"]',
    "pw:user:a:pw-cart-lines": '{"111":{"quantity":2,"unitCents":500}}',
  }});
  const doc = ctx.__doc;
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  // compra y checkout abiertos con borrador en progreso
  run(ctx, `openPurchase("111")`);
  doc.getElementById("pu-qty").value = "3";
  doc.getElementById("pu-price").value = "10.00";
  run(ctx, `openCheckout()`);
  const q = doc.querySelector("#ck-rows .ck-q");
  q.value = "7";
  doc.getElementById("ck-rows")._fire("input", { target: q });
  // rehidratar el MISMO uid+epoch (resume offline): nada se cierra
  run(ctx, `hydrateNS()`);
  assert.equal(doc.getElementById("dlg-purchase").open, true);
  assert.equal(doc.getElementById("dlg-checkout").open, true);
  assert.equal(doc.getElementById("pu-qty").value, "3",
    "borrador de compra intacto");
  assert.equal(run(ctx, `CART_LINES["111"].quantity`), 7,
    "draft del carrito sobrevivio a la rehidratacion");
  // el submit de la compra vigente sigue funcionando
  doc.getElementById("pu-date").value = "2026-11-01";
  doc.getElementById("pu-form")._fire("submit", { preventDefault() {} });
  assert.equal(run(ctx, `COMPRAS.length`), 3);
  // autosave por blur: el change puede disparar DESPUES de cerrar la
  // ficha (close quita open) — mismo dueno + mismo sello = se guarda
  run(ctx, `openProd("111")`);
  const dt = doc.getElementById("dtgt");
  dt.value = "12.34";
  const oldChange = dt.onchange;
  doc.getElementById("dlg").close();
  oldChange();
  assert.equal(run(ctx, `TARGETS["111"]`), 1234,
    "blur legitimo del dueno vigente guarda el objetivo");
  // reabrir la ficha en la MISMA cuenta sella un owner nuevo: el
  // callback de la apertura anterior ya no escribe (identidad)
  run(ctx, `openProd("111")`);
  dt.value = "99.99";
  oldChange();
  assert.equal(run(ctx, `TARGETS["111"]`), 1234);
});

test("propiedad: A -> B -> A invalida los callbacks viejos aunque el uid vuelva", () => {
  const ctx = startup();
  const doc = ctx.__doc;
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  run(ctx, `openProd("111")`);
  const oldTarget = doc.getElementById("dtgt").onchange;
  const oldStar = doc.getElementById("dstar").onclick;
  run(ctx, `PWStore.activate("b"); hydrateNS()`);
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  assert.equal(run(ctx, `PWStore.currentUser()`), "a");
  // uid otra vez A pero epoch nueva: los callbacks viejos no mutan
  run(ctx, `openProd("111")`);
  doc.getElementById("dtgt").value = "5.00";
  oldTarget();
  oldStar();
  assert.equal(run(ctx, `TARGETS["111"]`), undefined);
  assert.equal(run(ctx, `FAV.has("111")`), false);
  assert.equal(run(ctx, `OUTBOX.length`), 0);
  // la apertura vigente SI funciona en su propio namespace
  doc.getElementById("dstar").onclick();
  assert.equal(run(ctx, `FAV.has("111")`), true);
});

test("propiedad: borrado de compra resuelve por identidad, no por indice", () => {
  const ctx = startup({ stored: {
    "pw:user:a:pw-compras":
      '[{"sku":"111","paid":10,"date":"2026-11-01","rid":"r1"},'
      + '{"sku":"111","paid":20,"date":"2026-11-02","rid":"r2"}]',
  }});
  const doc = ctx.__doc;
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  run(ctx, `openProd("111")`);
  const old = doc.querySelectorAll("#dbuys [data-compra-index]");
  assert.equal(old.length, 2);
  assert.equal(run(ctx, `COMPRAS.length`), 2);
  // merge/remate legitimo: quita r1 y reordena — la posicion 0 de
  // los botones viejos ahora corresponderia a r2
  run(ctx, `COMPRAS.splice(0,1); rebuildPaid(); render();`);
  assert.equal(run(ctx, `COMPRAS[0].rid`), "r2");
  // click del boton viejo de r1: el rid ya no existe -> solo repinta,
  // jamas borra la fila que ocupo su posicion
  doc.getElementById("dbuys")._fire("click", { target: old[0] });
  assert.equal(run(ctx, `COMPRAS.length`), 1);
  assert.equal(run(ctx, `COMPRAS[0].rid`), "r2");
  // el repintado resello la ficha: el boton viejo de r2 queda huerfano
  // en la MISMA cuenta+epoch (identidad del sello, no solo epoch)
  doc.getElementById("dbuys")._fire("click", { target: old[1] });
  assert.equal(run(ctx, `COMPRAS.length`), 1);
  assert.equal(run(ctx, `COMPRAS[0].rid`), "r2");
  // el boton vigente de r2 si borra la fila correcta
  const cur = doc.querySelector("#dbuys [data-compra-index]");
  assert.ok(cur, "boton vigente tras el repintado");
  doc.getElementById("dbuys")._fire("click", { target: cur });
  assert.equal(run(ctx, `COMPRAS.length`), 0);
});

test("propiedad: recuperacion y secciones de A no actuan bajo B", async () => {
  const ctx = startup();
  const doc = ctx.__doc;
  run(ctx, `PWStore.activate("a"); hydrateNS()`);
  run(ctx, `openRecover()`);
  run(ctx, `openNav()`);
  assert.equal(doc.getElementById("dlg-recover").open, true);
  assert.equal(doc.getElementById("dlg-nav").open, true);
  run(ctx, `PWStore.activate("b"); hydrateNS()`);
  assert.equal(doc.getElementById("dlg-recover").open, false);
  assert.equal(doc.getElementById("dlg-nav").open, false);
  // clicks tardios de los botones del dialogo viejo: ni descarga ni
  // reparacion tocan el namespace de B
  let urls = 0;
  ctx.URL.createObjectURL = () => { urls++; return "blob:x"; };
  doc.getElementById("rc-export").click();
  doc.getElementById("rc-fix").click();
  await tick();
  assert.equal(urls, 0);
  assert.equal(doc.getElementById("rc-status").textContent, "");
  // fix tardio con cierre+reapertura sincrona (misma cuenta, otro
  // sello): el resultado del await viejo no pinta el dialogo nuevo
  run(ctx, `openRecover()`);
  doc.getElementById("rc-fix").click();
  doc.getElementById("dlg-recover").close();
  run(ctx, `openRecover()`);
  await tick(); await tick();
  assert.equal(doc.getElementById("rc-status").textContent, "");
});
