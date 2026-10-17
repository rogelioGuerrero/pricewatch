"use strict";
// startup.test.js — el arranque completo de la app (los 5 módulos en
// orden, como el loader de index.html) contra el template real.
// Regresión: el auto-click del tab corría ANTES de `let cf/OF_F/...` —
// render() leía cf en TDZ y moria toda app.js. Tambien: tab invalido
// interpolado en selector (SyntaxError), generated vacio (Invalid
// Date en SCUT) y CDN de echarts caido con ficha abierta.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, DEMO_D, vm } = require("./harness.js");

const panesOn = doc =>
  doc.querySelectorAll(".pane.on").map(e => e.id.slice(5));
const TABS_ALL = ["favs", "cambios", "ofertas", "stock", "nuevos",
                  "siman", "explorar"];

function startup(opts) {
  const ctx = makeCtx(opts);
  boot(ctx);
  return ctx;
}

test("arranque default: Mi lista activa, app cableada hasta el final", () => {
  const ctx = startup({ stored: { "pw-favs": '["111"]' } });
  const doc = ctx.__doc;
  assert.deepEqual(panesOn(doc), ["favs"]);
  const tab = doc.querySelector('.tab[data-t="favs"]');
  assert.ok(tab.classSet.has("on"));
  assert.equal(tab.getAttribute("aria-selected"), "true");
  // el click del tab persiste la eleccion y llega hasta el final de
  // app.js (setInterval del chequeo de version corre una sola vez)
  assert.equal(ctx.localStorage.getItem("pw-tab"), "favs");
  assert.equal(ctx.__intervals.n, 1);
  assert.equal(doc.getElementById("gen").textContent, "29 sep 2026");
  // render lleno el pane: la card del favorito existe con su spark
  assert.ok(doc.querySelector("#g-favs .card"));
  // nada de red: ni fetch ni Appwrite se tocaron
  assert.equal(ctx.__netCalls.length, 0);
});

test("tabs marcados como role=tab dentro de tablist", () => {
  const ctx = startup();
  const doc = ctx.__doc;
  assert.equal(doc.getElementById("tabs").getAttribute("role"), "tablist");
  for (const t of doc.querySelectorAll(".tab")) {
    assert.equal(t.tagName, "BUTTON");
    assert.equal(t.getAttribute("role"), "tab");
    assert.equal(t.getAttribute("aria-controls"), "pane-" + t.dataset.t);
  }
  for (const p of doc.querySelectorAll(".pane"))
    assert.equal(p.getAttribute("role"), "tabpanel");
});

test("roving tabindex y vínculo tab↔panel", () => {
  const ctx = startup();
  const doc = ctx.__doc;
  const tabs = doc.querySelectorAll(".tab");
  for (const t of tabs) {
    assert.equal(t.id, "tab-" + t.dataset.t);
    // aria-labelledby conecta el panel con el tab que lo abre
    const pane = doc.getElementById("pane-" + t.dataset.t);
    assert.equal(pane.getAttribute("aria-labelledby"), t.id);
    const active = t.dataset.t === "favs";
    assert.equal(t.tabIndex, active ? 0 : -1, `tabIndex de ${t.id}`);
  }
  // mover el foco mueve el tabindex activo
  doc.querySelector('.tab[data-t="stock"]').click();
  const activos = tabs.filter(t => t.tabIndex === 0);
  assert.deepEqual(activos.map(t => t.dataset.t), ["stock"]);
});

test("cada tab guardado en localStorage abre su pane", () => {
  for (const id of TABS_ALL) {
    const ctx = startup({ stored: { "pw-tab": id } });
    assert.deepEqual(panesOn(ctx.__doc), [id],
      `pw-tab=${id} debio activar pane-${id}`);
  }
});

test("cada tab por URL (?tab=) abre su pane", () => {
  for (const id of TABS_ALL) {
    const ctx = startup({ search: "?tab=" + id });
    assert.deepEqual(panesOn(ctx.__doc), [id],
      `?tab=${id} debio activar pane-${id}`);
  }
});

test("?tab de URL gana sobre localStorage", () => {
  const ctx = startup({ stored: { "pw-tab": "stock" },
                        search: "?tab=nuevos" });
  assert.deepEqual(panesOn(ctx.__doc), ["nuevos"]);
  assert.equal(ctx.localStorage.getItem("pw-tab"), "nuevos");
});

