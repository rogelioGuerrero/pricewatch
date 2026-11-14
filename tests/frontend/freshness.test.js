"use strict";
// freshness.test.js — fase 2: las etiquetas de accion dependen de la
// observacion vigente (PWData). Reloj congelado por contexto via
// Date.now ANTES de boot: el corte 06:00 SV, las fuentes con fecha
// propia y el precio valido mandan; un dato viejo/invalido/futuro
// confiesa en vez de proclamar stock, ganga, objetivo o resurtido.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCtx, boot, vm } = require("./harness.js");

const run = (ctx, js) => vm.runInContext(js, ctx);
const FREEZE = Date.parse("2026-11-12T14:00:00Z");   // 08:00 SV
const OBS = "2026-11-12", OLD = "2026-11-04", YEST = "2026-11-11";

// fija el reloj ANTES de boot: freshness/state evaluan DEALS y
// veredictos con el Date.now del contexto
const startup = (opts = {}, now = FREEZE) => {
  const ctx = makeCtx(opts);
  vm.runInContext("Date.now = () => " + now, ctx);
  boot(ctx);
  return ctx;
};

// fixture minimo del contrato real: 3 lecturas validas que cierran en
// la fecha de observacion, precio 1000c, stock 1, agregado consistente
const fx = ({ gen = OBS, obs = OBS, price = 1000, stock = 1,
              saving = 0, quality, clubs, clubh, siman,
              ofertas } = {}) => ({
  generated: gen, built: "b-fx", n_products: 1,
  quality: quality
    || { sources: { pricesmart: { observed_at: gen } } },
  products: { "111": { title: "Prod Uno", brand: "M", category: "C",
                       slug: "p1", observed_at: obs } },
  series: { "111": [[obs, 2000, 1, 0], [obs, 1500, 1, 0],
                    [obs, price, stock, saving]] },
  agg: { "111": { min: 1000, max: 2000, pct_min: 0, n_ch: 2,
                  last_ch: obs, vs_med: -33, d_out: 0, n_out: 0 } },
  events: [], ofertas: ofertas || [], clubs: clubs || {},
  clubh: clubh || {},
  siman: siman || { items: [], events: [], watches: [] },
  mis: [], demo: false,
});

// lista sembrada: favorito + compra pagada $12 + objetivo $15 —
// todo elegible SOLO con observacion vigente y precio comprable
const STORED = {
  "pw-favs": '["111"]',
  "pw-compras": '[{"sku":"111","paid":12,"date":"2026-11-01","rid":"p1"}]',
  "pw-targets": '{"111":1500}',
};
const OF_SEED = [{ sku: "111", price: 1000, saving: 500,
                   date: OBS, title: "Prod Uno" }];

test("frescura: lectura vieja + compra pagada no afirma nada accionable", () => {
  const ctx = startup({ data: fx({ gen: OLD, obs: OLD,
                                   ofertas: OF_SEED }),
                        stored: STORED });
  const doc = ctx.__doc;
  const v = run(ctx, 'verdict("111")');
  assert.equal(v.rank, 9);
  assert.equal(v.label, "sin verificación reciente");
  const al = doc.getElementById("alerts").textContent;
  assert.ok(!al.includes("resurtir"),
    "pagada vieja nunca recibe resurtir: " + al);
  assert.ok(!al.includes("objetivo"), "sin alerta de objetivo: " + al);
  assert.equal(run(ctx, "DEALS.length"), 0,
    "DEALS prefiltrado por frescura al evaluar el modulo");
  assert.ok(doc.getElementById("g-ini-deals").innerHTML
      .includes("Sin gangas"));
  // el historial se conserva: ultima lectura $10 sigue visible
  const card = run(ctx, 'favCard("111")');
  assert.ok(card.includes("$10.00"), card);
  run(ctx, "goTab('favs')");
  const sum = doc.getElementById("favs-sum").textContent;
  assert.match(sum, /0 en buen precio/);
  assert.match(sum, /0 sin stock/, "vencido NO es sin stock");
  assert.match(sum, /1 sin verificar/, sum);
});

test("frescura: lectura vigente si declara resurtir, objetivo y ganga", () => {
  const ctx = startup({ data: fx({ ofertas: OF_SEED }),
                        stored: STORED });
  const doc = ctx.__doc;
  const al = doc.getElementById("alerts").textContent;
  assert.match(al, /para resurtir/, al);
  assert.match(al, /objetivo/, al);
  assert.ok(run(ctx, "DEALS.includes('111')"), "ganga vigente");
  assert.ok(doc.getElementById("g-ini-deals").innerHTML
      .includes("Prod Uno"), "ganga visible en Inicio");
  run(ctx, "goTab('favs')");
  assert.match(doc.getElementById("favs-sum").textContent,
               /1 en buen precio/);
});

