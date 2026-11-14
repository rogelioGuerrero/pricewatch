"use strict";
// ui.test.js — el UI nuevo del plan: Inicio, bottom-nav, dialogo de
// compra, checkout del carrito, undo-toast, estado corrupto y
// etiquetas honestas de frescura. Todo contra el DOM stub del harness.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, DEMO_D, vm } = require("./harness.js");

const startup = opts => { const ctx = makeCtx(opts); boot(ctx); return ctx; };
const run = (ctx, js) => vm.runInContext(js, ctx);
const tick = () => new Promise(r => setImmediate(r));
const panesOn = doc =>
  doc.querySelectorAll(".pane.on").map(e => e.id.slice(5));

// dataset con N productos "bajo" para probar la paginacion de 24
const bigD = n => {
  const D = { ...DEMO_D, products: {}, series: {}, agg: {},
              events: [], ofertas: [] };
  for (let i = 0; i < n; i++) {
    const s = "p" + i;
    D.products[s] = { title: "Prod " + i, brand: "M", category: "C",
                      slug: "p" + i };
    D.series[s] = [["2026-09-29", 1000 + i, 1, 0]];
    D.agg[s] = { min: 1000 + i, max: 2000, med: 1500 };
    D.events.push({ type: "bajo", sku: s, date: "2026-09-29",
                    from: 2000, to: 1000 + i, pct: -10,
                    title: "Prod " + i });
  }
  return D;
};

test("inicio renderiza secciones resumen y acceso a mas secciones", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  assert.deepEqual(panesOn(doc), ["inicio"]);
  assert.ok(doc.getElementById("g-ini-favs")
    .innerHTML.includes("Prod Uno"), "favorito visible en Inicio");
  const ini = doc.getElementById("ini-alerts");
  assert.ok(ini.innerHTML.includes("alert")
    || ini.textContent.includes("Todo al día"),
    "resumen accionable o estado 'al dia' presente");
  // el fab 'secciones' abre el sheet con todos los destinos
  doc.getElementById("moresec").click();
  assert.equal(doc.getElementById("dlg-nav").open, true);
  const stock = doc.querySelector('#dlg-nav .navitem[data-t="stock"]');
  assert.ok(stock, "stock alcanzable via mas secciones");
  doc.getElementById("dlg-nav")
    .onclick({ target: stock, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(panesOn(doc), ["stock"], "navitem navega a stock");
});

test("bottom nav: 4 destinos, navega y marca el activo", () => {
  const ctx = startup({ mobile: true });
  const doc = ctx.__doc;
  const btns = doc.querySelectorAll("#bnav button");
  assert.deepEqual(btns.map(b => b.dataset.t),
    ["inicio", "favs", "ofertas", "siman"]);
  const siman = btns.find(b => b.dataset.t === "siman");
  siman.click();
  assert.deepEqual(panesOn(doc), ["siman"]);
  assert.ok(siman.classSet.has("on"));
  assert.ok(!btns[0].classSet.has("on"), "inicio ya no activo");
});

test("paginacion progresiva: 24 por pagina, contador y boton", () => {
  const ctx = startup({ data: bigD(60),
                      stored: { "pw-tab": "cambios" } });
  const doc = ctx.__doc;
  const cards = () => doc.querySelectorAll("#g-cambios .card").length;
  const more = () => doc.querySelector('#more-cambios [data-more]');
  assert.equal(cards(), 24, "primera pagina de 24");
  assert.ok(more(), "boton 'Mostrar 24 mas' visible");
  assert.match(doc.querySelector("#more-cambios .meta").textContent,
    /24 de 60/);
  doc._fire("click", { target: more() });
  assert.equal(cards(), 48, "segunda pagina acumula");
  assert.match(doc.querySelector("#more-cambios .meta").textContent,
    /48 de 60/);
  doc._fire("click", { target: more() });
  assert.equal(cards(), 60, "todo mostrado");
  assert.ok(!more(), "boton desaparece al final");
  assert.match(doc.querySelector("#more-cambios .meta").textContent,
    /60 de 60/);
});

test("paginacion se reinicia al buscar", () => {
  const ctx = startup({ data: bigD(60),
                      stored: { "pw-tab": "cambios" } });
  const doc = ctx.__doc;
  doc._fire("click",
    { target: doc.querySelector('#more-cambios [data-more]') });
  assert.equal(doc.querySelectorAll("#g-cambios .card").length, 48);
  // filtrar por un producto de la segunda pagina: la ventana vuelve
  // a 24 y 'Prod 40' ya esta visible sin paginar
  run(ctx, 'document.getElementById("q").value = "prod 40"; render();');
  assert.equal(doc.querySelectorAll("#g-cambios .card").length, 1);
  assert.ok(!doc.querySelector('#more-cambios [data-more]'));
});

test("dialogo de compra: valida y registra unidades como filas", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'openPurchase("111")');
  const dlg = doc.getElementById("dlg-purchase");
  assert.equal(dlg.open, true, "dialogo abierto");
  const form = doc.getElementById("pu-form");
  const fire = () => form._fire("submit", { preventDefault() {} });
  // precio invalido: se queda abierto y no guarda nada
  doc.getElementById("pu-price").value = "abc";
  fire();
  assert.equal(dlg.open, true, "precio malo no cierra");
  assert.match(doc.getElementById("pu-err").textContent, /precio/i);
  assert.equal(run(ctx, "COMPRAS.length"), 0);
  // valido: 2 unidades => 2 filas unitarias con el mismo sku/fecha
  doc.getElementById("pu-price").value = "12.50";
  doc.getElementById("pu-qty").value = "2";
  doc.getElementById("pu-date").value = run(ctx, "PWData.today()");
  fire();
  assert.equal(dlg.open, false, "cierra tras guardar");
  const rows = run(ctx, "COMPRAS.filter(c => c.sku === '111')");
  assert.equal(rows.length, 2, "una fila por unidad");
  assert.equal(rows[0].paid, 12.5);
  assert.ok(rows[0].rid && rows[1].rid && rows[0].rid !== rows[1].rid,
    "rid estable y unico por fila");
});