test("tab invalido/malicioso cae a Mi lista sin SyntaxError", () => {
  for (const bad of ['x"]', "foo[", "a.b", "*", '"]][data-t="',
                     "explorar,x"]) {
    const ctx = startup({ stored: { "pw-tab": bad } });
    assert.deepEqual(panesOn(ctx.__doc), ["favs"],
      `pw-tab=${JSON.stringify(bad)} debio caer a favs`);
  }
  const ctx = startup({ search: "?tab=" + encodeURIComponent('q"][') });
  assert.deepEqual(panesOn(ctx.__doc), ["favs"]);
});

test("pantalla angosta: 'explorar' no existe y cae a favs", () => {
  const ctx = startup({ mobile: true, stored: { "pw-tab": "explorar" } });
  assert.deepEqual(panesOn(ctx.__doc), ["favs"]);
  // el tab tampoco esta en la barra
  assert.ok(!ctx.__doc.querySelector('.tab[data-t="explorar"]'));
});

test("generated vacio: header 'sin datos' y el arranque no muere", () => {
  const D = { ...DEMO_D, generated: "" };
  const ctx = startup({ data: D, stored: { "pw-tab": "siman" } });
  const doc = ctx.__doc;
  assert.equal(doc.getElementById("gen").textContent, "sin datos");
  assert.deepEqual(panesOn(doc), ["siman"]);
  assert.equal(ctx.__intervals.n, 1);
});

test("sin echarts + deep link ?sku: ficha abre, graficas ocultas con aviso", () => {
  const ctx = startup({ search: "?sku=111" });
  const doc = ctx.__doc;
  assert.deepEqual(panesOn(doc), ["favs"]);
  const dlg = doc.getElementById("dlg");
  assert.equal(dlg.open, true, "el deep link debio abrir la ficha");
  assert.equal(doc.getElementById("dtitle").textContent, "Prod Uno");
  // contenedores de grafica ocultos + aviso visible; tabla completa
  assert.equal(doc.getElementById("chart").style.display, "none");
  assert.equal(doc.getElementById("dcal").style.display, "none");
  assert.equal(doc.getElementById("dnograph").style.display, "");
  assert.match(doc.getElementById("dnograph").textContent,
    /gráficas no cargadas/);
  assert.ok(doc.getElementById("dtable").innerHTML.includes("2026-09-29"));
  assert.equal(ctx.__netCalls.length, 0);
});

test("con echarts el deep link inicializa la grafica de la ficha", () => {
  const ctx = makeCtx({ search: "?sku=111", echarts: true });
  boot(ctx);
  const doc = ctx.__doc;
  assert.ok(ctx.echarts.inits >= 1, "echarts.init debio correr");
  assert.equal(doc.getElementById("chart").style.display, "block");
  assert.equal(doc.getElementById("dnograph").style.display, "none");
});

test("teclado: ArrowRight/Home/End mueven foco Y activan", () => {
  const ctx = startup();
  const doc = ctx.__doc;
  const tabsEl = doc.getElementById("tabs");
  const tabs = doc.querySelectorAll(".tab");
  const fire = (key, i) => tabsEl._fire("keydown",
    { key, target: tabs[i], preventDefault() {} });
  fire("ArrowRight", 0);
  assert.deepEqual(panesOn(doc), ["cambios"]);
  assert.equal(doc.activeElement, tabs[1]);
  fire("End", 1);
  assert.equal(doc.activeElement, tabs[tabs.length - 1]);
  fire("Home", tabs.length - 1);
  assert.deepEqual(panesOn(doc), ["favs"]);
  assert.equal(doc.activeElement, tabs[0]);
  fire("ArrowLeft", 0);   // wrap-around al ultimo
  assert.equal(doc.activeElement, tabs[tabs.length - 1]);
});

test("los módulos evalúan completos: funciones clave quedan definidas", () => {
  const ctx = startup();
  for (const f of ["openProd", "render", "syncAll", "verdict",
                   "paintBar", "loadExplorer"])
    assert.equal(vm.runInContext(`typeof ${f}`, ctx), "function",
      `${f} debio quedar definida tras el eval completo`);
});