test("frescura: fuente vigente pero observacion del producto vieja es stale", () => {
  const ctx = startup({ data: fx({ gen: OBS, obs: OLD }),
                        stored: STORED });
  assert.equal(run(ctx, 'PWData.product("111").state'), "stale");
  assert.equal(run(ctx, 'verdict("111")').rank, 9);
  assert.ok(!run(ctx, 'PWData.buyable("111")'));
});

test("frescura: precio invalido nunca es comprable ni accionable", () => {
  for (const price of [null, 0, -100, 0.1, NaN, Infinity]) {
    // saving>0 hace significativa la ausencia de la tag de oferta
    const ctx = startup({ data: fx({ price, saving: 3,
                                     ofertas: OF_SEED }),
                          stored: STORED });
    const tag = `precio=${price}`;
    assert.equal(run(ctx, 'PWData.buyable("111")'), false, tag);
    const v = run(ctx, 'verdict("111")');
    assert.equal(v.rank, 9, tag);
    assert.equal(v.label, "sin precio verificado", tag);
    assert.equal(run(ctx, "DEALS.length"), 0, tag);
    const al = ctx.__doc.getElementById("alerts").textContent;
    assert.ok(!al.includes("resurtir") && !al.includes("objetivo"), tag);
    const card = run(ctx, 'favCard("111")');
    assert.ok(!card.includes("tag oferta"), tag);
  }
});

test("frescura: fuente fallida es desconocida, no sin stock; stock 0 vigente si lo es", () => {
  // quality.ok=false => "sin dato verificado", jamas "sin stock"
  const bad = fx({ quality: { sources: { pricesmart:
      { observed_at: OBS, ok: false } } }, ofertas: OF_SEED });
  const ctx = startup({ data: bad, stored: STORED });
  assert.equal(run(ctx, 'PWData.product("111").state'), "unknown");
  const v = run(ctx, 'verdict("111")');
  assert.equal(v.rank, 9);
  assert.equal(v.label, "sin dato verificado");
  assert.ok(!run(ctx, "FAVFF.sinstock('111')"),
    "fuente fallida no cuenta como quiebre");
  // stock 0 con observacion de hoy => sin stock real y sin gangas
  const ctx2 = startup({ data: fx({ stock: 0, ofertas: OF_SEED }),
                         stored: STORED });
  assert.equal(run(ctx2, 'PWData.product("111").state'), "unavailable");
  const v2 = run(ctx2, 'verdict("111")');
  assert.equal(v2.rank, 8);
  assert.equal(v2.label, "sin stock");
  assert.ok(run(ctx2, "FAVFF.sinstock('111')"));
  assert.equal(run(ctx2, "DEALS.length"), 0);
});

test("frescura: club usa su propia observacion — ✓/✗ solo vigente", () => {
  const club = c => ({ "111": { "Club X": c } });
  const favClub = { "pw-club": "Club X", "pw-favs": '["111"]' };
  // lectura vieja: ni in_stock:true ni in_stock:false afirman simbolo
  for (const s of [true, false]) {
    const ctx = startup({ data: fx({ clubs: club(
        { in_stock: s, observed_at: OLD }) }), stored: favClub });
    const html = run(ctx, 'favCard("111")');
    assert.ok(html.includes("Club X sin verificar"), html);
    assert.ok(!html.includes("✓") && !html.includes("✗"), html);
  }
  // vigente: true=>✓, false=>✗
  for (const [s, sym] of [[true, "✓"], [false, "✗"]]) {
    const ctx = startup({ data: fx({ clubs: club(
        { in_stock: s, observed_at: OBS }) }), stored: favClub });
    assert.ok(run(ctx, 'favCard("111")').includes(`Club X ${sym}`));
  }
  // sin fecha propia: desconocido, no toma prestada la del producto
  const ctxM = startup({ data: fx({ clubs: club({ in_stock: true }) }),
                         stored: favClub });
  const htmlM = run(ctxM, 'favCard("111")');
  assert.ok(htmlM.includes("Club X sin verificar"), htmlM);
  assert.ok(!htmlM.includes("Club X 11-12"),
    "la fecha del producto no se presta al club");
  // historial de club propio (clubh) provee la fecha: vieja => stale
  const ctxH = startup({ data: fx({
      clubs: club({ in_stock: true }),
      clubh: { "111": { "Club X": [["2026-11-04", 1]] } } }),
    stored: favClub });
  const htmlH = run(ctxH, 'favCard("111")');
  assert.ok(htmlH.includes("Club X sin verificar 11-04"), htmlH);
});