test("dialogo de compra: fecha futura se rechaza y cancelar no muta", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'openPurchase("111")');
  doc.getElementById("pu-price").value = "10";
  doc.getElementById("pu-qty").value = "1";
  doc.getElementById("pu-date").value = "2999-01-01";
  doc.getElementById("pu-form")
    ._fire("submit", { preventDefault() {} });
  assert.equal(doc.getElementById("dlg-purchase").open, true);
  assert.match(doc.getElementById("pu-err").textContent, /fecha/i);
  assert.equal(run(ctx, "COMPRAS.length"), 0);
  // cancelar: cierra sin tocar nada
  doc.getElementById("pu-cancel").click();
  assert.equal(doc.getElementById("dlg-purchase").open, false);
  assert.equal(run(ctx, "COMPRAS.length"), 0);
});

test("carrito durable: lineas por namespace, aisladas por cuenta", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  run(ctx, 'cartToggle("111", true)');
  assert.equal(run(ctx, "CART.size"), 1);
  assert.equal(run(ctx, "Object.keys(CART_LINES).length"), 1);
  // se persistio bajo el namespace guest
  const saved = ctx.localStorage.getItem("pw:guest:pw-cart-lines");
  assert.ok(saved && saved.includes('"111"'), "linea guest persistida");
  // cambiar a una cuenta limpia no arrastra el carrito del invitado
  run(ctx, 'PWStore.activate("uA"); hydrateNS();');
  assert.equal(run(ctx, "CART.size"), 0, "cuenta A sin carrito guest");
  // volver a guest: el carrito sigue ahi (memoria/disco por namespace)
  run(ctx, 'PWStore.activate(null); hydrateNS();');
  assert.equal(run(ctx, "CART.size"), 1, "carrito guest intacto");
});

