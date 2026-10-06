// app.js - wiring de UI: tabs, FAB, modo compra, explorador
// Perspective, ficha de producto, push e init. Va ultimo:
// al evaluarse ya existen todos los modulos.

// declaradas arriba: el auto-click del ultimo tab (linea ~33) puede
// llamar paintBar() durante el eval, antes de cualquier let mas abajo
let chart, chCal;
const BARS = {};
const TABS = [
  ["favs","Mi lista", FAV.size],
  ["cambios","Movimientos", byType("bajo").length + byType("subio").length + byType("oferta_termino").length + byType("rebaja").length],
  ["ofertas","Gangas", DEALS.length],
  ["stock","Se acabó / Volvió",
   byType("agotado").length + byType("reaparecio").length
   + byType("salio_del_catalogo").length + byType("regreso").length],
  ["nuevos","Nuevos", byType("nuevo").length],
  ["siman","Siman", simanAlerts().length],
  ["explorar","Catálogo", D.n_products],
];
// el catalogo es una datagrid Perspective: herramienta de escritorio.
// En pantalla angosta la tabla es inusable y el WASM pesa en datos
// moviles — fuera del TABS lo saca de la barra y del FAB a la vez
if (matchMedia("(max-width:700px)").matches)
  TABS.splice(TABS.findIndex(t => t[0] === "explorar"), 1);
$("#tabs").innerHTML = TABS.map(([id,n,nr]) =>
  `<div class="tab" data-t="${id}">${n}<span class="n">${nr}</span></div>`).join("");
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));
  document.querySelectorAll(".pane").forEach(x=>x.classList.remove("on"));
  t.classList.add("on");
  document.getElementById("pane-"+t.dataset.t).classList.add("on");
  localStorage.setItem("pw-tab", t.dataset.t);
  const lbl = TABS.find(x=>x[0]===t.dataset.t);
  $("#fab-label").textContent = lbl ? lbl[1] : "";
  if (t.dataset.t==="favs" && favFilter!=="all") {
    favFilter = "all"; render(); }
  if (t.dataset.t==="explorar") loadExplorer();
  if (t.dataset.t==="cambios") paintBar("ch-cambios");
  if (t.dataset.t==="ofertas") paintBar("ch-ofertas");
});
// abre en el ultimo tab usado (o Mi lista)
const urlTab = new URLSearchParams(location.search).get("tab");
(document.querySelector(`.tab[data-t="${urlTab || localStorage.getItem("pw-tab") || "favs"}"]`)
  || document.querySelector('.tab[data-t="favs"]'))?.click();

const goTab = id => document.querySelector(`.tab[data-t="${id}"]`)?.click();
let cf = "all", OF_F = "all", PV_PRE = "all", pvRefresh = null;
const setCf = v => { cf = v;
  document.querySelectorAll("#f-cambios .chip")
    .forEach(x => x.classList.toggle("on", x.dataset.cf === v)); };
document.querySelectorAll("#f-cambios .chip")
  .forEach(c => c.onclick = () => { setCf(c.dataset.cf); render(); });
document.querySelectorAll("#f-ofertas .chip")
  .forEach(c => c.onclick = () => { OF_F = c.dataset.of;
    document.querySelectorAll("#f-ofertas .chip")
      .forEach(x => x.classList.toggle("on", x === c));
    render(); });
// FAB + hoja movil: arriba el Resumen accionable, abajo las secciones
const dlgNav = document.getElementById("dlg-nav");
$("#fab").onclick = () => {
  $("#navres").innerHTML = RESUMEN.length
    ? `<div class="navsec">Resumen${RESUMEN_N ? " "+RESUMEN_N : ""}
        · datos al ${+_d} ${MESES[+_m-1]}</div>`
      + RESUMEN.map(([t,tab,cf,ff,sk]) =>
        `<div class="navitem res" data-t="${tab}" data-cf="${cf||""}"
           data-ff="${ff||""}"${sk?` data-sku="${sk}"`:""}><span>${t}</span>
           <span class="meta">›</span></div>`).join("")
    : "";
  $("#navitems").innerHTML = `<div class="navsec">Secciones</div>`
    + TABS.map(([id,n,nr]) =>
      `<div class="navitem${document.querySelector(`.tab[data-t="${id}"]`).classList.contains("on")?" on":""}"
        data-t="${id}"><span>${n}</span>
        <span class="meta">${nr}</span></div>`).join("");
  dlgNav.showModal();
};
$("#dlg-nav").onclick = e => {
  const it = e.target.closest(".navitem"); if (!it) return;
  dlgNav.close();
  if (it.dataset.sku) { openProd(it.dataset.sku); return; }
  if (it.dataset.t === "cambios") setCf(it.dataset.cf || "all");
  goTab(it.dataset.t);
  favFilter = it.dataset.ff || "all";
  render();
};
$("#alerts").onclick = e => {
  const a = e.target.closest(".alert"); if (!a) return;
  if (a.dataset.sku) { openProd(a.dataset.sku); return; }
  if (a.dataset.tab === "cambios") setCf(a.dataset.cf || "all");
  goTab(a.dataset.tab);
  if (a.dataset.ff) favFilter = a.dataset.ff;
  render();
};
$("#fav-filter").onclick = () => { favFilter = "all"; render(); };