test("frescura: alertas Siman exigen metadata propia vigente + precio", () => {
  const item = over => ({ pid: "s1", t: "Zapato", b: "Nike", w: "zap",
    p: 50, lp: 100, decl: true, avail: true, last: OBS, ...over });
  const data = (sman, quality) => fx({ siman: sman,
    quality: quality || { sources: { pricesmart: { observed_at: OBS },
                                    siman: { observed_at: OBS } } } });
  const withSiman = (sman, quality) =>
    startup({ data: data(sman, quality), stored: {} });
  // vigente + disponible + precio positivo => alerta
  const ctx = withSiman({ generated: OBS, watches: [],
    items: [item()], events: [], n_items: 1 });
  assert.equal(run(ctx, "simanAlerts().length"), 1);
  // fuente vieja / item viejo / fecha generada ausente => ninguna
  const stale = withSiman({ generated: OLD, watches: [],
    items: [item({ last: OLD })], events: [] });
  assert.equal(run(stale, "simanAlerts().length"), 0, "fuente vieja");
  const oldItem = withSiman({ generated: OBS, watches: [],
    items: [item({ last: OLD })], events: [] });
  assert.equal(run(oldItem, "simanAlerts().length"), 0, "item viejo");
  const noGen = withSiman({ watches: [], items: [item()], events: [] });
  assert.equal(run(noGen, "simanAlerts().length"), 0,
    "sin generated propio: la fuente PriceSmart vigente no lo hace fresco");
  // precio nulo o redondeado a cero => sin alerta
  for (const p of [null, 0]) {
    const c = withSiman({ generated: OBS, watches: [],
      items: [item({ p })], events: [] });
    assert.equal(run(c, "simanAlerts().length"), 0, `p=${p}`);
  }
  // fuente Siman fallida => desconocida, sin alerta
  const bad = withSiman({ generated: OBS, watches: [],
    items: [item()], events: [] },
    { sources: { pricesmart: { observed_at: OBS },
                 siman: { observed_at: OBS, ok: false } } });
  assert.equal(run(bad, "simanAlerts().length"), 0, "quality false");
});

test("frescura: el corte es a las 06:00 SV, no a medianoche UTC", () => {
  // 05:59:59 SV del 12 => ayer 11 todavia es lectura vigente (gracia)
  const pre = startup({ data: fx({ gen: YEST, obs: YEST }) },
                      Date.parse("2026-11-12T11:59:59Z"));
  assert.equal(run(pre, 'PWData.product("111").state'), "available");
  // 06:00:00 SV exacto => ayer ya vencio
  const post = startup({ data: fx({ gen: YEST, obs: YEST }) },
                       Date.parse("2026-11-12T12:00:00Z"));
  assert.equal(run(post, 'PWData.product("111").state'), "stale");
  // 05:59 UTC del 12 = 23:59 SV del 11: no hay gracia post-corte;
  // una observacion del 10 ya es stale aunque la hora UTC sea <12
  const utcTrick = startup({ data: fx({ gen: "2026-11-10",
                                        obs: "2026-11-10" }) },
                           Date.parse("2026-11-12T05:59:00Z"));
  assert.equal(run(utcTrick, 'PWData.product("111").state'), "stale");
  // observacion futura => desconocida, no fresca
  const fut = startup({ data: fx({ gen: "2026-11-13",
                                   obs: "2026-11-13" }) });
  assert.equal(run(fut, 'PWData.product("111").state'), "unknown");
});

