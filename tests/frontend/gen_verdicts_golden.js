"use strict";
// Genera tests/fixtures/verdicts_front_golden.json: salidas ACTUALES
// de PWData (freshness.js) y state.js (atMin/dealOK/DEALS) sobre casos
// minimos, con Date.now congelado por caso ANTES del boot.
// Correr SOLO con el codigo cuyo comportamiento se quiere fijar:
//   node tests/frontend/gen_verdicts_golden.js
// Un diff en el fixture = cambio de comportamiento (revisar).
const fs = require("fs"), path = require("path");
const { makeCtx, boot, vm } = require("./harness.js");

const OBS = "2026-11-12", OLD = "2026-11-04", YEST = "2026-11-11";
// horas SV congeladas por caso: 08:00 (post-sweep), 05:59:59 (gracia)
const NOW_0800 = Date.parse("2026-11-12T14:00:00Z");
const NOW_0559 = Date.parse("2026-11-12T11:59:59Z");

// mismo fixture minimo que freshness.test.js
const fx = ({ gen = OBS, obs = OBS, price = 1000, stock = 1,
              saving = 0, current, quality, clubs, clubh,
              ofertas } = {}) => ({
  generated: gen, built: "b-fx", n_products: 1,
  quality: quality
    || { sources: { pricesmart: { observed_at: gen } } },
  products: { "111": { title: "Prod Uno", brand: "M", category: "C",
                       slug: "p1", observed_at: obs,
                       ...(current === undefined ? {} : { current }) } },
  series: { "111": [[obs, 2000, 1, 0], [obs, 1500, 1, 0],
                    [obs, price, stock, saving]] },
  agg: { "111": { min: 1000, max: 2000, pct_min: 0, n_ch: 2,
                  last_ch: obs, vs_med: -33, d_out: 0, n_out: 0 } },
  events: [], ofertas: ofertas || [], clubs: clubs || {},
  clubh: clubh || {},
  siman: { items: [], events: [], watches: [] },
  mis: [], demo: false,
});

const OF_SEED = [{ sku: "111", price: 1000, saving: 500,
                   date: OBS, title: "Prod Uno" }];

const CASES = [
  { name: "fresco_con_oferta",
    data: fx({ ofertas: OF_SEED }), now: NOW_0800 },
  { name: "vencido_1_dia_en_gracia",
    // 05:59 SV: con la gracia vieja era vigente; con fecha estricta
    // ya vencio (diff del paso B, fijado a proposito)
    data: fx({ gen: YEST, obs: YEST, ofertas:
      [{ sku: "111", price: 1000, saving: 500,
         date: YEST, title: "Prod Uno" }] }),
    now: NOW_0559 },
  { name: "vencido_1_dia_post_corte",
    data: fx({ gen: YEST, obs: YEST }), now: NOW_0800 },
  { name: "vencido_2_dias",
    data: fx({ gen: "2026-11-10", obs: "2026-11-10" }),
    now: NOW_0559 },
  { name: "fuente_fallida",
    data: fx({ quality: { sources:
      { pricesmart: { observed_at: OBS, ok: false } } } }),
    now: NOW_0800 },
  { name: "current_false",
    data: fx({ current: false }), now: NOW_0800 },
  { name: "sin_stock",
    data: fx({ stock: 0 }), now: NOW_0800 },
  { name: "precio_none",
    data: fx({ price: null }), now: NOW_0800 },
  { name: "precio_cero",
    data: fx({ price: 0 }), now: NOW_0800 },
  { name: "observacion_vieja_fuente_fresca",
    data: fx({ obs: OLD }), now: NOW_0800 },
  { name: "observacion_futura",
    data: fx({ gen: "2026-11-13", obs: "2026-11-13" }),
    now: NOW_0800 },
  { name: "club_observado_hoy",
    data: fx({ clubs: { "111": { "Club X":
      { in_stock: true, observed_at: OBS, qty: 3 } } } }),
    now: NOW_0800 },
  { name: "club_observado_ayer",
    data: fx({ clubs: { "111": { "Club X":
      { in_stock: true, observed_at: YEST, qty: 3 } } } }),
    now: NOW_0800 },
];

const EVAL = `JSON.stringify({
  product: PWData.product("111"),
  product_club: PWData.product("111", "Club X"),
  buyable: PWData.buyable("111"),
  buyable_club: PWData.buyable("111", "Club X"),
  score: PWData.score("111"),
  atMin: atMin("111"),
  dealOK: {
    letrero: dealOK("111", "letrero"),
    silenciosa: dealOK("111", "silenciosa"),
    real: dealOK("111", "real"),
    min: dealOK("111", "min"),
    bajo: dealOK("111", "bajo"),
    all: dealOK("111", "all"),
  },
  DEALS: DEALS,
})`;

const out = { meta: {
  note: ("volcado post-paso-B (frescura estricta a fecha SV). now = "
         + "epoch ms de Date.now congelado antes del boot; expected = "
         + "salidas reales de PWData/state.js"),
}, cases: [] };

for (const c of CASES) {
  const ctx = makeCtx({ data: c.data, stored: {} });
  vm.runInContext("Date.now = () => " + c.now, ctx);
  boot(ctx);
  out.cases.push({
    name: c.name, now: c.now, data: c.data, stored: {},
    expected: JSON.parse(vm.runInContext(EVAL, ctx)),
  });
  console.log("  " + c.name);
}

const dst = path.join(__dirname, "..", "fixtures",
                      "verdicts_front_golden.json");
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify(out, null, 1) + "\n");
console.log("-> " + dst + " (" + out.cases.length + " casos)");
