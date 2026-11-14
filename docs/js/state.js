// state.js - helpers, estado persistente (localStorage) y
// logica de dominio: compras, carrito, clubes y veredicto.
// Se carga primero: define los bindings que usan los demas.

const $ = s => document.querySelector(s);
const fmt = c => c == null ? "—" : "$" + (c/100).toFixed(2);
// fecha de negocio SV (GMT-6): politica unica en PWData.today —
// toISOString() es UTC y pasadas las 6pm "hoy" salia fechado maniana
const todaySV = PWData.today;
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const [_y,_m,_d] = D.generated.split("-");
document.getElementById("gen").textContent = D.generated
  ? `${+_d} ${MESES[+_m-1]} ${_y}` : "sin datos";
if (D.demo) document.getElementById("demo-banner").style.display = "";
const img = sku => (D.products[sku]||{}).image || "";
const ev = D.events.slice().reverse();
const esc = s => String(s||"").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// argumento JS dentro de un handler inline (onclick/onchange):
// JSON.stringify produce el literal con comillas dobles y esc lo
// deja seguro como valor de atributo — una sku almacenada con ',
// ", \ o & no puede romper ni el atributo ni el literal
const jsArg = s => esc(JSON.stringify(String(s)));
// http(s) solamente: un link del payload podria ser javascript:/data: —
// para href/click nunca vale otro esquema. "" si es invalido o peligroso
const safeHttpURL = u => {
  if (!u) return "";
  try {
    const x = new URL(String(u), location.href || location.origin);
    return x.protocol === "http:" || x.protocol === "https:" ? x.href : "";
  } catch (_) { return ""; }
};
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
const LASTSEEN = PWStore.get("pw-lastseen") || "";
const NEWEV = LASTSEEN && LASTSEEN < D.generated
  ? ev.filter(e => e.date > LASTSEEN) : [];
const NEWSET = new Set(NEWEV);
PWStore.set("pw-lastseen", D.generated);
// Ofertas+Mejores unidos: letrero de la tienda O stats que dicen "barato hoy"
// "en su minimo" solo informa si el precio se movio alguna vez: un producto
// que nunca cambio esta trivialmente en su min (ruido con historia corta).
// Y vence a los 30d sin moverse (~ciclo de pasaporte): pasado eso el precio
// bajo ya ES su precio habitual, no una ganga vigente
const atMin = s => {
  if (!PWData.buyable(s)) return false;
  const a = D.agg[s]||{};
  const fresh = a.last_ch
    && (Date.parse(D.generated) - Date.parse(a.last_ch)) / 864e5 <= 30;
  return a.pct_min != null && a.pct_min <= 0 && (a.n_ch||0) >= 1
         && (D.series[s]||[]).length >= 3 && fresh;
};
const DEALS = (() => {
  const m = new Set(D.ofertas.map(o => o.sku));
  // comprable Y verificado: una observacion vencida o una fuente
  // fallida no puede proclamar ganga de hoy
  const okNow = s => PWData.buyable(s);
  Object.keys(D.agg).forEach(s => {
    if (!okNow(s)) return;
    const a = D.agg[s];
    if (atMin(s) || (a.vs_med != null && a.vs_med < 0)) m.add(s);
  });
  // ganga sin stock o sin lectura vigente no es ganga: el letrero
  // de ahorro puede venir de un sku agotado o de un dato viejo —
  // solo lo comprable y verificado entra a la lista
  return [...m].filter(okNow);
})();
const dealOK = (s, f) => {
  if (!PWData.buyable(s)) return false;
  const a = D.agg[s]||{}, l = lastOf(s), sv = l?.[3]||0;
  if (f === "letrero")    return sv > 0;
  if (f === "silenciosa") return atMin(s) && sv <= 0;
  if (f === "real")       return sv > 0 && atMin(s);
  if (f === "min")        return atMin(s);
  if (f === "bajo")       return a.vs_med != null && a.vs_med < 0;
  return true;
};
// fuerza del deal: ranking comparativo en PWData.score — % de ahorro
// declarado sobre el precio original, % bajo el maximo y % bajo el
// habitual. No es un % anunciado de tienda: solo ordena la lista
const dealScore = s => PWData.score(s);
// objetivo de precio por sku (centavos): alerta cuando el precio lo cruza
const TARGETS = PWStore.read("pw-targets", {}, PWStore.valid.numMap);
// Mi lista filtrada: cada alerta del Resumen abre un subconjunto de favs
let favFilter = "all";
const FAVFF = {
  // "en oferta" exige lectura vigente: un letrero viejo no es oferta
  oferta:   s => (lastOf(s)?.[3]||0) > 0
              && PWData.buyable(s),
  resurtir: s => verdict(s).label === "resurtir",
  // "sin stock" solo se afirma de una observacion fresca que dice
  // agotado — un dato viejo o ausente no confirma quiebre
  sinstock: s => PWData.product(s).state === "unavailable",
  clubout:  s => !!(MYCLUB
                && PWData.product(s, MYCLUB).state === "unavailable"),
  seagota:  s => !!drena(s),
};
// lo que muestra la hoja del FAB (se llena en render)
let RESUMEN = [], RESUMEN_N = 0;
// pvDone temprano: el auto-click del ultimo tab puede llamar loadExplorer
// durante el eval inicial, antes de que se defina mas abajo
let pvDone = false;

