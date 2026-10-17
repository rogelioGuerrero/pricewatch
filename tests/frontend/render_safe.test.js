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

test("sCard: link javascript: no produce data-l ni onclick", () => {
  const ctx = booted();
  const html = run(ctx, `sCard({pid:"s1", t:"Zapato", b:"Nike",
    w:"zapato", l:"javascript:alert(1)", img:"", p:80, lp:100,
    decl:true, avail:true, last:"2026-10-16"})`);
  assert.ok(!html.includes("data-l"), "sin data-l en link inseguro");
  assert.ok(!html.includes("window.open"), "sin handler clickable");
});

test("sCard: link https legit queda clickeable y escapado", () => {
  const ctx = booted();
  const html = run(ctx, `sCard({pid:"s1", t:"Zapato", b:"Nike",
    w:"zapato", l:"https://sv.siman.com/zapato_1?a=1&b=2", img:"",
    p:80, lp:100, decl:true, avail:true, last:"2026-10-16"})`);
  assert.ok(html.includes("data-l="), "https si enlaza");
  assert.ok(!html.includes("&b=2\""), "el & no queda crudo en el attr");
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
