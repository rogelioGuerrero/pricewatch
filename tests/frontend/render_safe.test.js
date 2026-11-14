"use strict";
// render_safe.test.js — escaping/URLs en las cards reales (render.js,
// siman.js). El payload viene de APIs de terceros: imagen/categoría se
// interpolan a innerHTML y el link externo a window.open.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, vm } = require("./harness.js");

function booted(opts) {
  const ctx = makeCtx(opts);
  boot(ctx);
  return ctx;
}
const run = (ctx, js) => vm.runInContext(js, ctx);

test("safeHttpURL: solo http(s); javascript:/vacío devuelven ''", () => {
  const ctx = booted();
  const out = run(ctx, `[
    safeHttpURL("https://siman.com/p/1"),
    safeHttpURL("http://x.sv/a"),
    safeHttpURL("javascript:alert(1)"),
    safeHttpURL("data:text/html,<h1>"),
    safeHttpURL("ftp://x"),
    safeHttpURL(""),
    safeHttpURL(null),
    safeHttpURL("/relativa/ok"),
  ]`);
  assert.equal(out[0], "https://siman.com/p/1");
  assert.equal(out[1], "http://x.sv/a");
  assert.equal(out[2], "");
  assert.equal(out[3], "");
  assert.equal(out[4], "");
  assert.equal(out[5], "");
  assert.equal(out[6], "");
  assert.equal(out[7], "http://localhost/relativa/ok");
});

test("sCard: link javascript: no produce href ni onclick", () => {
  const ctx = booted();
  const html = run(ctx, `sCard({pid:"s1", t:"Zapato", b:"Nike",
    w:"zapato", l:"javascript:alert(1)", img:"", p:80, lp:100,
    decl:true, avail:true, last:"2026-10-16"})`);
  assert.ok(!html.includes('href="javascript'), "sin href inseguro");
  assert.ok(!html.includes("window.open"), "sin handler clickable");
  // sin link seguro la card no lleva ningun anchor (titulo en texto)
  assert.ok(!html.includes("<a "), `sin anchors: ${html}`);
});

test("sCard: link https legit queda clickeable y escapado", () => {
  const ctx = booted();
  const html = run(ctx, `sCard({pid:"s1", t:"Zapato", b:"Nike",
    w:"zapato", l:"https://sv.siman.com/zapato_1?a=1&b=2", img:"",
    p:80, lp:100, decl:true, avail:true, last:"2026-10-16"})`);
  assert.ok(
    html.includes('href="https://sv.siman.com/zapato_1?a=1&amp;b=2"'),
    `https si enlaza con & escapado: ${html}`);
  assert.ok(!html.includes("&b=2\""), "el & no queda crudo en el attr");
  // anchor externo seguro: nueva pestana sin opener
  assert.ok(html.includes('rel="noopener"'));
});

test("sCard: imagen con comilla escapada", () => {
  const ctx = booted();
  const html = run(ctx, `sCard({pid:"s1", t:"X", w:"z", l:"",
    img:'a" onerror="b', p:80, last:"2026-10-16"})`);
  assert.ok(html.includes("a&quot; onerror=&quot;b"),
    `img escapada: ${html}`);
  assert.ok(html.includes('alt=""'), "alt decorativo");
});

test("card: imagen y categoría del producto se escapan", () => {
  const ctx = booted();
  ctx.D.products["111"].image = 'img"x.png';
  ctx.D.products["111"].category = 'Cat<script>x';
  const html = run(ctx, `card({sku:"111", type:"bajo", date:"2026-09-29",
    from:2500, to:2300, pct:-8, title:"Prod Uno"})`);
  assert.ok(html.includes('src="img&quot;x.png"'), `src escapado: ${html}`);
  assert.ok(html.includes("Cat&lt;script&gt;x"),
    `categoría escapada: ${html}`);
  assert.ok(html.includes('alt=""'), "alt decorativo");
});