const FAV = new Set(PWStore.read("pw-favs", [], PWStore.valid.strList));
// historial de compras: log append-only en el teléfono {sku, paid, date}
const COMPRAS = PWStore.read("pw-compras", [], PWStore.valid.compras);
// la semilla D.mis ya NO se inyecta: un visitante anonimo no debe
// arrancar con compras personales ajenas — lo ya guardado localmente
// se conserva tal cual (la publicacion de mis se retira en el build)
const saveFavs = () => PWStore.write("pw-favs", [...FAV]);
const saveCompras = () => PWStore.write("pw-compras", COMPRAS);
const saveTargets = () => PWStore.write("pw-targets", TARGETS);
const PAID = {};
const rebuildPaid = () => {
  for (const k in PAID) delete PAID[k];
  COMPRAS.forEach(m => PAID[m.sku] = m);
};
rebuildPaid();
// toast con deshacer: accion reversible para borrados. El guard de
// namespace+epoch evita restaurar data de una cuenta en otra si el
// usuario cambia de sesion con el toast abierto
let toastT = null;
const undoToast = (msg, undo) => {
  const t = document.getElementById("toast");
  if (!t) return;
  const uid = PWStore.currentUser(), ep = PWStore.currentEpoch();
  t.innerHTML = esc(msg) + (undo
    ? ` <button type="button" id="toast-undo">deshacer</button>` : "");
  t.classList.add("show");
  if (!undo) {   // aviso sin accion: solo se auto-oculta
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), 7000);
    return;
  }
  document.getElementById("toast-undo").onclick = () => {
    t.classList.remove("show");
    if (PWStore.currentUser() !== uid
        || PWStore.currentEpoch() !== ep) return;
    undo();
  };
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 7000);
};
const delCompra = (i, sku) => {
  const c = COMPRAS[i];
  if (!c) return;
  COMPRAS.splice(i, 1);
  if (PWStore.currentUser() && c.rid) compraDown(c.rid);
  saveCompras();
  rebuildPaid(); render(); if (dlg.open) openProd(sku);
  // deshacer restaura la MISMA fila (mismo rid): la upsert coalesca
  // contra el delete pendiente — nunca crea una fila nueva
  undoToast(`compra de $${(+c.paid).toFixed(2)} eliminada`, () => {
    COMPRAS.splice(Math.min(i, COMPRAS.length), 0, c);
    if (PWStore.currentUser() && c.rid) compraUp(c);
    saveCompras(); rebuildPaid(); render();
    if (dlg.open) openProd(sku);
  });
};
// dueno de un formulario: {uid, epoch} capturado AL ABRIRLO. Un
// dialogo abierto sobrevive al cambio de cuenta — su owner estampado
// es la unica verdad de a que namespace pertenecen sus callbacks
// (mismo uid re-logueado = otra epoch = otro dueno)
const formOwner = () => ({
  uid: PWStore.currentUser(), epoch: PWStore.currentEpoch(),
});
const formOwnerLive = o => !!o && o.uid === PWStore.currentUser()
  && o.epoch === PWStore.currentEpoch();