test("frescura: cruzar las 06:00 SV re-evalua y el timer del corte repinta", () => {
  // boot justo antes del corte: ayer aun tiene gracia
  const ctx = makeCtx({ data: fx({ gen: YEST, obs: YEST,
                                   ofertas: OF_SEED }),
                        stored: STORED });
  vm.runInContext("Date.now = () => "
    + Date.parse("2026-11-12T11:59:59Z"), ctx);
  // captura los timeouts ANTES de boot para ubicar el del corte
  const timers = [];
  ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms });
                                return timers.length; };
  boot(ctx);
  const doc = ctx.__doc;
  assert.ok(run(ctx, "DEALS.includes('111')"));
  assert.ok(doc.getElementById("g-ini-deals").innerHTML
      .includes("Prod Uno"));
  const al0 = doc.getElementById("alerts").textContent;
  assert.match(al0, /resurtir/);
  assert.match(al0, /objetivo/);
  // el timeout del corte se programa con el delay exacto al proximo
  // barrido: 1ms mas alla de 06:00 SV
  const want = run(ctx, "Date.parse(PWData.nextSweep()) - Date.now() + 1");
  const cutoff = timers.find(t => t.ms === want);
  assert.ok(cutoff, "timeout del corte de frescura registrado");
  // avanza el reloj a 06:00:00 SV: la gracia vencio
  vm.runInContext("Date.now = () => "
    + Date.parse("2026-11-12T12:00:00Z"), ctx);
  // disparar el timer repinta SOLO — ningun render manual
  cutoff.fn();
  assert.ok(!doc.getElementById("g-ini-deals").innerHTML
      .includes("Prod Uno"), "Inicio quita la ganga vencida");
  const al1 = doc.getElementById("alerts").textContent;
  assert.ok(!al1.includes("resurtir") && !al1.includes("objetivo"),
    "alertas desaparecen tras el corte: " + al1);
  run(ctx, "goTab('ofertas')");
  assert.ok(doc.getElementById("g-ofertas").innerHTML
      .includes("Sin gangas"), "Gangas reevalua DEALS al pintar");
});

test("frescura: ficha abierta se repinta al corte sin pisar inputs", () => {
  // ficha abierta sobre lectura de ayer aun vigente (gracia), con club
  // propio observado ayer — el corte la vence SIN reabrir el dialogo
  const ctx = makeCtx({ data: fx({ gen: YEST, obs: YEST,
      clubs: { "111": { "Club X": { in_stock: true,
                                     observed_at: YEST, qty: 3 } } } }),
    stored: { "pw-club": "Club X" } });
  vm.runInContext("Date.now = () => "
    + Date.parse("2026-11-12T11:59:59Z"), ctx);
  const timers = [];
  ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms });
                                return timers.length; };
  boot(ctx);
  const doc = ctx.__doc;
  run(ctx, 'openProd("111")');
  const clubCell = () => doc.querySelectorAll("#dclubs td[data-stock-club]")
    .find(td => td.dataset.stockClub === "Club X");
  assert.ok(doc.getElementById("dlg").open, "ficha abierta");
  assert.ok(clubCell().textContent.includes("✓"), "club vigente ✓");
  assert.ok(!doc.getElementById("dobs").textContent.includes("vencido"),
    "lectura en gracia no dice vencida");
  // objetivo a medio escribir: nunca guardado, no debe perderse
  doc.getElementById("dtgt").value = "12.34";
  const want = run(ctx, "Date.parse(PWData.nextSweep()) - Date.now() + 1");
  const cutoff = timers.find(t => t.ms === want);
  assert.ok(cutoff, "timeout del corte registrado");
  vm.runInContext("Date.now = () => "
    + Date.parse("2026-11-12T12:00:00Z"), ctx);
  cutoff.fn();
  assert.ok(doc.getElementById("dobs").textContent.includes("vencido"),
    "dobs confiesa lectura vencida tras el corte");
  assert.ok(clubCell().textContent.includes("sin verificación"),
    "club vencido dice sin verificacion");
  assert.ok(!clubCell().textContent.includes("✓")
      && !clubCell().textContent.includes("agotado"),
    "ni ✓ ni agotado sobre lectura vencida");
  assert.equal(doc.getElementById("dtgt").value, "12.34",
    "input no guardado intacto — no se reabrio la ficha");
  assert.ok(doc.getElementById("dlg").open, "dialogo sigue abierto");
});

test("frescura: evento oferta historico conserva datos pero confiesa lectura", () => {
  const ctx = startup({ data: fx({ gen: OLD, obs: OLD }) });
  const html = run(ctx, `card({type:"oferta", sku:"111", price:1000,
    saving:300, date:"2026-11-04", title:"Prod Uno"})`);
  assert.ok(html.includes("2026-11-04"), "fecha historica visible");
  assert.ok(html.includes("$10.00"), "precio historico visible");
  assert.ok(!html.includes("oferta real"), html);
  assert.ok(!html.includes("ahorra"), "no promete ahorro vigente");
  assert.ok(html.includes("ahorro observado"), html);
  assert.ok(html.includes("sin verificación reciente"),
    "tag explicita de lectura vencida: " + html);
});
