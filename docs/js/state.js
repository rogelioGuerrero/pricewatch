// state.js - helpers, estado persistente (localStorage) y
// logica de dominio: compras, carrito, clubes y veredicto.
// Se carga primero: define los bindings que usan los demas.

const $ = s => document.querySelector(s);
const fmt = c => c == null ? "—" : "$" + (c/100).toFixed(2);
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const [_y,_m,_d] = D.generated.split("-");
document.getElementById("gen").textContent = `${+_d} ${MESES[+_m-1]} ${_y}`;
if (D.demo) document.getElementById("demo-banner").style.display = "";
const img = sku => (D.products[sku]||{}).image || "";
const ev = D.events.slice().reverse();
const esc = s => String(s||"").replace(/[&<>"]/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const byType = t => ev.filter(e=>e.type===t);
const lastOf = s => (D.series[s]||[]).slice(-1)[0];
// stock observado en una fecha: ultima lectura <= date (series van
// asc). null = sin dato — no afirmar nada
const stockOn = (sku, date) => {
  let st = null;
  for (const r of D.series[sku] || []) {
    if (r[0] <= date) st = r[2]; else break;
  }
  return st;
};
// "desde tu ultima visita": eventos posteriores al ultimo build que viste
const LASTSEEN = localStorage.getItem("pw-lastseen") || "";
const NEWEV = LASTSEEN && LASTSEEN < D.generated
  ? ev.filter(e => e.date > LASTSEEN) : [];
const NEWSET = new Set(NEWEV);
localStorage.setItem("pw-lastseen", D.generated);
// Ofertas+Mejores unidos: letrero de la tienda O stats que dicen "barato hoy"
// "en su minimo" solo informa si el precio se movio alguna vez: un producto
// que nunca cambio esta trivialmente en su min (ruido con historia corta).
// Y vence a los 30d sin moverse (~ciclo de pasaporte): pasado eso el precio
// bajo ya ES su precio habitual, no una ganga vigente
const atMin = s => {
  const a = D.agg[s]||{};
  const fresh = a.last_ch
    && (Date.parse(D.generated) - Date.parse(a.last_ch)) / 864e5 <= 30;
  return a.pct_min != null && a.pct_min <= 0 && (a.n_ch||0) >= 1
         && (D.series[s]||[]).length >= 3 && fresh;
};
const DEALS = (() => {
  const m = new Set(D.ofertas.map(o => o.sku));
  Object.keys(D.agg).forEach(s => {
    const l = lastOf(s);
    if (!l || !l[2]) return;
    const a = D.agg[s];
    if (atMin(s) || (a.vs_med != null && a.vs_med < 0)) m.add(s);
  });
  // ganga sin stock no es ganga: el letrero de ahorro puede venir de
  // un sku agotado — solo lo comprable entra a la lista
  return [...m].filter(s => lastOf(s)?.[2]);
})();
const dealOK = (s, f) => {
  const a = D.agg[s]||{}, l = lastOf(s), sv = l?.[3]||0;
  if (f === "letrero")    return sv > 0;
  if (f === "silenciosa") return atMin(s) && sv <= 0;
  if (f === "real")       return sv > 0 && atMin(s);
  if (f === "min")        return atMin(s);
  if (f === "bajo")       return a.vs_med != null && a.vs_med < 0;
  return true;
};
// fuerza del deal: la mejor cifra entre % de ahorro declarado, % bajo el
// habitual y % bajo su propio maximo — "cuanto mas barato que antes" es
// la referencia intuitiva del comprador (Eufy 249->130 = -48% del techo)
const dealScore = s => {
  const a = D.agg[s]||{}, l = lastOf(s);
  const sp = l && l[1] ? (l[3]||0) / (l[1]/100) : 0;
  const bajoMax = a.max && l && l[1] ? (a.max - l[1]) / a.max : 0;
  return Math.max(sp, bajoMax, -((a.vs_med||0)/100));
};
// objetivo de precio por sku (centavos): alerta cuando el precio lo cruza
const TARGETS = JSON.parse(localStorage.getItem("pw-targets") || "{}");
// Mi lista filtrada: cada alerta del Resumen abre un subconjunto de favs
let favFilter = "all";
const FAVFF = {
  oferta:   s => (lastOf(s)?.[3]||0) > 0,
  resurtir: s => verdict(s).label === "resurtir",
  sinstock: s => { const l = lastOf(s); return l && !l[2]; },
  clubout:  s => { const c = (D.clubs[s]||{})[MYCLUB];
                   return c && !c.in_stock; },
  seagota:  s => !!drena(s),
};
// lo que muestra la hoja del FAB (se llena en render)
let RESUMEN = [], RESUMEN_N = 0;
// pvDone temprano: el auto-click del ultimo tab puede llamar loadExplorer
// durante el eval inicial, antes de que se defina mas abajo
let pvDone = false;

const FAV = new Set(JSON.parse(localStorage.getItem("pw-favs")||"[]"));
// historial de compras: log append-only en el teléfono {sku, paid, date}
const COMPRAS = JSON.parse(localStorage.getItem("pw-compras")||"[]");
const PAID = {};
const rebuildPaid = () => {
  for (const k in PAID) delete PAID[k];
  (D.mis||[]).forEach(m => PAID[m.sku] = {paid:m.paid, date:m.date});
  COMPRAS.forEach(m => PAID[m.sku] = m);  // local pisa a la semilla del repo
};
rebuildPaid();
const delCompra = (i, sku) => {
  const c = COMPRAS[i];
  COMPRAS.splice(i, 1);
  if (AW.user && c && c.rid) compraDown(c.rid);
  localStorage.setItem("pw-compras", JSON.stringify(COMPRAS));
  rebuildPaid(); render(); openProd(sku);
};
const comprar = sku => {
  const l = (D.series[sku]||[]).slice(-1)[0];
  const v = prompt("¿A cuánto lo pagaste?", l ? (l[1]/100).toFixed(2) : "");
  if (v == null) return false;
  const paid = parseFloat(v);
  if (!(paid > 0)) return false;
  const r = {sku, paid, date: new Date().toISOString().slice(0,10)};
  COMPRAS.push(r); PAID[sku] = r;
  if (AW.user) compraUp(r)
    .then(d => { r.rid = d.$id;
      localStorage.setItem("pw-compras", JSON.stringify(COMPRAS)); })
    .catch(()=>{});
  localStorage.setItem("pw-compras", JSON.stringify(COMPRAS));
  render();
  return true;
};
const descomprar = sku => {  // quita la compra mas reciente de ese sku
  for (let i = COMPRAS.length - 1; i >= 0; i--)
    if (COMPRAS[i].sku === sku) {
      const c = COMPRAS.splice(i, 1)[0];
      if (AW.user && c && c.rid) compraDown(c.rid);
      break;
    }
  localStorage.setItem("pw-compras", JSON.stringify(COMPRAS));
  rebuildPaid(); render();
  if (dlg.open) openProd(sku);
};
const buyToggled = (sku, el) => {
  if (el.checked) {
    if (!comprar(sku)) { el.checked = false; return; }
    if (dlg.open) openProd(sku);
  } else descomprar(sku);
};
const buySwitch = (sku, bought) =>
  `<label class="sw" onclick="event.stopPropagation()"><input type="checkbox"
   ${bought?"checked":""} onchange="buyToggled('${sku}',this)"><i></i>lo compré</label>`;
// modo compra: la lista es el carrito; checkout registra todo como compras
const CART = new Set(JSON.parse(localStorage.getItem("pw-cart")||"[]"));
let SHOP = false;
const saveCart = () =>
  localStorage.setItem("pw-cart", JSON.stringify([...CART]));
const cartToggle = (sku, on) => {
  on ? CART.add(sku) : CART.delete(sku); saveCart(); render(); };
const comprarAuto = sku => {
  const l = (D.series[sku]||[]).slice(-1)[0];
  const paid = l ? l[1]/100 : null;
  if (!(paid > 0)) return;
  const r = {sku, paid, date: new Date().toISOString().slice(0,10)};
  COMPRAS.push(r); PAID[sku] = r;
  if (AW.user) compraUp(r)
    .then(d => { r.rid = d.$id;
      localStorage.setItem("pw-compras", JSON.stringify(COMPRAS)); })
    .catch(()=>{});
  localStorage.setItem("pw-compras", JSON.stringify(COMPRAS));
};
const toggleFav = (sku,e)=>{e.stopPropagation();
  const on = !FAV.has(sku);
  on ? FAV.add(sku) : FAV.delete(sku);
  if (AW.user) on ? favUp(sku) : favDown(sku);
  localStorage.setItem("pw-favs",JSON.stringify([...FAV]));render();};
const star = sku =>
  `<span class="star ${FAV.has(sku)?"on":""}" onclick="toggleFav('${sku}',event)">${FAV.has(sku)?"★":"☆"}</span>`;

// busqueda: sin tildes, todas las palabras deben aparecer (cualquier orden)
const norm = s => (s||"").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"");
const matchQ = (q, ...fields) => {
  const hay = norm(fields.filter(Boolean).join(" "));
  return norm(q).split(/\s+/).filter(Boolean).every(t => hay.includes(t));
};
// clubes: el tuyo primero con marca; el resto ordenado
const CLUBS = ["Santa Elena","Santa Ana","Los Héroes","San Miguel"];
let MYCLUB = localStorage.getItem("pw-club") || "";
const clubSel = $("#clubsel");
clubSel.innerHTML = `<option value="">club…</option>`
  + CLUBS.map(c=>`<option${c===MYCLUB?" selected":""}>${c}</option>`).join("");
clubSel.onchange = () => { MYCLUB = clubSel.value;
  localStorage.setItem("pw-club", MYCLUB); render(); pvRefresh?.(); };
function clubChips(sku){
  const cl = D.clubs[sku]||{};
  const keys = Object.keys(cl).filter(n=>n!=="El Salvador");
  if (!keys.length)
    return `<span class="meta">sin dato de club aún</span>`;
  keys.sort((a,b)=> a===MYCLUB?-1 : b===MYCLUB?1 : a.localeCompare(b));
  return keys.map(k=>{
    const c = cl[k];
    return `<span class="tag ${c.in_stock?"bajo":"agotado"}">${k===MYCLUB?"📍":""}${k} ${c.in_stock?"✓":"✗"}</span>`;
  }).join(" ");
}
// velocidad de venta: sku -> {club: evento se_agota mas reciente}.
// ev viene en orden descendente; el primero por club es el mas fresco
const SEAGOTA = {};
for (const e of ev)
  if (e.type === "se_agota") (SEAGOTA[e.sku] ??= {})[e.club] ??= e;
// sparkline de qty por club para la ficha: step-line porque el stock
// es un nivel que salta, no una curva; null (dia sin chequeo) corta
// el trazo — hueco honesto
const qtySpark = (rows, dates) => {
  const m = Object.fromEntries(rows || []);
  const pts = dates.map(d => m[d] ?? null);
  const vals = pts.filter(v => v != null);
  if (vals.length < 2) return "";
  const mn = Math.min(...vals), mx = Math.max(...vals), rng = (mx - mn) || 1;
  const w = 72, h = 20;
  const X = i => (i / (dates.length - 1) * w).toFixed(1);
  const Y = v => (h - 2 - (v - mn) / rng * (h - 4)).toFixed(1);
  let dAttr = "", pen = false, dots = "";
  pts.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const x = X(i), y = Y(v);
    dAttr += pen ? `H${x}V${y}` : `M${x},${y}`;
    pen = true;
    // hit-area invisible con tooltip nativo: fecha + unidades
    dots += `<circle cx="${x}" cy="${y}" r="5" fill="none" `
          + `pointer-events="all"><title>${dates[i].slice(5)} · `
          + `${v} uds</title></circle>`;
  });
  const last = vals[vals.length - 1], first = vals[0];
  const col = last < first ? "var(--up)"
            : last > first ? "var(--down)" : "var(--mut)";
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" `
       + `style="vertical-align:middle"><path d="${dAttr}" fill="none" `
       + `stroke="${col}" stroke-width="1.5"/>${dots}</svg>`;
};
// clubes donde sigue escurriendo HOY: aun hay stock y el qty no volvio
// a subir desde el evento (si subio, hubo re-stock y ya no es urgencia)
const drena = sku => {
  const g = SEAGOTA[sku];
  if (!g) return null;
  const ns = Object.keys(g).filter(n => {
    const c = (D.clubs[sku] || {})[n];
    return c && c.in_stock
        && (c.qty == null || c.qty <= (g[n].qty_to ?? Infinity));
  });
  return ns.length ? ns : null;
};
// veredicto de compra: ¿conviene hoy o no? (menor rank = mejor momento)
const ofTip = a =>
  a.of_every ? ` · ofertas cada ~${a.of_every}d` +
    (a.of_last ? ` (última hace ${a.of_last}d)` : "")
  : a.of_last ? ` · última oferta hace ${a.of_last}d` : "";