const stampFormOwner = d => (d._pwOwner = formOwner());
// un dialogo abierto con owner vencido se cierra al hidratar otro
// namespace: su draft es de la cuenta anterior, no de esta. No toca
// storage — solo la superficie editable. Mismo uid+epoch conserva
// formularios y drafts abiertos
const closeStaleForms = () => {
  let n = 0;
  for (const id of ["dlg", "dlg-purchase", "dlg-checkout",
                    "dlg-recover", "dlg-nav"]) {
    const d = document.getElementById(id);
    if (d && d.open && !formOwnerLive(d._pwOwner)) { d.close(); n++; }
  }
  return n;
};
// la compra pasa por el dialogo con validacion (precio unitario,
// cantidad 1-99, fecha no futura) — nada se muta si se cancela
let PU_SKU = null;
const openPurchase = sku => {
  PU_SKU = sku;
  lastFocus = document.activeElement;
  const l = lastOf(sku);
  document.getElementById("pu-title").textContent =
    (D.products[sku]||{}).title || sku;
  document.getElementById("pu-price").value =
    l && l[1] ? (l[1]/100).toFixed(2) : "";
  document.getElementById("pu-qty").value = "1";
  const dp = document.getElementById("pu-date");
  dp.value = todaySV(); dp.max = todaySV();
  document.getElementById("pu-err").textContent = "";
  stampFormOwner(document.getElementById("dlg-purchase"));
  document.getElementById("dlg-purchase").showModal();
};
const comprar = sku => { openPurchase(sku); return true; };
// confirma lineas {sku, quantity, unitCents} como compras unitarias:
// PWData.purchaseRows emite UNA fila por unidad (preserva el esquema
// remoto sin mutarlo) y compraUp asigna el rid estable a CADA fila
// ANTES de persistir/encolar — el rid es la identidad primaria
const commitPurchases = (lines, date) => {
  const rows = PWData.purchaseRows(lines, date);   // lanza si invalido
  for (const r of rows) compraUp(r);   // rid + op si hay cuenta ligada
  COMPRAS.push(...rows);
  const ok = saveCompras();
  rebuildPaid();
  return { n: rows.length, ok };
};
const descomprar = sku => {  // quita la compra mas reciente de ese sku
  for (let i = COMPRAS.length - 1; i >= 0; i--)
    if (COMPRAS[i].sku === sku) { delCompra(i, sku); return; }
  if (dlg.open) openProd(sku);
};
const buyToggled = (sku, el, ep = PWStore.currentEpoch()) => {
  // una card de otro dueno no muta este espacio: la epoch capturada
  // al pintarla tiene que ser la vigente
  if (ep !== PWStore.currentEpoch()) return;
  if (el.checked) {
    // el switch es solo el atajo: la compra se confirma en el dialogo
    // (cancelar no deja la marca puesta ni toca COMPRAS)
    el.checked = COMPRAS.some(c => c.sku === sku);
    openPurchase(sku);
    return;
  }
  descomprar(sku);
};
const buySwitch = (sku, bought) =>
  `<label class="sw" onclick="event.stopPropagation()"><input type="checkbox"
   ${bought?"checked":""} onchange="buyToggled(${jsArg(sku)},this,${PWStore.currentEpoch()})"><i></i>lo compré</label>`;
// modo compra: la lista es el carrito; checkout registra todo como compras
const CART = new Set(PWStore.read("pw-cart", [], PWStore.valid.strList));
// lineas detalladas del carrito {sku:{quantity,unitCents}} — aisladas
// por namespace como el resto del dominio; unitCents null = el
// checkout propone el precio de catalogo como estimado (nunca como
// "lo que pagaste")
const CART_LINES = PWStore.read("pw-cart-lines", {},
                              PWStore.valid.cartLines);