// ---- modo compra (carrito) ----
$("#shopmode").onclick = () => {
  SHOP = !SHOP;
  document.body.classList.toggle("shop", SHOP);
  $("#shopmode").classList.toggle("on", SHOP);
  render();
};
$("#cart-clear").onclick = () => { CART.clear(); saveCart(); render(); };
$("#done-btn").onclick = () => {
  if (!CART.size) return;
  const n = [...CART].filter(s => (D.series[s]||[]).length).length;
  if (!confirm(`¿Registrar ${n} compras al precio de hoy?`)) return;
  [...CART].forEach(comprarAuto);
  CART.clear(); saveCart();
  SHOP = false; document.body.classList.remove("shop");
  $("#shopmode").classList.remove("on");
  render();
};
// el buscador global: >=2 letras muestra panel de resultados del catalogo
// completo sobre cualquier tab; tambien filtra las tablas Perspective
function pspFilter(id){
  const q = $("#q").value.trim();
  const f = [];
  if (q) f.push(/^\d+$/.test(q) ? ["sku","contains",q]
                               : ["producto","contains",q]);
  if (document.getElementById("stok1").checked) f.push(["stock","==","sí"]);
  (PV_PRESETS[PV_PRE]||[]).forEach(x => f.push(x));
  document.getElementById(id).restore({filter: f});
}
$("#q").oninput = () => {
  const q = $("#q").value.trim();
  const t = document.querySelector(".tab.on")?.dataset.t;
  document.querySelectorAll(".pane").forEach(x=>x.classList.remove("on"));
  // en tabs de tarjetas: panel de resultados del catalogo;
  // en tabs de tabla: la tabla queda y se filtra sola;
  // en siman: el campo filtra sus propias cards, no tapa con catalogo
  if (q.length >= 2 && t !== "explorar" && t !== "siman")
    document.getElementById("pane-buscar").classList.add("on");
  else document.getElementById("pane-"+t)?.classList.add("on");
  render();
  if (t === "explorar" && pvDone) pspFilter("pv");
};

const COLS_BASE = ["sku","producto","marca","categoria","precio","ahorro",
                   "desc_pct","stock"];
const COLS_ADV = ["min_hist","max_hist","pct_sobre_min","vs_tipico_pct",
                  "ult_chg_pct","n_cambios","ult_cambio","dias_cambio",
                  "oferta_cada_d","ult_oferta_d","n_ofertas","ahorro_tipico",
                  "pct_dias_stock","dias_agotado","n_veces_agotado","mi_club"];