test("checkout: edita lineas y confirma compras unitarias", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'cartToggle("111", true)');
  run(ctx, "openCheckout()");
  const dlg = doc.getElementById("dlg-checkout");
  assert.equal(dlg.open, true);
  const row = doc.querySelector("#ck-rows .ckrow");
  assert.ok(row, "una fila de carrito");
  // edita cantidad: el draft persiste en CART_LINES via input
  const qi = row.querySelector(".ck-q");
  qi.value = "3";
  doc.getElementById("ck-rows")._fire("input", { target: qi });
  assert.equal(run(ctx, "CART_LINES['111'].quantity"), 3);
  // confirmar: 3 filas unitarias en COMPRAS y carrito vacio
  doc.getElementById("ck-date").value = run(ctx, "PWData.today()");
  doc.getElementById("ck-ok").click();
  assert.equal(run(ctx, 'COMPRAS.filter(c=>c.sku==="111").length'), 3);
  assert.equal(run(ctx, "CART.size"), 0);
  assert.equal(dlg.open, false);
});

test("checkout: quitar una linea no toca las demas y tiene undo", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' },
                        data: bigD(3) });
  ctx.D.products["111"] = DEMO_D.products["111"];
  ctx.D.series["111"] = DEMO_D.series["111"];
  ctx.D.agg["111"] = DEMO_D.agg["111"];
  const doc = ctx.__doc;
  run(ctx, 'cartToggle("111", true); cartToggle("p0", true)');
  run(ctx, "openCheckout()");
  const rows = doc.getElementById("ck-rows");
  assert.equal(rows.querySelectorAll(".ckrow").length, 2);
  // borra la linea de p0: las demas quedan
  const del = rows.querySelectorAll(".ckrow")
    .find(r => r.dataset.sku === "p0").querySelector(".ck-del");
  rows._fire("click", { target: del });
  assert.equal(run(ctx, "CART.size"), 1);
  assert.ok(run(ctx, 'CART.has("111")'), "la otra linea sobrevive");
  assert.equal(doc.getElementById("dlg-checkout").open, true,
    "con lineas restantes el dialogo sigue abierto");
  // deshacer restaura la linea con su draft
  const undo = doc.getElementById("toast-undo");
  assert.ok(undo, "toast con deshacer");
  undo.click();
  assert.equal(run(ctx, "CART.size"), 2);
});

test("toast undo restaura compra borrada", () => {
  const ctx = startup({ stored: {
    "pw-compras": '[{"sku":"111","paid":10,"date":"2026-09-29","rid":"r1"}]',
  } });
  const doc = ctx.__doc;
  assert.equal(run(ctx, "COMPRAS.length"), 1);
  run(ctx, 'descomprar("111")');
  assert.equal(run(ctx, "COMPRAS.length"), 0);
  assert.ok(doc.getElementById("toast").classSet.has("show"),
    "toast visible");
  doc.getElementById("toast-undo").click();
  assert.equal(run(ctx, "COMPRAS.length"), 1, "compra restaurada");
  assert.equal(run(ctx, 'COMPRAS[0].rid'), "r1", "mismo rid");
});

test("ficha: acciones accesibles y estrella con aria-pressed", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'openProd("111")');
  assert.equal(doc.getElementById("dlg").open, true);
  const star = doc.getElementById("dstar");
  assert.equal(star.tagName, "BUTTON");
  assert.equal(star.getAttribute("aria-pressed"), "true");
  for (const id of ["dcart", "dshare", "dtgt"])
    assert.ok(doc.getElementById(id), id + " existe en la ficha");
});

test("ficha movil: el dlg abre como modal y bloquea el fondo", () => {
  const ctx = startup({ mobile: true });
  const doc = ctx.__doc;
  run(ctx, 'openProd("111")');
  assert.equal(doc.getElementById("dlg").open, true);
  assert.ok(doc.body.classSet.has("locked"),
    "scroll del fondo bloqueado en movil");
  doc.getElementById("dlg").close();
  assert.equal(doc.getElementById("dlg").open, false);
  assert.ok(!doc.body.classSet.has("locked"));
});

