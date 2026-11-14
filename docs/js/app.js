// app.js - wiring de UI: tabs, FAB, modo compra, explorador
// Perspective, ficha de producto, push e init. Va ultimo:
// al evaluarse ya existen todos los modulos.

// instancias echarts compartidas: la ficha reusa el chart entre
// aperturas y los acordeones guardan su config en BARS
let chart, chCal;
const BARS = {};
const TABS = [
  ["inicio","Inicio", ""],
  ["favs","Mi lista", FAV.size],
  ["cambios","Movimientos", ev.filter(e =>
    ["bajo","subio","oferta_termino","rebaja"].includes(e.type)
    && !deadPrice(e)).length],
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
  `<button type="button" class="tab" id="tab-${id}" data-t="${id}" role="tab"
    tabindex="-1" aria-selected="false" aria-controls="pane-${id}">${n}<span class="n">${nr}</span></button>`).join("");
// el tab pedido por URL/localStorage se compara por dataset contra los
// nodos reales — nunca interpolado en un selector: un valor con "]" o
// "[" rompia querySelector y un tab inexistente dejaba la app sin pane
const tabEl = id => [...document.querySelectorAll(".tab")]
  .find(t => t.dataset.t === id);
// barra inferior movil: los 4 destinos primarios reusan la MISMA
// activacion de tabs — nada de handlers paralelos
const bnavSync = id => document.querySelectorAll("#bnav button")
  .forEach(b => {
    const on = b.dataset.t === id;
    b.classList.toggle("on", on);
    on ? b.setAttribute("aria-current", "page")
       : b.removeAttribute("aria-current");
  });
document.querySelectorAll("#bnav button")
  .forEach(b => b.onclick = () => goTab(b.dataset.t));
// el alcance del buscador cambia por tab: catalogo PriceSmart vs
// filtro de alertas Siman — el placeholder lo dice siempre
const qScope = t => {
  const q = $("#q");
  if (t === "siman") {
    q.placeholder = "Filtrar alertas de Siman (título, marca)…";
    q.setAttribute("aria-label", "filtrar alertas de Siman");
  } else {
    q.placeholder = "Buscar en PriceSmart — nombre, marca o SKU…";
    q.setAttribute("aria-label",
                   "buscar en el catálogo de PriceSmart");
  }
};
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  // roving tabindex: solo el tab activo entra al orden de Tab
  document.querySelectorAll(".tab").forEach(x => {
    x.classList.remove("on");
    x.setAttribute("aria-selected", "false");
    x.tabIndex = -1;
  });
  document.querySelectorAll(".pane").forEach(x=>x.classList.remove("on"));
  t.classList.add("on");
  t.setAttribute("aria-selected", "true");
  t.tabIndex = 0;
  document.getElementById("pane-"+t.dataset.t).classList.add("on");
  PWStore.set("pw-tab", t.dataset.t);
  const lbl = TABS.find(x=>x[0]===t.dataset.t);
  $("#fab-label").textContent = lbl ? lbl[1] : "";
  bnavSync(t.dataset.t);
  qScope(t.dataset.t);
  if (t.dataset.t==="favs" && favFilter!=="all") favFilter = "all";
  // render perezoso: rellena solo el pane entrante y pinta sus sparks
  render();
  if (t.dataset.t==="explorar") loadExplorer();
  if (t.dataset.t==="cambios") paintBar("ch-cambios");
  if (t.dataset.t==="ofertas") paintBar("ch-ofertas");
});
// flechas/Home/End mueven foco Y activan (patron tabs); Enter/Espacio
// ya disparan click solos por ser <button>
$("#tabs").addEventListener("keydown", e => {
  if (!e.target.classList || !e.target.classList.contains("tab")) return;
  const ts = [...document.querySelectorAll(".tab")];
  const i = ts.indexOf(e.target);
  const j = e.key === "ArrowRight" ? (i + 1) % ts.length
        : e.key === "ArrowLeft"  ? (i - 1 + ts.length) % ts.length
        : e.key === "Home" ? 0
        : e.key === "End"  ? ts.length - 1 : -1;
  if (j < 0 || j === i) return;
  e.preventDefault();
  ts[j].focus(); ts[j].click();
});
const goTab = id => tabEl(id)?.click();
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
// la misma hoja de secciones la abre el FAB (legado, oculto) y el
// boton "☰ secciones" del header en movil
const openNav = () => {
  stampFormOwner(dlgNav);
  $("#navres").innerHTML = RESUMEN.length
    ? `<div class="navsec">Resumen${RESUMEN_N ? " "+RESUMEN_N : ""}
        · ${D.generated ? `datos al ${+_d} ${MESES[+_m-1]}` : "sin datos"}</div>`
      + RESUMEN.map(([t,tab,cf,ff,sk]) =>
        `<button type="button" class="navitem res" data-t="${tab}" data-cf="${cf||""}"
           data-ff="${ff||""}"${sk?` data-sku="${sk}"`:""}><span>${esc(t)}</span>
           <span class="meta">›</span></button>`).join("")
    : "";
  $("#navitems").innerHTML = `<div class="navsec">Secciones</div>`
    + TABS.map(([id,n,nr]) =>
      `<button type="button" class="navitem${tabEl(id).classList.contains("on")?" on":""}"
        data-t="${id}"><span>${n}</span>
        <span class="meta">${nr}</span></button>`).join("");
  dlgNav.showModal();
};
$("#fab").onclick = openNav;
$("#moresec").onclick = openNav;
$("#dlg-nav").onclick = e => {
  const it = e.target.closest(".navitem"); if (!it) return;
  dlgNav.close();
  if (it.dataset.sku) { openProd(it.dataset.sku); return; }
  if (it.dataset.t === "cambios") setCf(it.dataset.cf || "all");
  goTab(it.dataset.t);
  favFilter = it.dataset.ff || "all";
  render();
};
// resumen accionable: la misma navegacion sirve al strip global
// (#alerts) y al panel de Inicio (#ini-alerts)
const alertClick = e => {
  const a = e.target.closest(".alert"); if (!a) return;
  if (a.dataset.sku) { openProd(a.dataset.sku); return; }
  if (a.dataset.tab === "cambios") setCf(a.dataset.cf || "all");
  goTab(a.dataset.tab);
  if (a.dataset.ff) favFilter = a.dataset.ff;
  render();
};
$("#alerts").onclick = alertClick;
$("#ini-alerts").onclick = alertClick;
$("#fav-filter").onclick = () => { favFilter = "all"; render(); };
$("#cart-view").onclick = () => openCheckout();