// presets del comprador: filtros Perspective sin saber pivots
// mismos criterios que atMin(): minimo vigente = en el piso, se movio
// alguna vez, y el ultimo cambio tiene <=30d (vencen, no son eternas)
const PV_PRESETS = {
  real:       [["ahorro",">",0],["pct_sobre_min","<=",0],["n_cambios",">",0],
                ["dias_cambio","<=",30]],
  silenciosa: [["pct_sobre_min","<=",0],["n_cambios",">",0],["ahorro","==",0],
                ["dias_cambio","<=",30]],
  min:        [["pct_sobre_min","<=",0],["n_cambios",">",0],
                ["dias_cambio","<=",30]],
  up:         [["ult_chg_pct",">",0]],
  clubout:    [["mi_club","==","no"]],
};
async function loadExplorer(attempt=0){
  if (pvDone) return;
  const pane = document.getElementById("pane-explorar");
  const msg = t => { pane.querySelector(".pv-status")?.remove();
    pane.insertAdjacentHTML("beforeend", `<p class="meta pv-status" style="padding:10px">${t}</p>`); };
  msg("Cargando catálogo (WASM, solo la primera vez)…");
  try {
    const psp = (await import('https://cdn.jsdelivr.net/npm/@finos/perspective@3.8.0/dist/cdn/perspective.js')).default;
    await import('https://cdn.jsdelivr.net/npm/@finos/perspective-viewer@3.8.0/dist/cdn/perspective-viewer.js');
    await import('https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-datagrid@3.8.0/dist/cdn/perspective-viewer-datagrid.js');
    await import('https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-d3fc@3.8.0/dist/cdn/perspective-viewer-d3fc.js');
    const mkRows = () => Object.entries(D.products).map(([sku,p])=>{
      const ser = D.series[sku]||[], l = ser.slice(-1)[0],
            prev = ser.slice(-2)[0];
      const a = D.agg[sku]||{};
      const mc = MYCLUB ? (D.clubs[sku]||{})[MYCLUB] : null;
      return {sku, producto:p.title, marca:p.brand||"", categoria:p.category||"",
        precio: l?+(l[1]/100).toFixed(2):null,
        ahorro: l?+((l[3]||0).toFixed(2)):0,
        desc_pct: l&&l[1]?+((l[3]||0)/(l[1]/100)*100).toFixed(1):0,
        stock: l?(l[2]?"sí":"no"):"?",
        min_hist: a.min!=null?+(a.min/100).toFixed(2):null,
        max_hist: a.max!=null?+(a.max/100).toFixed(2):null,
        pct_sobre_min: a.pct_min ?? null,
        vs_tipico_pct: a.vs_med ?? null,
        ult_chg_pct: l&&prev&&prev[1]
          ? +((l[1]-prev[1])/prev[1]*100).toFixed(1) : null,
        n_cambios: a.n_ch ?? null, ult_cambio: a.last_ch||"",
        dias_cambio: a.last_ch
          ? Math.round((Date.parse(D.generated)-Date.parse(a.last_ch))/864e5)
          : null,
        oferta_cada_d: a.of_every ?? null, ult_oferta_d: a.of_last ?? null,
        n_ofertas: a.n_of ?? null,
        ahorro_tipico: a.of_save ?? null,
        pct_dias_stock: a.pct_stock ?? null, dias_agotado: a.d_out ?? 0,
        n_veces_agotado: a.n_out ?? 0,
        mi_club: mc ? (mc.in_stock?"sí":"no") : "—"};
    });
    const worker = await psp.worker();
    const table = await worker.table(mkRows());
    const pv = document.getElementById("pv");
    await pv.load(table);
    await pv.restore({plugin: "Datagrid", theme: "Pro Dark",
                      columns: COLS_BASE,
                      aggregates: {precio:"avg", pct_sobre_min:"avg",
                        vs_tipico_pct:"avg", ahorro:"sum", desc_pct:"avg",
                        n_cambios:"sum", dias_agotado:"avg",
                        oferta_cada_d:"avg", n_ofertas:"sum"}});
    pvDone = true;
    pane.querySelector(".pv-status")?.remove();
    document.getElementById("grp1").onchange = e =>
      pv.restore({group_by: e.target.value ? [e.target.value] : []});
    document.getElementById("stok1").onchange = () => pspFilter("pv");
    document.getElementById("adv").onchange = e =>
      pv.restore({columns: e.target.checked ? COLS_BASE.concat(COLS_ADV)
                                            : COLS_BASE});
    const ppOut = document.querySelector('[data-pp="clubout"]');
    if (ppOut && !MYCLUB) ppOut.style.display = "none";
    document.querySelectorAll("#pane-explorar [data-pp]").forEach(c =>
      c.onclick = () => {
        PV_PRE = PV_PRE === c.dataset.pp ? "all" : c.dataset.pp;
        document.querySelectorAll("#pane-explorar [data-pp]")
          .forEach(x => x.classList.toggle("on", x.dataset.pp === PV_PRE));
        pspFilter("pv");
      });
    // si cambia el club con la tabla ya cargada, se reconstruye mi_club
    // conservando la configuracion del viewer
    pvRefresh = async () => {
      const cfg = await pv.save();
      const t2 = await worker.table(mkRows());
      await pv.load(t2); await pv.restore(cfg); pspFilter("pv");
    };
    if ($("#q").value.trim() || document.getElementById("stok1").checked)
      pspFilter("pv");
    pv.addEventListener("perspective-click", e => {
      const r = e.detail?.row;
      if (r && r.sku != null && D.products[String(r.sku)]) openProd(String(r.sku));
    });
  } catch(e) {
    if (attempt < 2) { msg("Reintentando…"); await new Promise(r=>setTimeout(r,1500)); return loadExplorer(attempt+1); }
    msg("No se pudo cargar el catálogo (CDN/WASM). Recarga la página e intenta de nuevo.");
  }
}