test("frescura: dato viejo no afirma stock ni veredicto", () => {
  // generated viejo: todo queda 'stale' bajo PWData (sin lectura vigente)
  const old = { ...DEMO_D, generated: "2020-01-01",
                products: { "111": { ...DEMO_D.products["111"],
                                     observed_at: "2020-01-01" } } };
  const ctx = startup({ data: old, stored: { "pw-favs": '["111"]' } });
  const v = run(ctx, 'verdict("111")');
  assert.equal(v.label, "sin verificación reciente",
    `veredicto honesto: ${v.label}`);
  const html = run(ctx, 'card({sku:"111", type:"bajo", date:"2020-01-01",'
    + ' from:2500, to:2300, pct:-8, title:"Prod Uno"})');
  assert.ok(html.includes("sin verificación reciente"), html);
  // y NO dice 'sin stock' como si la lectura fuera de hoy
  assert.ok(!html.includes("sin stock"), "sin afirmacion de stock");
});

test("frescura: dato vigente si afirma y score>0", () => {
  const ctx0 = startup();
  const t = run(ctx0, "PWData.today()");
  const fresh = { ...DEMO_D, generated: t,
    products: { "111": { ...DEMO_D.products["111"], observed_at: t } },
    series: { "111": [[t, 2300, 1, 3]] } };
  const ctx = startup({ data: fresh, stored: { "pw-favs": '["111"]' } });
  assert.equal(run(ctx, 'PWData.product("111").state'), "available");
  assert.ok(run(ctx, 'PWData.score("111")') > 0, "score positivo");
  const v = run(ctx, 'verdict("111")');
  assert.ok(!/sin verificación|sin dato/.test(v.label),
    `veredicto: ${v.label}`);
});

test("siman: alertas viejas no se muestran como vigentes", () => {
  const oldSiman = { ...DEMO_D,
    siman: { generated: "2020-01-01", watches: [],
      items: [{ pid: "s1", t: "Zapato", b: "Nike", w: "zapato",
                p: 50, lp: 100, decl: true, avail: true,
                last: "2020-01-01" }],
      events: [], n_items: 1 } };
  const ctx = startup({ data: oldSiman,
                        stored: { "pw-tab": "siman" } });
  const doc = ctx.__doc;
  assert.equal(run(ctx, "simanAlerts().length"), 0,
    "alerta con lectura vieja no alerta");
  assert.match(doc.getElementById("siman-fresh").textContent,
    /2020-01-01/, "procedencia visible");
});

test("estado corrupto: sync congelado + recuperar + export", async () => {
  const ctx = startup({ stored: { "pw-outbox": "{basura rota" } });
  const doc = ctx.__doc;
  // la cuarentena marco la llave y el strip muestra el boton de arreglo
  assert.equal(run(ctx, "PWStore.corruptBlocking()"), true);
  assert.equal(doc.getElementById("ds-fix").style.display, "",
    "boton 'recuperar datos' visible");
  // sync no corre ni intenta nada de red mientras haya corruptos
  const ok = await run(ctx, "syncAll()");
  assert.equal(ok, false);
  assert.equal(ctx.__netCalls.length, 0);
  // el original quedo en cuarentena, exportable
  const exp = run(ctx, "PWStore.exportNS()");
  assert.ok(exp.quarantine && "pw-outbox" in exp.quarantine);
  // recuperar: tira la cola corrupta y reporta
  doc.getElementById("ds-fix").click();
  assert.equal(doc.getElementById("dlg-recover").open, true);
  doc.getElementById("rc-fix").click();
  await tick(); await tick();
  assert.equal(run(ctx, "PWStore.corruptBlocking()"), false);
});

