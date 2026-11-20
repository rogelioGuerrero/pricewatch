"use strict";
// Genera tests/fixtures/verdicts_front_golden.json: salidas ACTUALES
// de PWData (freshness.js) y state.js (atMin/dealOK/DEALS) sobre casos
// minimos, con Date.now congelado por caso ANTES del boot.
// El agg de cada caso NO se escribe a mano: se calcula con
// verdicts.compute_agg + price_verdict via tests/gen_front_agg.py —
// la misma via que build_site usa para publicarlo (schema 3).
// Correr SOLO con el codigo cuyo comportamiento se quiere fijar:
//   node tests/frontend/gen_verdicts_golden.js
// Un diff en el fixture = cambio de comportamiento (revisar).
const fs = require("fs"), path = require("path"), os = require("os");
const { execSync } = require("child_process");
const { makeCtx, boot, vm } = require("./harness.js");

const OBS = "2026-11-12", OLD = "2026-11-04", YEST = "2026-11-11";
// horas SV congeladas por caso: 08:00 (post-sweep), 05:59:59 (gracia)
const NOW_0800 = Date.parse("2026-11-12T14:00:00Z");
const NOW_0559 = Date.parse("2026-11-12T11:59:59Z");

// mismo fixture minimo que freshness.test.js; agg llega por inyeccion
// (calculado por python abajo), no a mano
const fx = ({ gen = OBS, obs = OBS, price = 1000, stock = 1,
              saving = 0, current, quality, clubs, clubh,
              ofertas, series, schema } = {}) => ({
  schema_version: schema === undefined ? 3 : schema,
  generated: gen, built: "b-fx", n_products: 1,
  quality: quality
    || { sources: { pricesmart: { observed_at: gen } } },
  products: { "111": { title: "Prod Uno", brand: "M", category: "C",
                       slug: "p1", observed_at: obs,
                       ...(current === undefined ? {} : { current }) } },
  series: { "111": series
              || [[obs, 2000, 1, 0], [obs, 1500, 1, 0],
                  [obs, price, stock, saving]] },
  agg: {},
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
  { name: "precio_cero_en_medio",
    // un 0 historico ya no tumba min/pct_min (divergencia #1
    // resuelta): min=1500, ultimo precio en el piso -> at_min y
    // deal publicados; antes el veredicto se apagaba
    data: fx({ series: [["2026-11-10", 2000, 1, 0],
                        ["2026-11-11", 0, 1, 0],
                        ["2026-11-12", 1500, 1, 0]] }),
    now: NOW_0800 },
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
  { name: "schema_v2_sin_veredicto",
    // payload viejo (schema 2): los stats estan pero at_min/score no
    // viajaron -> el front degrada a "sin veredicto" aunque los
    // datos darían ganga (pct_min 0, n_ch>0); la vigencia sigue igual
    data: fx({ schema: 2,
      series: [["2026-11-10", 1500, 1, 0],
               ["2026-11-11", 1600, 1, 0],
               ["2026-11-12", 1500, 1, 0]] }),
    now: NOW_0800 },
];

// el agg lo calcula python con el pipeline real: compute_agg +
// price_verdict sobre la serie exportada (tests/gen_front_agg.py)
const tmpIn = path.join(os.tmpdir(),
                        "pw-agg-in-" + process.pid + ".json");
const tmpOut = path.join(os.tmpdir(),
                         "pw-agg-out-" + process.pid + ".json");
const inp = {};
for (const c of CASES)
  inp[c.name] = { series: c.data.series,
                  generated: c.data.generated };
fs.writeFileSync(tmpIn, JSON.stringify(inp));
execSync("python \"" + path.join(__dirname, "..", "gen_front_agg.py")
         + "\" \"" + tmpIn + "\" \"" + tmpOut + "\"");
const AGG = JSON.parse(fs.readFileSync(tmpOut, "utf8"));
fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut);
for (const c of CASES) {
  const a = { ...(AGG[c.name] || {}) };
  // schema 2 = payload viejo: los campos de veredicto NO viajaron
  if ((c.data.schema_version || 0) < 3)
    for (const a2 of Object.values(a)) {
      delete a2.at_min;
      delete a2.score;
    }
  c.data.agg = a;
}

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
  note: ("volcado post-fase-2 (frescura estricta + veredicto estatico "
         + "en agg, schema 3). now = epoch ms de Date.now congelado "
         + "antes del boot; expected = salidas reales de "
         + "PWData/state.js; agg calculado por verdicts.py"),
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