// ---- modo compra (carrito) ----
$("#shopmode").onclick = () => {
  SHOP = !SHOP;
  document.body.classList.toggle("shop", SHOP);
  $("#shopmode").classList.toggle("on", SHOP);
  render();
};
$("#cart-clear").onclick = () => {
  CART.clear();
  for (const k in CART_LINES) delete CART_LINES[k];
  saveCart(); saveCartLines(); render();
};
$("#done-btn").onclick = openCheckout;

// ---- dialogos de compra / checkout / recuperacion / sync ----
// foco devuelto al opener en cualquier dialogo modal
for (const id of ["dlg-purchase","dlg-checkout","dlg-recover","dlg-nav"])
  document.getElementById(id)?.addEventListener("close", () => {
    if (lastFocus && lastFocus.focus) {
      try { lastFocus.focus(); } catch (_) {}
    }
    lastFocus = null;
  });

// registro de compra: validacion en submit; cancelar no toca nada
const dlgPurchase = document.getElementById("dlg-purchase");
document.getElementById("pu-form")
  .addEventListener("submit", e => {
    e.preventDefault();
    if (!dlgPurchase.open) return;   // submit tardio tras cancel/close
    const err = document.getElementById("pu-err");
    // el dialogo abierto quedo de un namespace anterior: ni mutar el
    // estado de esta cuenta ni encolar operaciones con su draft
    if (!formOwnerLive(dlgPurchase._pwOwner)) {
      err.textContent =
        "La cuenta cambió; vuelve a abrir el formulario.";
      return;
    }
    const cents = PWData.parseMoney(
      document.getElementById("pu-price").value);
    // Number(), no parseInt: 1.5/99.9/1e-1 no se truncan — caen en la
    // validacion entera 1-99 de PWData.purchaseRows con error honesto
    const qty = Number(document.getElementById("pu-qty").value);
    const date = document.getElementById("pu-date").value;
    if (cents == null) {
      err.textContent = "precio inválido — usa formato 12.34";
      return;
    }
    let res;
    try {
      res = commitPurchases(
        [{ sku: String(PU_SKU), quantity: qty, unitCents: cents }],
        date);
    } catch (ex) { err.textContent = ex.message; return; }
    dlgPurchase.close();
    if (!res.ok) undoToast(
      "compra guardada solo en memoria — sin persistencia local",
      null);
    render();
    if (dlg.open) openProd(PU_SKU);
  });
document.getElementById("pu-cancel").onclick =
document.getElementById("pu-close").onclick = () => dlgPurchase.close();