test("favCard: imagen con comilla escapada", () => {
  const ctx = booted({ stored: { "pw-favs": '["111"]' } });
  ctx.D.products["111"].image = 'y" onerror="z';
  const html = run(ctx, `favCard("111")`);
  assert.ok(html.includes("y&quot; onerror=&quot;z"),
    `img escapada: ${html}`);
  assert.ok(html.includes('alt=""'), "alt decorativo");
});

// fase 4: una sku ALMACENADA con payload JS llegaba cruda a los
// handlers inline ('...${sku}...' rompia el literal). jsArg emite el
// argumento como literal JSON escapado: el atributo decodificado es
// JS valido y la sku llega intacta al handler, jamas como codigo
test("handlers inline: la sku almacenada es literal, jamas codigo", () => {
  const PAY1 = `'+(globalThis.__inlineInjected=true)+'`;
  const PAY2 = String.raw`a"b\c&d'e<x`;
  const ctx = booted({ stored: {
    "pw-favs": JSON.stringify([PAY1, PAY2]) }});
  const doc = ctx.__doc;
  const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  // invocar como el browser: atributo decodificado evaluado con
  // this=elemento y un event de verdad
  const box = doc.createElement("div");
  const fire = (el, attr) => {
    ctx.__el = el;
    run(ctx, `(function(event){ ${unesc(el.getAttribute(attr))} })`
      + `.call(__el, {target:__el, preventDefault(){},`
      + ` stopPropagation(){}})`);
  };
  // -- estrella de favCard: toggleFav recibe el literal completo --
  box.innerHTML = run(ctx, `favCard(${JSON.stringify(PAY1)})`);
  fire(box.querySelector(".star"), "onclick");
  assert.equal(run(ctx, `globalThis.__inlineInjected`), undefined,
    "el payload NO se ejecuto");
  assert.equal(run(ctx, `FAV.has(${JSON.stringify(PAY1)})`), false,
    "toggleFav quito el favorito con la sku literal");
  // -- checkbox de carrito (modo compra) --
  run(ctx, `SHOP = true`);
  box.innerHTML = run(ctx, `favCard(${JSON.stringify(PAY2)})`);
  const chk = box.querySelector(".cartcheck");
  chk.checked = true;
  fire(chk, "onclick");
  assert.equal(run(ctx, `CART.has(${JSON.stringify(PAY2)})`), true,
    "cartToggle agrego la sku literal al carrito");
  // -- switch 'lo compre': abre el dialogo con la sku literal --
  box.innerHTML =
    run(ctx, `buySwitch(${JSON.stringify(PAY2)}, false)`);
  const sw = box.querySelector(".sw input");
  sw.checked = true;
  fire(sw, "onchange");
  assert.equal(doc.getElementById("dlg-purchase").open, true);
  assert.equal(run(ctx, `PU_SKU === ${JSON.stringify(PAY2)}`), true,
    "openPurchase recibio la sku literal");
  doc.getElementById("dlg-purchase").close();
  // -- 'detalle' de card y favCard: openProd con el literal --
  box.innerHTML = run(ctx, `card({type:"bajo", date:"2026-11-01",
    from:2000, to:1500, pct:-25, title:"X",
    sku:${JSON.stringify(PAY1)}})`);
  fire(box.querySelector(".det"), "onclick");
  assert.equal(doc.getElementById("dlg").open, true);
  assert.equal(doc.getElementById("dlg").dataset.sku, PAY1,
    "openProd recibio la sku literal completa");
  doc.getElementById("dlg").close();
  box.innerHTML = run(ctx, `favCard(${JSON.stringify(PAY2)})`);
  fire(box.querySelector(".det"), "onclick");
  assert.equal(doc.getElementById("dlg").dataset.sku, PAY2);
  doc.getElementById("dlg").close();
  // ningun handler ejecuto codigo ni toco la red
  assert.equal(run(ctx, `globalThis.__inlineInjected`), undefined);
  assert.equal(ctx.__netCalls.length, 0);
});