test("export privado incluye compras y carrito del namespace", () => {
  const ctx = startup({ stored: {
    "pw-compras": '[{"sku":"111","paid":10,"date":"2026-09-29","rid":"r1"}]',
  } });
  run(ctx, 'cartToggle("111", true)');
  const exp = run(ctx, "PWStore.exportNS()");
  assert.equal(exp.data["pw-compras"].length, 1);
  assert.equal(exp.data["pw-cart-lines"]["111"].quantity, 1);
});

// ---- fase 1: compras/carrito — cantidad entera 1-99, dinero valido,
// cancelar seguro. Los handlers reales corren contra el DOM stub;
// nada de esto toca Appwrite ni la red (guest = sin outbox).
const twoSku = () => {
  const D = JSON.parse(JSON.stringify(DEMO_D));
  D.products["222"] = { title: "Prod Dos", brand: "M", category: "C",
                        slug: "prod-dos" };
  D.series["222"] = [["2026-09-29", 2000, 1, 0]];
  D.agg["222"] = { min: 2000, max: 2000, med: 2000 };
  return D;
};
const puFire = doc =>
  doc.getElementById("pu-form")._fire("submit", { preventDefault() {} });
const ckFire = (doc, id, ev) =>
  doc.getElementById(id)._fire("input", ev);

const BAD_QTY = ["1.5", "99.9", "1e-1", "2foo", "0", "-1", "100",
                 "", "abc"];
const BAD_PRICE = ["", "0", "-1", "abc", "10.001", "1e3", "10,01"];

test("compra: cantidad invalida nunca se trunca ni se guarda", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'openPurchase("111")');
  const dlg = doc.getElementById("dlg-purchase");
  doc.getElementById("pu-price").value = "10.00";
  doc.getElementById("pu-date").value = run(ctx, "PWData.today()");
  for (const bad of BAD_QTY) {
    doc.getElementById("pu-qty").value = bad;
    puFire(doc);
    assert.equal(dlg.open, true, `qty ${JSON.stringify(bad)} no cierra`);
    assert.match(doc.getElementById("pu-err").textContent,
      /cantidades|precios/i);
  }
  assert.equal(run(ctx, "COMPRAS.length"), 0);
  assert.equal(run(ctx, "OUTBOX.length"), 0, "guest jamas encola");
});

test("compra: precio invalido con cantidad valida no guarda", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'openPurchase("111")');
  const dlg = doc.getElementById("dlg-purchase");
  doc.getElementById("pu-qty").value = "2";
  doc.getElementById("pu-date").value = run(ctx, "PWData.today()");
  for (const bad of BAD_PRICE) {
    doc.getElementById("pu-price").value = bad;
    puFire(doc);
    assert.equal(dlg.open, true, `price ${JSON.stringify(bad)}`);
    assert.match(doc.getElementById("pu-err").textContent, /precio/i);
  }
  assert.equal(run(ctx, "COMPRAS.length"), 0);
  assert.equal(run(ctx, "OUTBOX.length"), 0);
});

test("compra: limites 1 y 99 unidades se aceptan", () => {
  for (const q of [1, 99]) {
    const ctx = startup({ stored: { "pw-favs": '["111"]' } });
    const doc = ctx.__doc;
    run(ctx, 'openPurchase("111")');
    doc.getElementById("pu-price").value = "1.00";
    doc.getElementById("pu-qty").value = String(q);
    doc.getElementById("pu-date").value = run(ctx, "PWData.today()");
    puFire(doc);
    assert.equal(doc.getElementById("dlg-purchase").open, false,
      `qty ${q} cierra`);
    assert.equal(run(ctx, 'COMPRAS.filter(c=>c.sku==="111").length'), q);
  }
});

