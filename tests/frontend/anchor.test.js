"use strict";
// anchor.test.js — la estafa del ancla inflada en el front: subida
// fuerte sostenida pocos dias + bajada presentada como oferta. El
// build detecta (agg.anch) y el cliente etiqueta los hechos; la
// mediana secuestrada deja de proclamar gangas en todas sus vias.
// Fixture central: el caso real del Ninja Crispi (SKU 513177,
// PriceSmart, Black Friday 2026) que motivo el detector.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, vm } = require("./harness.js");

// reloj congelado al mediodia SV del 26-nov-2026 (18:00 UTC) — el dia
// que el ninja aparecio "en oferta" a $187.99
const NOW = Date.parse("2026-11-26T18:00:00Z");

const SERIE_NINJA = [["2026-11-19", 18499, 1],
                     ["2026-11-20", 21499, 1],
                     ["2026-11-21", 21499, 1],
                     ["2026-11-22", 21499, 1],
                     ["2026-11-23", 21499, 1],
                     ["2026-11-24", 21499, 1],
                     ["2026-11-25", 21499, 1],
                     ["2026-11-26", 18799, 1]];

// el agg tal como lo publicaria el build: mediana secuestrada en el
// inflado (6 de 8 lecturas), SIN score (el ahorro real es <=0) y con
// los hechos del ancla
const ninjaD = ({ price = 18799, saving = 0 } = {}) => {
  const series = SERIE_NINJA.map((r, i) =>
    i === SERIE_NINJA.length - 1 ? [r[0], price, 1, ...(saving ? [saving] : [])] : r);
  return {
    schema_version: 3,
    generated: "2026-11-26", built: "b-test", n_products: 1,
    quality: { sources: { pricesmart: { observed_at: "2026-11-26" } } },
    products: { "111": { title: "Ninja Crispi", brand: "Ninja",
                         category: "Electrodomesticos", slug: "ninja",
                         observed_at: "2026-11-26" } },
    series: { "111": series },
    agg: { "111": { min: 18499, max: 21499, med: 21499, pct_min: 1.6,
                    vs_med: -12.6, n_ch: 2, last_ch: "2026-11-26",
                    anch: { pre: 18499, pct: 16.2, d: 6,
                            rose: "2026-11-20" } } },
    events: [], ofertas: saving
      ? [{ sku: "111", price, saving, date: "2026-11-26",
           title: "Ninja Crispi" }] : [],
    clubs: {}, clubh: {},
    siman: { items: [], events: [], watches: [] },
    mis: [], demo: false,
  };
};

const startup = data => {
  const ctx = makeCtx({ data });
  vm.runInContext("Date.now = () => " + NOW, ctx);
  boot(ctx);
  return ctx;
};
const run = (ctx, js) => vm.runInContext(js, ctx);

test("ancla ninja: veredicto 'oferta inflada' con los hechos y fechas", () => {
  const ctx = startup(ninjaD());
  const v = run(ctx, 'verdict("111")');
  assert.equal(v.label, "oferta inflada");
  assert.equal(v.rank, 7, "tan malo como 'arriba de lo habitual'");
  assert.equal(v.cls, "subio");
  assert.match(v.tip, /16\.2% el 20 nov/, "subida y fecha: " + v.tip);
  assert.match(v.tip, /aguantó 6d/, "duracion del inflado");
  assert.match(v.tip, /\$184\.99/, "referencia honesta");
  assert.match(v.tip, /\$3\.00 más caro/, "la verdad: cuesta MAS");
});

test("ancla ninja: ni letrero ni minimo la salvan del veredicto malo", () => {
  // aunque la tienda ponga letrero de ahorro, el framing positivo
  // no puede tapar la inflada — el ancla va primero
  const ctx = startup(ninjaD({ saving: 2.0 }));
  const v = run(ctx, 'verdict("111")');
  assert.equal(v.label, "oferta inflada");
});

test("ancla ninja: fuera de DEALS, del chip 'bajo' y con score 0", () => {
  const ctx = startup(ninjaD());
  assert.equal(run(ctx, "DEALS.length"), 0,
    "la mediana secuestrada no proclama ganga");
  assert.equal(run(ctx, 'dealOK("111", "bajo")'), false);
  assert.equal(run(ctx, 'PWData.score("111")'), 0,
    "sin ahorro real no hay fuerza de ganga");
});