const dlg = document.getElementById("dlg");
// barras horizontales reutilizables (Movimientos y Gangas): divergentes
// por signo o de un color; ★ = tu lista, ● = nuevo desde tu ultima
// visita; clic abre la ficha del producto
function paintBar(id){
  const b = BARS[id]; if (!b || !b.opt) return;
  const el = document.getElementById(id);
  // details cerrado conserva su tamaño (content-visibility) — offsetWidth
  // no llega a 0; hay que mirar .open. El pane oculto si lo deja en 0
  if (!document.getElementById(b.wrap).open || !el.offsetWidth) return;
  // etiqueta adaptativa: en telefono truncar mas corto para que la
  // barra conserve espacio util
  b.opt.yAxis.axisLabel.width =
    Math.min(150, Math.max(90, Math.round(el.offsetWidth * 0.32)));
  b.ch = b.ch || echarts.init(el, null, {renderer:"svg"});
  b.ch.setOption(b.opt, true); b.ch.resize();
  b.ch.off("click");
  b.ch.on("click", p => { const r = b.data[p.dataIndex];
    r && openProd(r.sku); });
}
// o: {wrap, cap, min, rows:[{sku,v,neg,color,label,tip}], capTxt(n)}
function barChart(id, o){
  const w = document.getElementById(o.wrap),
        el = document.getElementById(id),
        b = BARS[id] = BARS[id] || {};
  b.wrap = o.wrap;
  const rows = o.rows.filter(r => Math.abs(r.v) >= o.min)
    .sort((a,b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 12);
  if (rows.length < 3) { w.style.display = "none"; b.opt = null; return; }
  w.style.display = "";
  document.getElementById(o.cap).textContent = o.capTxt(rows.length);
  el.style.height = Math.max(90, rows.length * 24 + 10) + "px";
  b.data = rows;
  b.opt = {
    grid:{left:6,right:44,top:4,bottom:4,containLabel:true},
    xAxis:{type:"value",
      axisLabel:{color:"#8b93ad",fontSize:10,formatter:"{value}%"},
      splitLine:{lineStyle:{color:"#2a3350"}}},
    yAxis:{type:"category",inverse:true,
      data:rows.map(r => r.label),
      axisLabel:{color:"#8b93ad",fontSize:11,width:150,overflow:"truncate"},
      axisTick:{show:false},axisLine:{show:false}},
    series:[{type:"bar",barWidth:11,
      data:rows.map(r => ({value:r.v,
        itemStyle:{color:r.color,
          borderRadius:r.neg ? [3,0,0,3] : [0,3,3,0]},
        label:{show:true,position:r.neg?"left":"right",fontSize:10,
          color:"#8b93ad",formatter:(r.v>0?"+":"")+r.v+"%"}}))}],
    tooltip:{formatter:p => b.data[p.dataIndex].tip},
  };
  paintBar(id);
}
function movChart(list){
  const chl = list.filter(e => e.pct != null),
        nb = chl.filter(e => e.pct < 0).length;
  barChart("ch-cambios", {wrap:"chmov-wrap", cap:"chmov-n", min:2,
    capTxt:() => "· " + [nb && `${nb} bajaron`,
      (chl.length-nb) && `${chl.length-nb} subieron`]
      .filter(Boolean).join(" · "),
    rows:chl.map(e => ({sku:e.sku, v:e.pct, neg:e.pct<0,
      color:e.pct<0 ? "#34d399" : "#f87171",
      label:(FAV.has(e.sku)?"★ ":"") + (NEWSET.has(e)?"● ":"")
        + (e.title || (D.products[e.sku]||{}).title || e.sku),
      tip:esc(e.title || (D.products[e.sku]||{}).title || e.sku)
        + `<br>${LABEL[e.type]||e.type} · ${e.date||""}`
        + (e.from!=null ? `<br>${fmt(e.from)} → ${fmt(e.to)}` : "")}))});
}
function dealChart(list){
  barChart("ch-ofertas", {wrap:"chofe-wrap", cap:"chofe-n", min:2,
    capTxt:n => `· top ${n} de ${list.length} · % desc.`,
    rows:list.map(s => {
      const l = lastOf(s), a = D.agg[s]||{},
            v = +(dealScore(s)*100).toFixed(1);
      return {sku:s, v, neg:false, color:"#34d399",
        label:(FAV.has(s)?"★ ":"") + ((D.products[s]||{}).title || s),
        tip:esc((D.products[s]||{}).title || s)
          + `<br>${verdict(s).label}`
          + (l && l[3]>0 ? ` · ahorra $${(+l[3]).toFixed(2)}` : "")
          + (a.pct_min!=null ? `<br>a ${a.pct_min}% de su mínimo` : "")};
    })});
}
// acordeones: el usuario decide si los ve; la eleccion se recuerda
[["chmov-wrap","ch-cambios","pw-chmov"],
 ["chofe-wrap","ch-ofertas","pw-chofe"]].forEach(([w,id,ls]) => {
  const d = document.getElementById(w);
  d.open = localStorage.getItem(ls) === "1";
  d.addEventListener("toggle", () => {
    localStorage.setItem(ls, d.open ? "1" : "0");
    // el evento llega antes de que el contenido abierto tenga layout;
    // esperar un frame o offsetWidth sigue en 0 y paintBar se salta
    requestAnimationFrame(() => paintBar(id));
  });
});
// rotacion/resize del telefono: repintar los charts visibles
window.addEventListener("resize", () => {
  Object.keys(BARS).forEach(paintBar);
  chart && chart.resize();
  chCal && chCal.resize();
});
function openProd(sku){
  const p = D.products[sku]||{}, s = D.series[sku]||[];
  const last = s.slice(-1)[0];
  $("#dimg").src = img(sku); $("#dimg").style.display = img(sku)?"":"none";
  $("#dtitle").textContent = p.title||sku;
  $("#dmeta").textContent = `${p.brand||""} · ${p.category||""} · SKU ${sku}`
    + (s.length && s[s.length-1][0] < D.generated ? ` · última vez en catálogo: ${s[s.length-1][0]}` : "")
    + ((D.agg[sku]||{}).temp ? " · de temporada" : "");
  $("#dprice").textContent = last ? fmt(last[1]) : "—";
  const dl = $("#dlink");
  if (p.slug){ dl.style.display=""; dl.href =
    `https://www.pricesmart.com/es-sv/producto/${p.slug}/${sku}`; }
  else dl.style.display = "none";
  const ds = $("#dstar");
  ds.textContent = FAV.has(sku) ? "★" : "☆";
  ds.className = "star" + (FAV.has(sku) ? " on" : "");
  ds.onclick = () => toggleFav(sku, {stopPropagation(){}}) || openProd(sku);
  const dvs = $("#dvs"), dagg = D.agg[sku]||{};
  dvs.innerHTML = (dagg.vs_med != null
    ? `<span style="color:${dagg.vs_med<=0?"var(--down)":"var(--up)"}">${dagg.vs_med>0?"+":""}${dagg.vs_med}% vs precio habitual (${fmt(dagg.med)})</span>`
    : "")
    + (dagg.of_every ? ` <span class="meta">· en oferta cada ~${dagg.of_every}d${dagg.of_save?` (ahorra ~$${(+dagg.of_save).toFixed(2)})`:""}</span>` : "");
  const db = $("#dbuy");
  db.checked = COMPRAS.some(c => c.sku === sku);
  db.onchange = () => buyToggled(sku, db);
  const dm = $("#dmore");
  dm.style.display = COMPRAS.some(c => c.sku === sku) ? "" : "none";
  dm.onclick = () => { if (comprar(sku)) openProd(sku); };
  const dt = $("#dtgt");
  dt.value = TARGETS[sku] != null ? (TARGETS[sku]/100).toFixed(2) : "";
  dt.onchange = () => {
    const v = parseFloat(dt.value);
    if (v > 0) TARGETS[sku] = Math.round(v*100); else delete TARGETS[sku];
    localStorage.setItem("pw-targets", JSON.stringify(TARGETS));
    if (AW.user) v > 0 ? tgtSet(sku, TARGETS[sku]) : tgtDel(sku);
    render();
  };
  const buys = COMPRAS.map((c,i)=>({c,i})).filter(x=>x.c.sku===sku);
  $("#dbuys").innerHTML = buys.length
    ? "Lo compraste: " + buys.map(x=>
        `<span>$${(+x.c.paid).toFixed(2)} (${x.c.date||"?"})
         <a style="cursor:pointer;color:var(--up)"
            onclick="delCompra(${x.i},'${sku}')">✕</a></span>`).join(", ")
    : "";
  $("#dshare").onclick = () => {
    const url = `${location.origin}${location.pathname}?sku=${sku}`;
    const txt = `${p.title||sku} — ${last?fmt(last[1]):""} | PriceWatch SV`;
    if (navigator.share) {
      navigator.share({title: "PriceWatch SV", text: txt, url}).catch(()=>{});
    } else {
      navigator.clipboard?.writeText(`${txt}\n${url}`);
      $("#dshare").textContent = "¡Copiado!";
      setTimeout(()=>$("#dshare").textContent="Compartir", 1500);
    }
  };
  const clubs = D.clubs[sku]||{};
  // "El Salvador" es el canal nacional del API (bodega+clubes), no una
  // suma nuestra — va de ultimo como fila total, con separador visual
  const clubRows = Object.entries(clubs)
    .sort(([a],[b]) => a==="El Salvador" ? 1 : b==="El Salvador" ? -1
                   : a===MYCLUB ? -1 : b===MYCLUB ? 1
                   : a.localeCompare(b));
  // eje de fechas compartido por todos los clubes del sku: alinea los
  // puntos y deja huecos donde el producto no se chequeo ese dia
  const ch = (D.clubh||{})[sku]||{};
  const cDates = [...new Set(Object.values(ch)
    .flatMap(rs => rs.map(r => r[0])))].sort();
  $("#dclubs").innerHTML = clubRows.length
    ? "<h2 style='margin-top:14px'>Disponibilidad en clubes</h2><table><tr><th>Club</th><th>Stock</th><th>Tendencia</th></tr>" +
      clubRows.map(([n,c])=>{
        const st = (n===MYCLUB?"color:var(--warn);":"")
                 + (n==="El Salvador"?"border-top:2px solid var(--line)":"");
        return `<tr${st?` style="${st}"`:""}><td>${n===MYCLUB?"📍 ":""}${n==="El Salvador"?"Total (nacional)":n}</td><td>${c.in_stock?`<b style="color:var(--down)">✓ ${c.qty} uds</b>`:'<span style="color:var(--mut)">agotado</span>'}</td><td>${typeof qtySpark==="function"?qtySpark(ch[n], cDates):""}</td></tr>`;
      }).join("") + "</table>"
    : "<p class='meta' style='margin-top:10px'>Sin dato de stock por club todavía — se consulta solo para ofertas, movimientos y tu lista.</p>";
  // tabla por episodios: una fila por regimen (mismo precio+stock+letrero),
  // no por observacion — la biografia no crece en ruido aunque el producto
  // viva anos en el catalogo
  const eps = [];
  s.forEach(([d,pr,st,sv]) => {
    const e = eps[eps.length-1];
    if (e && e.pr===pr && e.st===st && (e.sv||0)===(sv||0)) e.to = d;
    else eps.push({from:d, to:d, pr, st, sv});
  });
  const endD = d => d === D.generated ? "hoy" : d;
  $("#dtable").innerHTML =
    "<tr><th>Período</th><th>Precio</th><th>Ahorro</th><th>Stock</th></tr>"
    + eps.slice().reverse().map(e => {
        const nd = Math.round((Date.parse(e.to)-Date.parse(e.from))/864e5) + 1;
        const per = e.from === e.to ? e.from
                  : `${e.from} → ${endD(e.to)} · ${nd}d`;
        return `<tr><td>${per}</td><td>${fmt(e.pr)}</td>`
             + `<td>${e.sv?"$"+(+e.sv).toFixed(2):"—"}</td>`
             + `<td>${e.st?"✓":"✗"}</td></tr>`;
      }).join("");
  // PC: ficha anclada a la derecha (no modal) — master-detail con la lista
  const wide = matchMedia("(min-width:900px)").matches;
  if (!dlg.open) wide ? dlg.show() : dlg.showModal();
  document.body.classList.toggle("detail", wide);
  if (s.length >= 2){
    $("#chart").style.display="block";
    // bandas azules = dias con letrero de oferta
    const ofRuns=[]; let orun=null;
    s.forEach((pt,i)=>{
      if ((pt[3]||0) > 0){ if(!orun) orun=pt[0]; }
      else if (orun){ ofRuns.push([{xAxis:orun},{xAxis:s[i-1][0]}]); orun=null; }
    });
    if (orun) ofRuns.push([{xAxis:orun},{xAxis:s[s.length-1][0]}]);
    // banda verde tenue = rango habitual (p25-p75 de la serie visible):
    // debajo es ganga, dentro es normal, encima es caro. Mismo umbral
    // que verdict(): "habitual" solo con >=5 lecturas en >=14 dias
    const px = s.map(p=>p[1]).filter(v=>v!=null).sort((a,b)=>a-b);
    const qtl = p => { const i=(px.length-1)*p, lo=Math.floor(i),
        hi=Math.min(lo+1,px.length-1);
      return px[lo]+(px[hi]-px[lo])*(i-lo); };
    const span = s.length>=2
      ? (Date.parse(s[s.length-1][0])-Date.parse(s[0][0]))/864e5 : 0;
    const band = px.length>=5 && span>=14 ? [[
      {yAxis:+(qtl(.25)/100).toFixed(2),
       itemStyle:{color:"#34d39912"},
       label:{color:"#34d399",fontSize:9,position:"insideTop",
              formatter:"rango habitual"}},
      {yAxis:+(qtl(.75)/100).toFixed(2)}]] : [];
    chart = chart || echarts.init(document.getElementById("chart"), null, {renderer:"svg"});
    chart.setOption({
      grid:{left:55,right:15,top:20,bottom:30},
      xAxis:{type:"category",data:s.map(p=>p[0]),axisLabel:{color:"#8b93ad",fontSize:10}},
      yAxis:{type:"value",axisLabel:{color:"#8b93ad",formatter:v=>"$"+v},splitLine:{lineStyle:{color:"#2a3350"}},scale:true},
      series:[{type:"line",step:"end",data:s.map(p=>+(p[1]/100).toFixed(2)),showSymbol:true,symbolSize:5,
        lineStyle:{color:"#60a5fa"},areaStyle:{color:"#60a5fa18"},
        markLine:{silent:true,data:[
          {yAxis:+(Math.min(...s.map(p=>p[1]))/100).toFixed(2)},
          // med es de historia completa: si cae fuera del rango visible
          // la linea quedaria pegada al borde y confunde — no dibujarla
          ...(dagg.med!=null && dagg.med>=px[0]*0.95
             && dagg.med<=px[px.length-1]*1.05
            ? [{yAxis:+(dagg.med/100).toFixed(2),
            lineStyle:{color:"#8b93ad",type:"dotted"},
            label:{formatter:"habitual",color:"#8b93ad"}}]:[])],
          lineStyle:{color:"#34d399",type:"dashed"},label:{formatter:"mín",color:"#34d399"}},
        markArea:{silent:true,itemStyle:{color:"#3b82f622"},
          label:{color:"#93c5fd",fontSize:9,position:"top",formatter:"oferta"},
          data:[...ofRuns,...band]}}],
      tooltip:{trigger:"axis",valueFormatter:v=>"$"+v},
    }, true); chart.resize();
  } else {
    $("#chart").style.display="none";
  }
  // calendario del periodo visible: verde = ahorro del dia (mas intenso
  // = mas $), rojo tenue = agotado, vacio = sin chequeo ese dia
  const calEl = document.getElementById("dcal");
  if (s.length >= 3){
    calEl.style.display = "block";
    const mxsv = Math.max(...s.map(p=>p[3]||0));
    chCal = chCal || echarts.init(calEl, null, {renderer:"svg"});
    chCal.setOption({
      calendar:{left:34,right:8,top:24,bottom:4,
        range:[s[0][0].slice(0,7), s[s.length-1][0].slice(0,7)],
        cellSize:["auto",15],
        dayLabel:{firstDay:1,color:"#8b93ad",fontSize:9,
                  nameMap:["D","L","M","X","J","V","S"]},
        monthLabel:{color:"#8b93ad",fontSize:10,nameMap:MESES},
        yearLabel:{show:false},
        splitLine:{lineStyle:{color:"#2a3350"}},
        itemStyle:{color:"transparent",borderColor:"#0f1420",borderWidth:2}},
      visualMap:{show:false,min:0,max:mxsv||1,
        inRange:{color:["#1e2a20","#34d399"]}},
      series:[{type:"heatmap",coordinateSystem:"calendar",
        data:s.map(p=>({value:[p[0],+(p[3]||0).toFixed(2),p[2]?1:0],
          ...(p[2]?{}:{itemStyle:{color:"#f8717140"}})}))}],
      tooltip:{formatter:p=>{ const [d,sv,st]=p.value;
        return `${d} · ${st?"":"agotado · "}${sv>0?"ahorro $"+(+sv).toFixed(2):"sin oferta"}`; }},
    }, true); chCal.resize();
  } else calEl.style.display = "none";
}
// clic fuera del modal (backdrop) lo cierra
for (const d of [dlg, lgDlg, dlgNav]) d.addEventListener("click", e => {
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right
      || e.clientY < r.top || e.clientY > r.bottom) d.close();
});
dlg.addEventListener("close", () =>
  document.body.classList.remove("detail"));