test("checkout: qty/precio invalidos no confirman y preservan carrito", () => {
  const ctx = startup({ data: twoSku(),
                        stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'cartToggle("111", true); cartToggle("222", true)');
  for (const bad of BAD_QTY) {
    run(ctx, "openCheckout()");
    const row = doc.querySelector('#ck-rows .ckrow[data-sku="111"]');
    const qi = row.querySelector(".ck-q");
    qi.value = bad;
    ckFire(doc, "ck-rows", { target: qi });
    doc.getElementById("ck-ok").click();
    assert.equal(doc.getElementById("dlg-checkout").open, true,
      `qty ${JSON.stringify(bad)} no confirma`);
    assert.match(doc.getElementById("ck-err").textContent,
      /cantidades|precios|fecha/i);
    assert.equal(run(ctx, "COMPRAS.length"), 0);
    assert.equal(run(ctx, "CART.size"), 2, "carrito intacto");
    doc.getElementById("dlg-checkout").close();
  }
  for (const bad of BAD_PRICE) {
    run(ctx, "openCheckout()");
    const row = doc.querySelector('#ck-rows .ckrow[data-sku="111"]');
    const pi = row.querySelector(".ck-p");
    pi.value = bad;
    ckFire(doc, "ck-rows", { target: pi });
    doc.getElementById("ck-ok").click();
    assert.equal(doc.getElementById("dlg-checkout").open, true);
    assert.equal(run(ctx, "COMPRAS.length"), 0);
    doc.getElementById("dlg-checkout").close();
  }
  assert.equal(run(ctx, "OUTBOX.length"), 0);
});

test("ckTotal: aviso honesto y draft invalido no pisa linea valida", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'cartToggle("111", true)');
  run(ctx, "openCheckout()");
  const row = doc.querySelector('#ck-rows .ckrow[data-sku="111"]');
  const qi = row.querySelector(".ck-q"), pi = row.querySelector(".ck-p");
  qi.value = "2"; pi.value = "10.00";
  ckFire(doc, "ck-rows", { target: qi });
  assert.equal(doc.getElementById("ck-total").textContent,
    "total $20.00");
  assert.equal(run(ctx, "CART_LINES['111'].quantity"), 2);
  // draft invalido: el input no muta la cantidad valida persistida
  qi.value = "1.5";
  ckFire(doc, "ck-rows", { target: qi });
  assert.equal(run(ctx, "CART_LINES['111'].quantity"), 2,
    "draft 1.5 no se guardo");
  assert.equal(doc.getElementById("ck-total").textContent,
    "revisa precios y cantidades");
  // precio invalido: igual honesto, y tampoco pisa unitCents
  qi.value = "2"; pi.value = "abc";
  ckFire(doc, "ck-rows", { target: pi });
  assert.equal(doc.getElementById("ck-total").textContent,
    "revisa precios y cantidades");
  assert.equal(run(ctx, "CART_LINES['111'].unitCents"), 1000);
});

test("checkout: contrato 2x$10.00 — filas unitarias, sin duplicar", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'cartToggle("111", true)');
  run(ctx, "openCheckout()");
  const row = doc.querySelector('#ck-rows .ckrow[data-sku="111"]');
  const qi = row.querySelector(".ck-q"), pi = row.querySelector(".ck-p");
  qi.value = "2"; pi.value = "10.00";
  ckFire(doc, "ck-rows", { target: qi });
  assert.equal(doc.getElementById("ck-total").textContent,
    "total $20.00");
  doc.getElementById("ck-date").value = run(ctx, "todaySV()");
  doc.getElementById("ck-ok").click();
  const rows = run(ctx, 'COMPRAS.filter(c=>c.sku==="111")');
  assert.equal(rows.length, 2, "dos filas unitarias");
  assert.ok(rows.every(r => r.paid === 10));
  assert.ok(rows.every(r => r.date === run(ctx, "todaySV()")));
  assert.ok(rows[0].rid !== rows[1].rid, "rid estable por fila");
  const saved = JSON.parse(
    ctx.localStorage.getItem("pw:guest:pw-compras"));
  assert.equal(saved.length, 2, "persistidas en guest");
  assert.equal(run(ctx, "CART.size"), 0, "carrito vacio tras confirmar");
  assert.equal(doc.getElementById("dlg-checkout").open, false);
  // reenviar el mismo click con el dialogo cerrado: no duplica
  doc.getElementById("ck-ok").click();
  assert.equal(run(ctx, 'COMPRAS.filter(c=>c.sku==="111").length'), 2);
});