function verdict(sku){
  const a = D.agg[sku]||{}, s = D.series[sku]||[], l = s.slice(-1)[0];
  if (!l) return {rank:9, cls:"agotado", label:"sin datos", tip:""};
  const save = l[3]||0, prev = s.length>=2 ? s[s.length-2][1] : null;
  const chg = prev!=null && prev ? Math.round((l[1]-prev)/prev*1000)/10 : 0;
  if (!l[2]) return {rank:8, cls:"agotado", label:"sin stock",
                     tip:(a.d_out||0) >= s.length
                       ? `agotado desde que lo seguimos (${s.length}d)`
                       : `lleva ${a.d_out||1}d agotado`};
  if (save>0 && s.length>=3 && a.pct_min<=0)
    return {rank:0, cls:"real", label:"buen momento",
            tip:`oferta real: ahorra $${(+save).toFixed(2)} y está en su mínimo`};
  if (PAID[sku] && l[1] <= PAID[sku].paid*100)
    return {rank:1, cls:"real", label:"resurtir",
            tip:`está a lo que pagaste ($${(+PAID[sku].paid).toFixed(2)}) o menos`+ofTip(a)};
  if (save>0) return {rank:1, cls:"oferta", label:"en oferta",
                      tip:`ahorra $${(+save).toFixed(2)}`+ofTip(a)};
  if (atMin(sku))
    return {rank:2, cls:"bajo", label:"mínimo histórico",
            tip:"nunca estuvo más barato en nuestros datos"+ofTip(a)};
  // "habitual" solo se afirma con historia suficiente: una mediana de
  // 3 lecturas no es habitualidad, es ruido. Con historia corta cae al
  // veredicto del ultimo movimiento (subio/bajo/precio normal)
  const span = s.length>=2
    ? (Date.parse(s[s.length-1][0])-Date.parse(s[0][0]))/864e5 : 0;
  if (a.vs_med!=null && a.vs_med<0 && s.length>=5 && span>=14)
    return {rank:3, cls:"bajo",
            label: chg>0 ? "sigue barato" : "bajo lo habitual",
            tip:`${a.vs_med}% vs su precio habitual`+ofTip(a)};
  if (chg<0) return {rank:4, cls:"bajo", label:`bajó ${-chg}%`,
                     tip:"recién bajó de precio"+ofTip(a)};
  if (chg>0) return {rank:6, cls:"subio", label:`subió ${chg}%`,
                     tip:"si no urge, espera"+ofTip(a)};
  // defensivo: "hoy no es buen dia". Maduro = claramente arriba del
  // habitual; inmaduro = sentado en su techo registrado. Ambos peores
  // que "precio normal" pero menos graves que sin stock
  if (a.vs_med!=null && a.vs_med>=10 && s.length>=5 && span>=14)
    return {rank:7, cls:"subio", label:"arriba de lo habitual",
            tip:`+${a.vs_med}% vs su precio habitual — si no urge, espera`+ofTip(a)};
  if (a.max!=null && l[1]>=a.max && (a.n_ch||0)>=1 && (a.pct_min||0)>=10)
    return {rank:7, cls:"subio", label:"en su máximo",
            tip:"nunca lo vimos más caro — si no urge, espera"+ofTip(a)};
  // en el piso pero vencida (>30d sin moverse): ya es su precio normal
  const stale = a.pct_min!=null && a.pct_min<=0 && (a.n_ch||0)>=1;
  return {rank:5, cls:"salio_del_catalogo", label:"precio normal",
          tip:(stale ? `es su precio más bajo — sin moverse desde ${a.last_ch}`
                    : a.pct_min!=null ? `a ${a.pct_min}% de su mínimo` : "")
             +ofTip(a)};
}
// promo rotativa: episodios de oferta que vuelven. Confianza graduada —
// 2 episodios = "repite oferta" (un solo gap, patron emergente); >=3 =
// cadencia con mediana real ("cada ~Nd"). Sin letrero pero con precio
// que rebota (el ping-pong de Salutaris) = "sube y baja": misma
// moraleja — no te apures — con mecanica distinta
const rotTag = sku => {
  const a = D.agg[sku]||{};
  if (a.of_every && (a.n_of||0) >= 3)
    return `<span class="tag oferta" title="${a.n_of} ofertas registradas">↺ cada ~${a.of_every}d</span>`;
  if ((a.n_of||0) === 2)
    return `<span class="tag oferta" title="2 ofertas hasta ahora — patrón emergente">↺ repite oferta</span>`;
  const s = D.series[sku]||[];
  let rev = 0, dir = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i][1] == null || s[i-1][1] == null) continue;
    const d = Math.sign(s[i][1] - s[i-1][1]);
    if (d) { if (dir && d !== dir) rev++; dir = d; }
  }
  return rev >= 2
    ? `<span class="tag salio_del_catalogo" title="${rev} reversas de precio — promo titilando">↺ sube y baja</span>`
    : "";
};