// checkout multi-fila: cada linea editable (cantidad + precio por
// unidad); el catalogo se etiqueta como estimado; el total se
// calcula en centavos enteros; cancelar no muta COMPRAS ni CART
const dlgCk = document.getElementById("dlg-checkout");
function openCheckout(){
  if (!CART.size) return;
  lastFocus = document.activeElement;
  const owner = stampFormOwner(dlgCk);   // sello ANTES de las filas
  const rows = document.getElementById("ck-rows");
  rows.innerHTML = [...CART].map(s => {
    const p = D.products[s]||{}, l = lastOf(s),
          ln = CART_LINES[s] || {};
    const est = ln.unitCents ?? (l ? l[1] : null);
    return `<div class="ckrow" data-sku="${esc(s)}"
      data-form-epoch="${PWStore.currentEpoch()}">
      <span class="t">${esc(p.title||s)}<br>
        <span class="meta">catálogo ${l?fmt(l[1]):"—"} (estimado)</span></span>
      <input class="ck-q" type="number" min="1" max="99" step="1"
        value="${ln.quantity||1}"
        aria-label="cantidad de ${esc(p.title||s)}">
      <input class="ck-p" inputmode="decimal" autocomplete="off"
        value="${est != null ? (est/100).toFixed(2) : ""}"
        placeholder="precio"
        aria-label="precio por unidad de ${esc(p.title||s)}">
      <button type="button" class="ck-del"
        aria-label="quitar ${esc(p.title||s)} del carrito">✕</button>
    </div>`;
  }).join("");
  // cada fila queda ligada a ESTA apertura: un cancel+reopen en la
  // misma cuenta deja huerfanas las filas viejas aunque uid+epoch
  // no cambien
  rows.querySelectorAll(".ckrow").forEach(r => r._pwOwner = owner);
  const d = document.getElementById("ck-date");
  d.value = todaySV(); d.max = todaySV();
  document.getElementById("ck-err").textContent = "";
  ckTotal();
  dlgCk.showModal();
}
function ckTotal(){
  let tot = 0, ok = true;
  document.querySelectorAll("#ck-rows .ckrow").forEach(r => {
    const c = PWData.parseMoney(r.querySelector(".ck-p").value);
    const q = Number(r.querySelector(".ck-q").value);
    if (!(c != null && Number.isInteger(q) && q >= 1 && q <= 99))
      ok = false;
    else tot += c * q;
  });
  document.getElementById("ck-total").textContent =
    ok ? `total ${fmt(tot)}` : "revisa precios y cantidades";
  return ok;
}
// la edicion de filas se persiste en las lineas del carrito — un
// cancel conserva el draft para la proxima apertura
document.getElementById("ck-rows").addEventListener("input", e => {
  // doble candado: el dialogo debe seguir ABIERTO y de este dueno, y
  // la fila pertenece a ESTA apertura+epoch — una fila vieja (cancel
  // +reopen o cambio de cuenta) no edita el carrito vigente
  if (!dlgCk.open || !formOwnerLive(dlgCk._pwOwner)) return;
  const r = e.target.closest(".ckrow"); if (!r) return;
  if (r._pwOwner !== dlgCk._pwOwner
      || +r.dataset.formEpoch !== PWStore.currentEpoch()) return;
  const q = Number(r.querySelector(".ck-q").value);
  const c = PWData.parseMoney(r.querySelector(".ck-p").value);
  cartSetLine(r.dataset.sku, {
    ...(Number.isInteger(q) && q >= 1 && q <= 99 ? {quantity:q} : {}),
    ...(c != null ? {unitCents:c} : {}) });
  ckTotal();
});
// quitar una linea puntual: sale del carrito con deshacer — NO toca
// COMPRAS ni las demas lineas; si era la ultima el dialogo se cierra
document.getElementById("ck-rows").addEventListener("click", e => {
  const b = e.target.closest(".ck-del"); if (!b) return;
  if (!dlgCk.open || !formOwnerLive(dlgCk._pwOwner)) return;
  const r = b.closest(".ckrow"), sku = r.dataset.sku;
  if (r._pwOwner !== dlgCk._pwOwner
      || +r.dataset.formEpoch !== PWStore.currentEpoch()) return;
  const prev = CART_LINES[sku];
  CART.delete(sku); delete CART_LINES[sku];
  saveCart(); saveCartLines();
  undoToast("quitado del carrito", () => {
    CART.add(sku); if (prev) CART_LINES[sku] = prev;
    saveCart(); saveCartLines(); render();
  });
  r.remove(); ckTotal(); render();
  if (!CART.size) dlgCk.close();
});
document.getElementById("ck-ok").onclick = () => {
  const err = document.getElementById("ck-err");
  const okB = document.getElementById("ck-ok");
  // un confirm tardio tras close/cancel no puede reenviar filas DOM
  // que ya no existen — y el doble-tap sigue siendo un solo commit
  if (!dlgCk.open || okB.disabled) return;
  if (!formOwnerLive(dlgCk._pwOwner)) {
    err.textContent =
      "La cuenta cambió; vuelve a abrir el formulario.";
    return;
  }
  const lines = [];
  for (const r of document.querySelectorAll("#ck-rows .ckrow"))
    lines.push({ sku: r.dataset.sku,
      quantity: Number(r.querySelector(".ck-q").value),
      unitCents: PWData.parseMoney(r.querySelector(".ck-p").value) });
  const date = document.getElementById("ck-date").value;
  let res;
  okB.disabled = true;
  try { res = commitPurchases(lines, date); }
  catch (ex) { err.textContent = ex.message; okB.disabled = false; return; }
  okB.disabled = false;
  if (!res.ok)
    err.textContent =
      "guardado solo en memoria — sin persistencia local";
  // el carrito se vacia DESPUES del commit local: si fallo la
  // persistencia la compra vive en memoria y las lineas se van igual
  // (ya estan registradas); cancelar jamas toca COMPRAS ni CART
  CART.clear();
  for (const k in CART_LINES) delete CART_LINES[k];
  saveCart(); saveCartLines();
  SHOP = false; document.body.classList.remove("shop");
  document.getElementById("shopmode").classList.remove("on");
  dlgCk.close(); render();
};
document.getElementById("ck-cancel").onclick =
document.getElementById("ck-close").onclick = () => dlgCk.close();