test("checkout: decimales suman centavos enteros (3x$10.01=$30.03)", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'cartToggle("111", true)');
  run(ctx, "openCheckout()");
  const row = doc.querySelector('#ck-rows .ckrow[data-sku="111"]');
  const qi = row.querySelector(".ck-q"), pi = row.querySelector(".ck-p");
  qi.value = "3"; pi.value = "10.01";
  ckFire(doc, "ck-rows", { target: qi });
  assert.equal(doc.getElementById("ck-total").textContent,
    "total $30.03", "centavos, nunca floats");
  doc.getElementById("ck-ok").click();
  const rows = run(ctx, 'COMPRAS.filter(c=>c.sku==="111")');
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.paid === 10.01));
  assert.equal(rows.reduce((t, r) => t + Math.round(r.paid * 100), 0),
    3003);
});

test("cancelar compra y checkout: nada muta, draft valido queda", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  // PU: llenar y cancelar — cero efecto
  run(ctx, 'openPurchase("111")');
  doc.getElementById("pu-price").value = "10.00";
  doc.getElementById("pu-qty").value = "2";
  doc.getElementById("pu-cancel").click();
  assert.equal(run(ctx, "COMPRAS.length"), 0);
  assert.equal(run(ctx, "OUTBOX.length"), 0);
  // checkout: draft valido queda (comportamiento intencional), la
  // membresia del carrito no cambia y nada se confirma
  run(ctx, 'cartToggle("111", true)');
  run(ctx, "openCheckout()");
  const row = doc.querySelector('#ck-rows .ckrow[data-sku="111"]');
  const qi = row.querySelector(".ck-q"), pi = row.querySelector(".ck-p");
  qi.value = "5"; pi.value = "8.50";
  ckFire(doc, "ck-rows", { target: qi });
  doc.getElementById("ck-cancel").click();
  assert.equal(run(ctx, "COMPRAS.length"), 0);
  assert.equal(run(ctx, "OUTBOX.length"), 0);
  assert.ok(run(ctx, 'CART.has("111")'), "carrito conservado");
  assert.equal(run(ctx, "CART_LINES['111'].quantity"), 5,
    "draft retenido para la proxima apertura");
  // reabrir muestra el draft; cancelar otra vez sigue sin mutar
  run(ctx, "openCheckout()");
  assert.equal(
    doc.querySelector('#ck-rows .ckrow[data-sku="111"] .ck-q').value,
    "5");
  doc.getElementById("ck-cancel").click();
  assert.equal(run(ctx, "COMPRAS.length"), 0);
});

test("checkout multirow: una linea invalida bloquea TODO el commit", () => {
  const ctx = startup({ data: twoSku(),
                        stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  run(ctx, 'cartToggle("111", true); cartToggle("222", true)');
  run(ctx, "openCheckout()");
  const r1 = doc.querySelector('#ck-rows .ckrow[data-sku="111"]'),
        r2 = doc.querySelector('#ck-rows .ckrow[data-sku="222"]');
  r1.querySelector(".ck-q").value = "2";
  r1.querySelector(".ck-p").value = "10.00";
  r2.querySelector(".ck-q").value = "0";        // invalida
  r2.querySelector(".ck-p").value = "5.00";
  ckFire(doc, "ck-rows", { target: r2.querySelector(".ck-q") });
  doc.getElementById("ck-ok").click();
  assert.equal(doc.getElementById("dlg-checkout").open, true);
  assert.equal(run(ctx, "COMPRAS.length"), 0,
    "nada parcial: ni la linea valida se compro");
  assert.equal(run(ctx, "CART.size"), 2, "ambas lineas retenidas");
  assert.equal(doc.getElementById("ck-total").textContent,
    "revisa precios y cantidades");
});