let SHOP = false;
const saveCart = () => PWStore.write("pw-cart", [...CART]);
const saveCartLines = () => PWStore.write("pw-cart-lines", CART_LINES);
const cartToggle = (sku, on, ep = PWStore.currentEpoch()) => {
  if (ep !== PWStore.currentEpoch()) return;
  if (on) {
    CART.add(sku);
    if (!CART_LINES[sku]) CART_LINES[sku] = {quantity:1, unitCents:null};
  } else {
    CART.delete(sku); delete CART_LINES[sku];
  }
  saveCart(); saveCartLines(); render();
};
const cartSetLine = (sku, patch) => {
  if (!CART.has(sku)) return;
  if (!CART_LINES[sku]) CART_LINES[sku] = {quantity:1, unitCents:null};
  Object.assign(CART_LINES[sku], patch); saveCartLines();
};
const toggleFav = (sku, e, ep = PWStore.currentEpoch()) => {
  e.stopPropagation();
  if (ep !== PWStore.currentEpoch()) return;
  const on = !FAV.has(sku);
  on ? FAV.add(sku) : FAV.delete(sku);
  if (PWStore.currentUser()) on ? favUp(sku) : favDown(sku);
  saveFavs();render();
  // quitar de la lista es reversible: el re-add coalesca contra el
  // delete pendiente si el request aun no salia
  if (!on) undoToast("quitado de tu lista", () => {
    FAV.add(sku);
    if (PWStore.currentUser()) favUp(sku);
    saveFavs(); render();
  });
};
const star = sku =>
  `<button type="button" class="star ${FAV.has(sku)?"on":""}"
   aria-pressed="${FAV.has(sku)}"
   aria-label="seguir ${esc((D.products[sku]||{}).title||sku)}"
   onclick="toggleFav(${jsArg(sku)},event,${PWStore.currentEpoch()})">${FAV.has(sku)?"★":"☆"}</button>`;

// busqueda: sin tildes, todas las palabras deben aparecer (cualquier orden)
const norm = s => (s||"").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"");
const matchQ = (q, ...fields) => {
  const hay = norm(fields.filter(Boolean).join(" "));
  return norm(q).split(/\s+/).filter(Boolean).every(t => hay.includes(t));
};
// clubes: el tuyo primero con marca; el resto ordenado
const CLUBS = ["Santa Elena","Santa Ana","Los Héroes","San Miguel"];
let MYCLUB = PWStore.get("pw-club") || "";
const clubSel = $("#clubsel");
clubSel.innerHTML = `<option value="">club…</option>`
  + CLUBS.map(c=>`<option${c===MYCLUB?" selected":""}>${c}</option>`).join("");
clubSel.onchange = () => { MYCLUB = clubSel.value;
  PWStore.set("pw-club", MYCLUB); render(); pvRefresh?.(); };
function clubChips(sku){
  const cl = D.clubs[sku]||{};
  const keys = Object.keys(cl).filter(n=>n!=="El Salvador");
  if (!keys.length)
    return `<span class="meta">sin dato de club aún</span>`;
  keys.sort((a,b)=> a===MYCLUB?-1 : b===MYCLUB?1 : a.localeCompare(b));
  return keys.map(k=>{
    const c = cl[k];
    return `<span class="tag ${c.in_stock?"bajo":"agotado"}">${k===MYCLUB?"📍":""}${esc(k)} ${c.in_stock?"✓":"✗"}</span>`;
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
    // estado por club via PWData (lectura vigente + in_stock): una
    // observacion vieja no puede afirmar que "sigue escurriendo hoy"
    return c && PWData.product(sku, n).state === "available"
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
  // frescura primero: una observacion vencida o ausente no puede
  // afirmar nada sobre el precio/stock de hoy — y nunca se le llama
  // "hoy" a un dato viejo; siempre va su fecha
  const pf = PWData.product(sku);
  if (pf.state === "unknown")
    return {rank:9, cls:"agotado", label:"sin dato verificado",
            tip:"la fuente no confirmó una lectura vigente"};
  if (pf.state === "stale")
    return {rank:9, cls:"agotado", label:"sin verificación reciente",
            tip:`última lectura ${pf.observedAt || "sin fecha"}`};
  if (pf.state === "unavailable")
    return {rank:8, cls:"agotado", label:"sin stock",
            tip:(a.d_out||0) >= s.length
              ? `agotado desde que lo seguimos (${s.length}d)`
              : `lleva ${a.d_out||1}d agotado`};
  if (pf.priceCents == null)
    return {rank:9, cls:"agotado", label:"sin precio verificado",
            tip:"la lectura no incluye un precio positivo válido"};
  const save = l[3]||0, prev = s.length>=2 ? s[s.length-2][1] : null;
  const chg = prev!=null && prev ? Math.round((l[1]-prev)/prev*1000)/10 : 0;
  if (save>0 && s.length>=3 && a.pct_min!=null && a.pct_min<=0)
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