// strip de estado: reintento manual de sync y recuperacion de datos
// corruptos — siempre visibles fuera del dialogo de cuenta
document.getElementById("ds-retry").onclick = () => {
  if (AW.user) syncAll().finally(() => render());
};
const dlgRc = document.getElementById("dlg-recover");
const openRecover = () => {
  lastFocus = document.activeElement;
  const ks = PWStore.corruptKeys();
  document.getElementById("rc-msg").textContent =
    `Llaves dañadas en este espacio: ${ks.join(", ") || "?"} — ` +
    `los valores originales están en cuarentena y exportables.`;
  document.getElementById("rc-status").textContent = "";
  stampFormOwner(dlgRc);
  dlgRc.showModal();
};
document.getElementById("ds-fix").onclick = openRecover;
document.getElementById("rc-cancel").onclick =
document.getElementById("rc-close").onclick = () => dlgRc.close();
// export privado: todo el namespace + pendientes + cuarentena en un
// JSON descargable — la copia vive fuera de la app antes de recuperar
document.getElementById("rc-export").onclick = () => {
  // exportar/reparar exige el dialogo vivo de ESTE dueno: un click
  // tardio de la cuenta anterior no descarga ni toca nada de esta
  if (!dlgRc.open || !formOwnerLive(dlgRc._pwOwner)) return;
  const data = PWStore.exportNS();
  const blob = new Blob([JSON.stringify(data, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pricewatch-datos-${PWStore.currentUser() || "guest"}-${todaySV()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  document.getElementById("rc-status").textContent =
    "copia exportada — guardala fuera de la app";
};
document.getElementById("rc-fix").onclick = async () => {
  if (!dlgRc.open || !formOwnerLive(dlgRc._pwOwner)) return;
  // el await puede cruzar un cambio de cuenta: el resultado viejo
  // jamas se pinta sobre el dialogo (o namespace) nuevo
  const owner = dlgRc._pwOwner;
  const st = document.getElementById("rc-status");
  st.textContent = "recuperando…";
  const r = await recoverNS();
  // mismo namespace pero dialogo reabierto durante el await: este
  // resultado pertenece al sello viejo — no pintar sobre el nuevo
  if (!dlgRc.open || !formOwnerLive(owner)
      || dlgRc._pwOwner !== owner) return;
  st.textContent = r.ok
    ? `recuperado (${r.fixed.length} llaves reparadas)`
      + ` — sincronización reanudada`
    : "valores válidos conservados — la sincronización sigue pendiente";
  paintAcct(); render();
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
let qT;
$("#q").oninput = () => { clearTimeout(qT); qT = setTimeout(() => {
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
}, 120); };   // debounce: render() reconstruye los panes completos

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
  agotados:   [["stock","==","no"]],
};
async function loadExplorer(attempt=0){
  if (pvDone) return;
  const pane = document.getElementById("pane-explorar");
  const msg = t => { pane.querySelector(".pv-status")?.remove();
    pane.insertAdjacentHTML("beforeend", `<p class="meta pv-status" style="padding:10px">${t}</p>`); };
  msg("Cargando catálogo (WASM, solo la primera vez)…");
  try {
    // el css del viewer solo se baja si el usuario abre el explorador
    if (!document.getElementById("pv-themes"))
      document.head.insertAdjacentHTML("beforeend",
        '<link id="pv-themes" rel="stylesheet" crossorigin="anonymous" '
        + 'href="https://cdn.jsdelivr.net/npm/@finos/perspective-viewer@3.8.0/dist/css/themes.css">');
    const psp = (await import('https://cdn.jsdelivr.net/npm/@finos/perspective@3.8.0/dist/cdn/perspective.js')).default;
    await import('https://cdn.jsdelivr.net/npm/@finos/perspective-viewer@3.8.0/dist/cdn/perspective-viewer.js');
    await import('https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-datagrid@3.8.0/dist/cdn/perspective-viewer-datagrid.js');
    await import('https://cdn.jsdelivr.net/npm/@finos/perspective-viewer-d3fc@3.8.0/dist/cdn/perspective-viewer-d3fc.js');
    const mkRows = () => Object.entries(D.products).map(([sku,p])=>{
      const ser = D.series[sku]||[], l = ser.slice(-1)[0],
            prev = ser.slice(-2)[0];
      const a = D.agg[sku]||{};
      const mc = MYCLUB ? (D.clubs[sku]||{})[MYCLUB] : null;
      // stock solo se afirma con lectura vigente; un dato viejo es
      // "?" honesto, no "sí"/"no" inventado
      const pst = PWData.product(sku).state,
            cst = mc ? PWData.product(sku, MYCLUB).state : null;
      const stTxt = st2 => st2 === "available" ? "sí"
        : st2 === "unavailable" ? "no" : "?";
      return {sku, producto:p.title, marca:p.brand||"", categoria:p.category||"",
        precio: l?+(l[1]/100).toFixed(2):null,
        ahorro: l?+((l[3]||0).toFixed(2)):0,
        desc_pct: l&&l[1]?+((l[3]||0)/(l[1]/100)*100).toFixed(1):0,
        stock: stTxt(pst),
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
        mi_club: mc ? stTxt(cst) : "—"};
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
// borrado puntual de una compra desde la ficha: el indice y la epoch
// viajan en el boton — una fila DOM pintada bajo otro dueno/otra
// apertura no puede borrar compras de esta cuenta
document.getElementById("dbuys").addEventListener("click", e => {
  const b = e.target.closest("[data-compra-index]");
  if (!b || !dlg.open || !formOwnerLive(dlg._pwOwner)) return;
  // el boton pertenece a ESTA apertura (reabrir, aun en la misma
  // cuenta, sella otro owner) y a la epoch vigente
  if (b._pwOwner !== dlg._pwOwner
      || +b.dataset.formEpoch !== PWStore.currentEpoch()) return;
  const p = b._pwPurchase;
  // resolver el indice VIGENTE por identidad — rid estable si hay,
  // referencia exacta para compras legacy sin rid; jamas la posicion
  // numerica vieja: un merge/remate reordena COMPRAS y el indice 0
  // de un boton viejo podria ser OTRA compra
  const i = p && (p.rid
    ? COMPRAS.findIndex(c => c.rid === p.rid && c.sku === p.sku)
    : COMPRAS.indexOf(p));
  if (!p || i < 0) {
    // la fila ya no existe: solo repintar la ficha abierta, sin
    // borrar nada por posicion
    if (dlg.dataset.sku) openProd(dlg.dataset.sku);
    return;
  }
  delCompra(i, COMPRAS[i].sku);
});
// barras horizontales reutilizables (Movimientos y Gangas): divergentes
// por signo o de un color; ★ = tu lista, ● = nuevo desde tu ultima
// visita; clic abre la ficha del producto
function paintBar(id){
  // sin echarts (CDN caido o bloqueado) los acordeones quedan vacios
  // pero el resto de la app sigue funcionando
  if (typeof echarts === "undefined") return;
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
  d.open = PWStore.get(ls) === "1";
  d.addEventListener("toggle", () => {
    PWStore.set(ls, d.open ? "1" : "0");
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
let lastFocus = null;
// la observacion va con SU fecha — jamas "hoy" sobre dato viejo
const observationText = pf =>
  `última lectura ${pf.observedAt || "sin fecha"}`
  + (pf.state === "stale" ? " — dato vencido"
    : pf.state === "unknown" ? " — sin verificar" : "");
// estado por club via PWData: una lectura vencida dice
// "sin verificacion" con su fecha — jamas afirma stock/agotado
const clubStock = (sku, name, c) => {
  const cs = PWData.product(sku, name);
  return cs.state === "available"
    ? `<b style="color:var(--down)">✓ ${c.qty} uds</b>`
    : cs.state === "unavailable"
      ? '<span style="color:var(--mut)">agotado</span>'
      : `<span class="meta">sin verificación${
          cs.observedAt ? " (" + esc(cs.observedAt) + ")" : ""}</span>`;
};
function openProd(sku){
  const p = D.products[sku]||{}, s = D.series[sku]||[];
  const last = s.slice(-1)[0];
  const pf = PWData.product(sku);
  dlg.dataset.sku = sku;
  // dueno de ESTA apertura: las closures mutables verifican uid/epoch
  // vigentes e identidad del sello — una ficha reabierta (incluso en
  // la misma cuenta) invalida los callbacks de la apertura anterior
  const owner = stampFormOwner(dlg);
  $("#dimg").src = img(sku); $("#dimg").style.display = img(sku)?"":"none";
  const dtt = $("#dtitle");
  dtt.textContent = p.title||sku;
  dtt.classList.remove("open");
  // titulos largos: clamp de 2 lineas con toggle explicito — nunca
  // se desbordan ni se cortan en silencio
  const tm = $("#dtitle-more");
  tm.style.display = (p.title||"").length > 60 ? "" : "none";
  tm.onclick = () => dtt.classList.toggle("open");
  $("#dmeta").textContent = `${p.brand||""} · ${p.category||""} · SKU ${sku}`
    + (s.length && s[s.length-1][0] < D.generated ? ` · última vez en catálogo: ${s[s.length-1][0]}` : "")
    + ((D.agg[sku]||{}).temp ? " · de temporada" : "");
  $("#dobs").textContent = observationText(pf);
  $("#dprice").textContent = last ? fmt(last[1]) : "—";
  const dl = $("#dlink");
  if (p.slug){ dl.style.display=""; dl.href =
    `https://www.pricesmart.com/es-sv/producto/${p.slug}/${sku}`; }
  else dl.style.display = "none";
  const ds = $("#dstar");
  ds.textContent = FAV.has(sku) ? "★" : "☆";
  ds.className = "star dstar" + (FAV.has(sku) ? " on" : "");
  ds.setAttribute("aria-pressed", String(FAV.has(sku)));
  ds.setAttribute("aria-label",
    "seguir " + (p.title || sku));
  ds.onclick = () => {
    if (!dlg.open || !formOwnerLive(owner) || dlg._pwOwner !== owner)
      return;
    toggleFav(sku, {stopPropagation(){}}) || openProd(sku);
  };
  const dvs = $("#dvs"), dagg = D.agg[sku]||{};
  dvs.innerHTML = (dagg.vs_med != null
    ? `<span style="color:${dagg.vs_med<=0?"var(--down)":"var(--up)"}">${dagg.vs_med>0?"+":""}${dagg.vs_med}% vs precio habitual (${fmt(dagg.med)})</span>`
    : "")
    + (dagg.of_every ? ` <span class="meta">· en oferta cada ~${dagg.of_every}d${dagg.of_save?` (ahorra ~$${(+dagg.of_save).toFixed(2)})`:""}</span>` : "")
    + rotTag(sku);
  const db = $("#dbuy");
  db.checked = COMPRAS.some(c => c.sku === sku);
  db.onchange = () => {
    if (!dlg.open || !formOwnerLive(owner) || dlg._pwOwner !== owner)
      return;
    buyToggled(sku, db);
  };
  const dm = $("#dmore");
  dm.style.display = COMPRAS.some(c => c.sku === sku) ? "" : "none";
  dm.onclick = () => {
    if (!dlg.open || !formOwnerLive(owner) || dlg._pwOwner !== owner)
      return;
    comprar(sku);
  };
  const dc = $("#dcart");
  const paintCart = () => {
    dc.textContent = CART.has(sku) ? "🛒 en el carrito ✓" : "🛒 al carrito";
    dc.setAttribute("aria-pressed", String(CART.has(sku)));
  };
  paintCart();
  dc.onclick = () => {
    if (!dlg.open || !formOwnerLive(owner) || dlg._pwOwner !== owner)
      return;
    cartToggle(sku, !CART.has(sku)); paintCart();
  };
  const dt = $("#dtgt");
  dt.value = TARGETS[sku] != null ? (TARGETS[sku]/100).toFixed(2) : "";
  $("#dtgt-err").textContent = "";
  dt.onchange = () => {
    // autosave en blur: cerrar la ficha puede disparar change DESPUES
    // de quitar open — se exige dueno vigente + identidad del sello,
    // nunca que siga abierto (es el guardar-legitimo del blur)
    if (!formOwnerLive(owner) || dlg._pwOwner !== owner) return;
    const err = $("#dtgt-err"), v = dt.value.trim();
    if (!v) {
      delete TARGETS[sku]; saveTargets(); err.textContent = "";
      if (PWStore.currentUser()) tgtDel(sku);
      render(); return;
    }
    // parseMoney exige 12.34 real: 1e3, .5x o basura no pisa el
    // objetivo anterior — el input conserva el valor valido
    const cents = PWData.parseMoney(v);
    if (cents == null) {
      err.textContent = "precio inválido — usa formato 12.34";
      dt.value = TARGETS[sku] != null
        ? (TARGETS[sku]/100).toFixed(2) : "";
      return;
    }
    err.textContent = "";
    TARGETS[sku] = cents; saveTargets();
    if (PWStore.currentUser()) tgtSet(sku, cents);
    render();
  };
  // historial agrupado (fecha|precio): "2 × $10.01" muestra unidades;
  // cada grupo borra UNA unidad con deshacer — no la compra entera
  const buys = COMPRAS.map((c,i)=>({c,i})).filter(x=>x.c.sku===sku);
  const grp = {};
  buys.forEach(x => {
    const k = (x.c.date||"") + "|" + x.c.paid;
    (grp[k] ??= { n: 0, paid: x.c.paid, date: x.c.date, last: x.i }).n++;
  });
  $("#dbuys").innerHTML = buys.length
    ? "Lo compraste: " + Object.values(grp).map(g =>
        `<span>${g.n>1?g.n+" × ":""}$${(+g.paid).toFixed(2)}`
        + `${g.date?" ("+g.date+")":""} `
        + `<button type="button" class="chip" style="padding:0 8px"
           aria-label="eliminar una compra de ${g.date||"sin fecha"}"
           data-compra-index="${g.last}"
           data-form-epoch="${PWStore.currentEpoch()}">✕</button></span>`)
        .join(", ")
    : "";
  // cada boton queda ligado a ESTA apertura y a la fila que mostraba:
  // un merge/remate posterior reordena COMPRAS y un indice numerico
  // viejo borraria la compra equivocada
  $("#dbuys").querySelectorAll("[data-compra-index]").forEach(b => {
    b._pwOwner = owner;
    b._pwPurchase = COMPRAS[+b.dataset.compraIndex] || null;
  });
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
        // la celda lleva su club estatico: el refresh de frescura la
        // repinta sin reabrir la ficha ni pisar inputs del usuario
        const stockTd = clubStock(sku, n, c);
        return `<tr${st?` style="${st}"`:""}><td>${n===MYCLUB?"📍 ":""}${n==="El Salvador"?"Total (nacional)":esc(n)}</td><td data-stock-club="${esc(n)}">${stockTd}</td><td>${typeof qtySpark==="function"?qtySpark(ch[n], cDates):""}</td></tr>`;
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
  // fecha siempre: ni "hoy" — una observacion vieja no se disfraza
  const endD = d => d;
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
  // PC: ficha anclada a la derecha (no modal) — master-detail con la
  // lista. Movil: modal a pantalla completa con scroll del fondo
  // bloqueado y foco devuelto al cerrar
  const wide = matchMedia("(min-width:900px)").matches;
  if (!dlg.open) {
    lastFocus = document.activeElement;
    wide ? dlg.show() : dlg.showModal();
  }
  document.body.classList.toggle("detail", wide);
  document.body.classList.toggle("locked", !wide && dlg.open);
  // sin echarts (CDN caido/bloqueado) la ficha sigue completa — tabla,
  // clubes y compras — y el aviso explica el hueco de la grafica
  const hayChart = typeof echarts !== "undefined";
  $("#dnograph").style.display = !hayChart && s.length >= 2 ? "" : "none";
  if (s.length >= 2 && hayChart){
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
    // precio null = hueco honesto en la serie — jamas un punto en $0
    // (un dia sin lectura no vale cero)
    chart.setOption({
      grid:{left:55,right:15,top:20,bottom:30},
      xAxis:{type:"category",data:s.map(p=>p[0]),axisLabel:{color:"#8b93ad",fontSize:10}},
      yAxis:{type:"value",axisLabel:{color:"#8b93ad",formatter:v=>"$"+v},splitLine:{lineStyle:{color:"#2a3350"}},scale:true},
      series:[{type:"line",step:"end",
        data:s.map(p=>p[1]==null?null:+(p[1]/100).toFixed(2)),
        showSymbol:true,symbolSize:5,
        lineStyle:{color:"#60a5fa"},areaStyle:{color:"#60a5fa18"},
        markLine:{silent:true,data:[
          ...(px.length
            ? [{yAxis:+(Math.min(...px)/100).toFixed(2)}]
            : []),
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
  if (s.length >= 3 && hayChart){
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
for (const d of [dlg, lgDlg, dlgNav, dlgPurchase, dlgCk, dlgRc])
  d.addEventListener("click", e => {
  const r = d.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right
      || e.clientY < r.top || e.clientY > r.bottom) d.close();
});
dlg.addEventListener("close", () => {
  document.body.classList.remove("detail");
  document.body.classList.remove("locked");
  // devolver el foco al control que abrio la ficha
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
  lastFocus = null;
  // deep link ?sku= consumido: si quedaba en la URL, una recarga (p.ej.
  // el banner de "hay datos nuevos") reabria una ficha ya cerrada
  const q = new URLSearchParams(location.search);
  if (q.has("sku")) {
    q.delete("sku");
    const s = q.toString();
    history.replaceState(null, "", location.pathname + (s ? "?" + s : ""));
  }
});
// en modo anclado (no modal) Esc no cierra solo
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && dlg.open) dlg.close();
});
// primer render: activa el ultimo tab usado (o ?tab=), cayendo a
// Inicio si el valor guardado/pedido no existe. Va al final del
// script porque el click dispara render(), que lee cf/OF_F y todo lo
// cableado arriba — aqui abajo ya no hace falta un render() aparte
const reqTab = new URLSearchParams(location.search).get("tab")
  || PWStore.get("pw-tab") || "inicio";
(tabEl(reqTab) || tabEl("inicio"))?.click();
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
// la ficha abierta tambien vence: al cruzar el corte (o volver a la
// pestana) se repintan fecha de lectura y stock por club SIN reabrir —
// openProd destruiria el objetivo a medio escribir, el scroll y el foco
function refreshOpenProduct(){
  const sku = dlg.dataset.sku;
  if (!dlg.open || !sku) return;
  document.getElementById("dobs").textContent =
    observationText(PWData.product(sku));
  document.querySelectorAll("#dclubs td[data-stock-club]")
    .forEach(td => {
      const name = td.dataset.stockClub;
      td.innerHTML = clubStock(sku, name, (D.clubs[sku]||{})[name]||{});
    });
}
document.addEventListener("visibilitychange",
  () => { if (!document.hidden) { render(); refreshOpenProduct(); checkVer(); } });
setInterval(checkVer, 30 * 60 * 1000);
// re-render exacto en el corte 06:00 SV (PWData.nextSweep): lo que era
// "fresco" vence aunque nadie toque la pagina — un solo timeout que se
// reprograma, sin intervalo extra ni polling
const refreshFreshness = () => {
  render();
  refreshOpenProduct();
  setTimeout(refreshFreshness,
    Math.max(1, Date.parse(PWData.nextSweep()) - Date.now() + 1));
};
setTimeout(refreshFreshness,
  Math.max(1, Date.parse(PWData.nextSweep()) - Date.now() + 1));
// ---- web push: el sweep (GH Action) despierta al dispositivo ----
// La suscripcion vive en Appwrite push_subs; no requiere cuenta porque
// la "identidad" es el endpoint mismo — unsubscribe() lo mata en origen
// y el sender lo poda al recibir 404/410.
// El registro va ANTES del IIFE: serviceWorker.ready solo resuelve una
// vez que el registro de sw.js arranco — si el .ready corria primero y
// ningun SW estaba registrado (primer arranque), la promesa podia quedar
// colgada y el boton de avisos nunca aparecia
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("sw.js", {scope: "./"}).catch(()=>{});
// un SW nuevo tomando el control NUNCA recarga solo: un formulario a
// medio llenar se perderia — solo deja visible el boton de update
if ("serviceWorker" in navigator && navigator.serviceWorker.addEventListener)
  navigator.serviceWorker.addEventListener("controllerchange",
    () => { upd.style.display = "block"; });
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
      // si la fila no quedo en Appwrite (red caida, no 409 = ya existe)
      // desactivar la suscripcion: el icono no debe mentir con 🔔
      // cuando el backend jamas conocio el endpoint
      const saved = await AW.dbs.createRow({databaseId: AW_DB,
        tableId: "push_subs", rowId: `sub-${h16(j.endpoint)}`,
        data: {endpoint: j.endpoint, keys: JSON.stringify(j.keys),
               ua: navigator.userAgent.slice(0, 240)}})
        .then(() => true).catch(e => e && e.code === 409);
      if (!saved) { await sub.unsubscribe(); return paint(); }
      paint();
    } catch (e) {}
  };
  paint();
})();

// sesion previa: al cargar por ultimo, render() y los
// helpers ya estan definidos (syncAll los necesita). Se liga el
// namespace de la cuenta ANTES del sync; sin sesion (offline o
// borrada) se conserva el namespace del hint — la data de la ultima
// cuenta ligada sigue usable en este dispositivo.
(async () => {
  if (!AW.ok) return;
  try {
    AW.user = await AW.acc.get();
    PWStore.activate(AW.user.$id);
    hydrateNS();
    await syncAll();
  } catch(e) { hydrateNS(); }
  paintAcct();
})();