test("ancla ninja: ni siquiera con letrero entra por via de mediana", () => {
  // con letrero si entra a DEALS — el letrero es un hecho — pero
  // llega etiquetada como lo que es, no como ganga
  const ctx = startup(ninjaD({ saving: 2.0 }));
  assert.equal(run(ctx, "JSON.stringify(DEALS)"), '["111"]');
  assert.equal(run(ctx, 'verdict("111").label'), "oferta inflada");
});

test("ancla ninja: la ficha muestra los hechos, no el 'habitual'", () => {
  const ctx = startup(ninjaD());
  run(ctx, 'openProd("111")');
  const html = ctx.__doc.getElementById("dvs").innerHTML;
  assert.match(html, /subió 16\.2% el 20 nov y aguantó 6d/);
  assert.match(html, /antes costaba \$184\.99/);
  assert.ok(!html.includes("precio habitual"),
    "la mediana secuestrada no se repite: " + html);
});

test("descuento exagerado: hay ahorro real pero se reporta el honesto", () => {
  // misma inflada, pero hoy SI esta bajo el pre-subida: ahorro real
  // (18499-17000)/18499 = 8.1% — no el -20.7% que sugiere el ancla
  const ctx = startup(ninjaD({ price: 17000 }));
  const v = run(ctx, 'verdict("111")');
  assert.equal(v.label, "descuento exagerado");
  assert.equal(v.rank, 4);
  assert.match(v.tip, /ahorro real 8\.1%/);
  assert.match(v.tip, /\$184\.99/);
  assert.match(v.tip, /maquillaje/);
});

test("oferta inflada en empate exacto: el ahorro es cero", () => {
  const ctx = startup(ninjaD({ price: 18499 }));
  const v = run(ctx, 'verdict("111")');
  assert.equal(v.label, "oferta inflada");
  assert.match(v.tip, /el ahorro es cero/);
});

test("sin ancla e historia corta: la ficha no pronuncia 'habitual'", () => {
  // 3 lecturas en 2 dias con vs_med negativo: la mediana es ruido —
  // antes la ficha la mostraba igual (el hueco que vio el usuario)
  const d = ninjaD();
  d.series["111"] = [["2026-11-24", 20000, 1],
                     ["2026-11-25", 18000, 1],
                     ["2026-11-26", 15000, 1]];
  d.agg["111"] = { min: 15000, max: 20000, med: 18000, pct_min: 0,
                   vs_med: -16.7, n_ch: 2, last_ch: "2026-11-26" };
  const ctx = startup(d);
  run(ctx, 'openProd("111")');
  const html = ctx.__doc.getElementById("dvs").innerHTML;
  assert.ok(!html.includes("precio habitual"),
    "mediana de 3 lecturas no se pronuncia: " + html);
});

test("historia suficiente sin ancla: 'habitual' y 'bajo' siguen vivos", () => {
  // regresion contra el exceso de guardia: 6 lecturas en 20d con el
  // ultimo tramo bajo — el veredicto rank 3 y la linea del modal
  // sobreviven
  const d = ninjaD();
  d.series["111"] = [["2026-11-06", 20000, 1],
                     ["2026-11-10", 20000, 1],
                     ["2026-11-14", 20000, 1],
                     ["2026-11-18", 20000, 1],
                     ["2026-11-22", 20000, 1],
                     ["2026-11-26", 15000, 1]];
  d.agg["111"] = { min: 15000, max: 20000, med: 20000, pct_min: 0,
                   vs_med: -25, n_ch: 1, last_ch: "2026-11-26",
                   at_min: true, score: 0.25 };
  const ctx = startup(d);
  const v = run(ctx, 'verdict("111")');
  assert.ok(["bajo lo habitual", "mínimo histórico", "sigue barato"]
    .includes(v.label) || v.rank <= 3, "veredicto positivo: " + v.label);
  assert.equal(run(ctx, 'dealOK("111", "bajo")'), true,
    "chip 'bajo' con mediana confiable");
  run(ctx, 'openProd("111")');
  assert.match(ctx.__doc.getElementById("dvs").innerHTML,
    /vs precio habitual/, "la linea habitual vive con historia");
});

test("carrito: 'vs típico' no estima con mediana secuestrada", () => {
  const ctx = startup(ninjaD());
  run(ctx, 'cartToggle("111", true)');
  const bar = ctx.__doc.getElementById("shop-tot").innerHTML;
  assert.ok(!bar.includes("vs típico"),
    "sin estimacion desde una mediana inflada: " + bar);
});