// en modo anclado (no modal) Esc no cierra solo
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && dlg.open) dlg.close();
});
render();
// deep link compartible: ?sku=498227 abre la ficha directo
const qs = new URLSearchParams(location.search).get("sku");
if (qs && D.products[qs]) openProd(qs);
// detecta builds nuevos: al volver a la app y cada 30 min consulta
// version.json (excluido del cache del SW); si difiere ofrece recargar
const checkVer = () => fetch("version.json?t=" + Date.now())
  .then(r => r.json())
  .then(v => {
    if (v.built && D.built && v.built !== D.built)
      upd.style.display = "block";
  }).catch(() => {});
upd.onclick = () => location.reload();
document.addEventListener("visibilitychange",
  () => { if (!document.hidden) checkVer(); });
setInterval(checkVer, 30 * 60 * 1000);
// ---- web push: el sweep (GH Action) despierta al dispositivo ----
// La suscripcion vive en Appwrite push_subs; no requiere cuenta porque
// la "identidad" es el endpoint mismo — unsubscribe() lo mata en origen
// y el sender lo poda al recibir 404/410.
const VAPID_PUBLIC = "BCe97olK0g7PDhtvuC4BknYtgjzkzSlXv8MJ_Ve-9tMwnagCAU-lQmI1JtSgrSNrQZQE2pBr0O4H-vruxep4H6c";
const b64u8 = s => Uint8Array.from(
  atob(s.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
const pushBtn = document.getElementById("pushbtn");
(async () => {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)
      || !AW.ok) return;
  const reg = await navigator.serviceWorker.ready;
  const paint = async () => {
    const sub = await reg.pushManager.getSubscription();
    pushBtn.style.display = "";
    pushBtn.textContent = sub ? "🔔" : "🔕";
    pushBtn.title = sub ? "avisos activados en este dispositivo — toca para quitar"
                        : "avisarme de gangas y movimientos de mi lista";
  };
  pushBtn.onclick = async () => {
    try {
      let sub = await reg.pushManager.getSubscription();
      if (sub) { await sub.unsubscribe(); return paint(); }
      if (await Notification.requestPermission() !== "granted") return;
      sub = await reg.pushManager.subscribe({userVisibleOnly: true,
        applicationServerKey: b64u8(VAPID_PUBLIC)});
      const j = sub.toJSON();
      AW.dbs.createRow({databaseId: AW_DB, tableId: "push_subs",
        rowId: `sub-${h16(j.endpoint)}`,
        data: {endpoint: j.endpoint, keys: JSON.stringify(j.keys),
               ua: navigator.userAgent.slice(0, 240)}}).catch(() => {});
      paint();
    } catch (e) {}
  };
  paint();
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js", {scope: "./"}).catch(()=>{});
}

// sesion previa: al cargar por ultimo, render() y los
// helpers ya estan definidos (syncAll los necesita).
(async () => {
  if (!AW.ok) return;
  try { AW.user = await AW.acc.get(); await syncAll(); } catch(e) {}
  paintAcct();
})();
