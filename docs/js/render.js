// render.js - pintado de todas las secciones (tarjetas,
// alertas del resumen, acordeones Siman, sparklines).

const LABEL = {agotado:"se acabó", reaparecio:"volvió",
  salio_del_catalogo:"salió del catálogo", regreso:"regresó al catálogo",
  nuevo:"nuevo", oferta_termino:"terminó oferta", rebaja:"rebaja",
  club_volvio:"volvió a", club_agotado:"se acabó en",
  se_agota:"se agota en"};
// eventos por club: un mismo producto se acaba en N tiendas el mismo
// dia -> una sola card con la lista de clubes, no N cards identicas
const CLUBEV = new Set(["club_agotado","club_volvio","se_agota"]);
const groupClubs = list => {
  const byK = new Map();
  let n = 0;
  for (const e of list) {
    const k = CLUBEV.has(e.type) ? e.sku + "|" + e.type : "#" + n++;
    if (!byK.has(k)) byK.set(k, []);
    byK.get(k).push(e);
  }
  return [...byK.values()];
};
// "El Salvador" = canal nacional del API, no una tienda mas — se lista
// al final, igual que la fila Total de la ficha
const clubName = n => n === "El Salvador" ? "nivel nacional" : n;
// la card responde que producto, que paso y donde — el detalle de
// cantidades vive en la ficha (D.clubs), a un clic
const clubsLine = evs => evs.slice()
  .sort((a,b) => (a.club==="El Salvador") - (b.club==="El Salvador"))
  .map(x => clubName(x.club)).filter(Boolean).join(" · ");
// tag de urgencia en cards de producto: clubes donde sigue bajando
const saTag = sku => {
  const ns = drena(sku);
  if (!ns) return "";
  ns.sort((a,b) => (a==="El Salvador") - (b==="El Salvador")
    || (a===MYCLUB ? -1 : b===MYCLUB ? 1 : a.localeCompare(b)));
  return `<span class="tag se_agota">se agota en ${ns.map(clubName).join(" · ")}</span>`;
};
// rebaja/subida sobre un articulo sin stock ESE dia = ajuste mecanico
// de catalogo (markdown de liquidacion): nunca fue comprable, no es
// movimiento accionable — se oculta del feed pero queda en los datos
const deadPrice = e =>
  ["bajo","subio","oferta_termino","rebaja","oferta"].includes(e.type)
  && !!e.date && stockOn(e.sku, e.date) === 0;
// lo nuevo desde tu ultima visita, sin los ajustes fantasmas
const NEWV = NEWEV.filter(e => !deadPrice(e));
// auditoria de fantasmas: la confesion los despliega atenuados
let SHOW_DEAD = false;
document.addEventListener("click", e => {
  if (e.target.closest(".dead-toggle")) { SHOW_DEAD = !SHOW_DEAD; render(); }
});
function card(e, clubs){
  const p = D.products[e.sku]||{};
  let price;
  if (e.from != null && e.to != null)
    price = `<span class="old">${fmt(e.from)}</span> → <span class="pr">${fmt(e.to)}</span>
      <span class="tag ${e.type}">${e.pct>0?"+":""}${e.pct}%</span>
      ${["reaparecio","regreso","oferta_termino","rebaja"].includes(e.type)?`<span class="tag ${e.type}">${LABEL[e.type]}</span>`:""}`;
  else if (e.type==="oferta"){
    const a = D.agg[e.sku]||{}, hist = (D.series[e.sku]||[]).length>=3;
    // el ahorro declarado es historico: solo "ahorra" si el precio es
    // comprable HOY; si no, se confiesa como observado — y "oferta
    // real" exige comprable + historia + piso, nunca solo el letrero
    const can = PWData.buyable(e.sku);
    price = `<span class="pr">${fmt(e.price)}</span> <span class="tag oferta">${can?"ahorra":"ahorro observado"} $${(+e.saving).toFixed(2)}</span>`
      + (can && hist && a.pct_min != null && a.pct_min <= 0
         ? `<span class="tag real">oferta real</span>` : "");
  }
  else {
    const cl = clubs ? clubsLine(clubs) : (e.club||"");
    price = `<span class="pr">${fmt(e.price)}</span> <span class="tag ${e.type}">${(LABEL[e.type]||e.type)}${cl?" "+cl:""}</span>`;
  }
  const dias = e.days_out != null ? ` · ${e.days_out}d fuera` : "";
  const ea = D.agg[e.sku]||{};
  const oe = e.type==="oferta_termino" && ea.of_end;
  const odur = oe ? ` · oferta ${oe[0].slice(5)}→${oe[1].slice(5)}` : "";
  const ocd = oe && ea.of_every ? ` · vuelve ~cada ${ea.of_every}d` : "";
  // contexto actual: "subio +12%" junto a "mínimo histórico" = no pasa
  // nada; y si el articulo quedo sin stock, la card lo admite
  const vd = verdict(e.sku);
  // los veredictos negativos (sin stock / sin verificacion / sin
  // precio) se declaran SIEMPRE, incluso en cards de oferta — el
  // letrero no puede tapar que la lectura no es vigente. Lo positivo
  // sigue evitando duplicar la tag de ahorro en cards de oferta.
  const vtag = (vd.rank >= 8 || (e.type !== "oferta" && vd.rank <= 3))
    ? ` <span class="tag ${vd.cls}">${vd.label}</span>` : "";
  // el movimiento ya se reverto por completo (promo titilando): la card
  // admite que el evento quedo obsoleto en vez de contradecir el spark
  const lp = (D.series[e.sku]||[]).at(-1)?.[1];
  const rtag = (lp!=null && e.from!=null && (
    e.type==="subio" && lp<=e.from
      ? ` <span class="tag salio_del_catalogo">↩ ya volvió a bajar</span>`
    : (e.type==="bajo"||e.type==="rebaja") && lp>=e.from
      ? ` <span class="tag salio_del_catalogo">↩ ya volvió a subir</span>`
    : "")) || "";
  return `<article class="card">
    ${star(e.sku)}
    ${img(e.sku)?`<img src="${esc(img(e.sku))}" alt="" loading="lazy" onerror="this.remove()">`:""}
    <div style="flex:1;min-width:0">
      <h3 class="t">${esc(e.title||p.title||e.sku)}</h3><div>${price}${vtag}${rtag}</div>
      <div class="meta">${e.date||""}${dias}${odur}${ocd} · ${esc(p.category||"")}${ea.temp?" · de temporada":""}</div>
      <button type="button" class="det"
        onclick="openProd(${jsArg(e.sku)})">detalle ›</button>
      <div class="spark" data-sku="${e.sku}"></div></div></article>`;
}
// paginado progresivo: los feeds largos (busqueda, gangas) muestran
// de a 24 con conteo visible — nada de corte silencioso en 60/120
const PAGE_STEP = 24;
const PAGE = { buscar: PAGE_STEP, ofertas: PAGE_STEP, cambios: PAGE_STEP,
               stock: PAGE_STEP, nuevos: PAGE_STEP, favs: PAGE_STEP };
const moreBtn = (id, shown, total) => {
  const el = document.getElementById("more-" + id);
  if (!el) return;
  el.innerHTML = shown < total
    ? `<span class="meta">${shown} de ${total}</span>
       <button type="button" class="chip" data-more="${id}">Mostrar ${PAGE_STEP} más</button>`
    : total > PAGE_STEP
      ? `<span class="meta">${total} de ${total}</span>` : "";
};
document.addEventListener("click", e => {
  const b = e.target.closest("[data-more]");
  if (!b || !PAGE[b.dataset.more]) return;
  PAGE[b.dataset.more] += PAGE_STEP;
  render();
});
function render(){
  const q = $("#q").value.trim();
  const f = e => !q || matchQ(q, e.title, (D.products[e.sku]||{}).title);
  const cfe = cf === "new" && !NEWV.length ? "all" : cf;
  const favList = [...FAV].sort((x,y)=>verdict(x).rank-verdict(y).rank);
  if (SHOP) favList.sort((x,y)=>(CART.has(x)?1:0)-(CART.has(y)?1:0));
  // alertas accionables: solo ocupan espacio cuando hay algo que hacer
  const alerts = [];
  const favOf   = favList.filter(FAVFF.oferta),
        resu    = favList.filter(FAVFF.resurtir),
        favOut  = favList.filter(FAVFF.sinstock),
        clubOut = favList.filter(FAVFF.clubout),
        favSA   = favList.filter(FAVFF.seagota);
  if (favSA.length)  alerts.push([`${favSA.length} de tu lista se está${favSA.length>1?"n":""} agotando`,"favs","","seagota"]);
  if (favOf.length)  alerts.push([`${favOf.length} de tu lista en oferta`,"favs","","oferta"]);
  if (resu.length)   alerts.push([`${resu.length} para resurtir`,"favs","","resurtir"]);
  if (favOut.length) alerts.push([`${favOut.length} de tu lista sin stock`,"favs","","sinstock"]);
  if (MYCLUB && clubOut.length)
    alerts.push([`${clubOut.length} de tu lista agotado en ${MYCLUB}`,"favs","","clubout"]);
  const nReb = byType("rebaja").filter(e=>!deadPrice(e)).length;
  // "rebaja" es un cf dedicado (sin chip propio): el alerta de
  // silenciosas no debe mezclarse con las bajadas con letrero
  if (nReb) alerts.push([`${nReb} rebaja${nReb>1?"s":""} silenciosa${nReb>1?"s":""}`,"cambios","rebaja"]);
  const simAl = simanAlerts(), nSiman = simAl.length;
  if (nSiman) alerts.push([`${nSiman} ganga${nSiman>1?"s":""} en Siman`,"siman"]);
  for (const s in TARGETS) {
    const l = lastOf(s);
    // objetivo cruzado solo se alerta con lectura vigente: un precio
    // viejo bajo el objetivo no significa que HOY este a ese precio
    if (l && PWData.buyable(s) && l[1] <= TARGETS[s])
      alerts.push([`🎯 ${(D.products[s]||{}).title||s} a ${fmt(l[1])} (objetivo ${fmt(TARGETS[s])})`, "", "", "", s]);
  }
  let deltaTxt = "";
  if (NEWV.length) {
    const nt = t => NEWEV.filter(e => e.type === t && !deadPrice(e)).length, parts = [];
    const nb = nt("bajo")+nt("rebaja"), ns = nt("subio"), nof = nt("oferta"),
          nr = nt("reaparecio")+nt("club_volvio")+nt("regreso"),
          na = nt("agotado")+nt("club_agotado"), nc = nt("se_agota"),
          nn = nt("nuevo"), nf = NEWEV.filter(e => FAV.has(e.sku) && !deadPrice(e)).length;
    if (nb)  parts.push(`${nb} bajada${nb>1?"s":""}`);
    if (ns)  parts.push(`${ns} subida${ns>1?"s":""}`);
    if (nof) parts.push(`${nof} oferta${nof>1?"s":""}`);
    if (nr)  parts.push(`${nr} volvieron`);
    if (na)  parts.push(`${na} agotado${na>1?"s":""}`);
    if (nc)  parts.push(`${nc} se agota${nc>1?"n":""}`);
    if (nn)  parts.push(`${nn} nuevo${nn>1?"s":""}`);
    if (nf)  parts.push(`⚡${nf} de tu lista`);
    deltaTxt = `desde tu última visita: ${parts.join(" · ")}`;
    alerts.unshift([deltaTxt, "cambios", "new"]);
  }
  RESUMEN = alerts;
  // el texto del alerta puede traer titulos de producto (objetivo 🎯):
  // va escapado — un < o & rompia el marcado del resumen y del dlg-nav
  $("#alerts").innerHTML = alerts.map(([t,tab,cf2,ff,sk]) =>
    `<button type="button" class="alert${cf2==="new"?" new":""}" data-tab="${tab}" data-cf="${cf2||""}"
       data-ff="${ff||""}"${sk?` data-sku="${sk}"`:""}>${esc(t)}</button>`).join("");
  // pendientes = articulos unicos de tu lista que piden atencion
  RESUMEN_N = new Set([...favOf, ...resu, ...favOut, ...clubOut, ...favSA]).size;
  const bar = $("#shopbar");
  if (SHOP) {
    let tot = 0, diff = 0, nd = 0, units = 0;
    for (const s of CART) {
      const l = lastOf(s), a = D.agg[s], ln = CART_LINES[s];
      const q = ln && ln.quantity || 1;
      units += q;
      // precio editado por linea gana sobre el estimado del catalogo
      const unit = ln && ln.unitCents != null ? ln.unitCents
                                              : (l ? l[1] : 0);
      tot += unit * q;
      if (l && a && a.med != null) { diff += unit - a.med; nd++; }
    }
    bar.style.display = "flex";
    $("#shop-tot").innerHTML = `🛒 ${CART.size} artículo${CART.size>1?"s":""}`
      + (units > CART.size ? ` (${units} uds)` : "")
      + ` · $${(tot/100).toFixed(2)} estimado`
      + (nd ? ` · <span style="color:${diff<0?"var(--down)":"var(--up)"}">`
          + `${diff<0?"−":"+"}$${Math.abs(diff/100).toFixed(2)} vs típico</span>` : "");
  } else bar.style.display = "none";
  // entrada al carrito desde Mi lista — existe aunque el sku no sea
  // favorito (el carrito no se limita a la lista)
  const cv = document.getElementById("cart-view");
  if (cv) {
    cv.style.display = CART.size ? "" : "none";
    cv.textContent = `🛒 ver carrito (${CART.size})`;
  }
  const nChFav = ev.filter(e=>["bajo","subio"].includes(e.type)&&FAV.has(e.sku)).length;
  const favN = document.querySelector('.tab[data-t="favs"] .n');
  if (favN) favN.textContent = FAV.size + (nChFav ? ` ⚡${nChFav}` : "");
  // franja de estado fuera del dialogo de cuenta: edad del dataset,
  // sync, proximo barrido y avisos de corrupcion/cache — siempre
  // visible, nunca se auto-oculta al entrar una sesion
  const dsTxt = document.getElementById("ds-text");
  if (dsTxt) {
    const parts = [];
    if (window.DATA_FROM_CACHE) parts.push("copia guardada");
    if (typeof navigator !== "undefined"
        && navigator.onLine === false) parts.push("sin conexión");
    parts.push(`datos al ${D.generated || "?"}`);
    const nxt = Date.parse(PWData.nextSweep());
    if (Number.isFinite(nxt)) {
      const sv = new Date(nxt - 6 * 3600e3);
      parts.push(`próx. barrido ${
        sv.toISOString().slice(0, 10) === todaySV()
          ? "hoy" : "mañana"} ${sv.toISOString().slice(11, 16)}`);
    }
    if (typeof syncLine === "function") parts.push(syncLine());
    dsTxt.innerHTML = parts.map(esc).join(" · ")
      + (PWStore.corruptBlocking()
         ? ` <span class="warn">⚠ datos locales dañados —`
           + ` sincronización congelada</span>` : "");
    const rt = document.getElementById("ds-retry");
    if (rt) rt.style.display =
      (typeof SYNC !== "undefined" && AW && AW.user
       && (SYNC.state === "error" || SYNC.err)) ? "" : "none";
    const fx = document.getElementById("ds-fix");
    if (fx) fx.style.display = PWStore.corruptBlocking() ? "" : "none";
  }
  // panes perezosos: solo el activo se reconstruye — las interacciones
  // frecuentes (estrella, carrito, buscador) ya no pagan el HTML de los
  // 7 paneles; al cambiar de tab el handler llama render() y rellena
  // el entrante
  // el limite visible se reinicia cuando cambia la consulta/filtro —
  // la lista ya mostrada se conserva al pedir mas (append, no reset)
  // cualquier cambio de consulta/filtro reinicia TODAS las ventanas —
  // mostrar "24 mas" de una lista filtrada distinta seria confuso
  const sig = q + "|" + OF_F + "|" + cf + "|" + favFilter
            + "|" + (SHOP ? 1 : 0);
  if (sig !== PAGE._sig) {
    PAGE._sig = sig;
    for (const k in PAGE)
      if (typeof PAGE[k] === "number") PAGE[k] = PAGE_STEP;
  }
  const PANES = {
    // Inicio: resumen accionable + hasta 3 gangas recien verificadas
    // + hasta 3 de tu lista. Sin hero: lo que pide atencion primero
    "pane-inicio": () => {
      $("#ini-alerts").innerHTML = alerts.length
        ? alerts.map(([t,tab,cf2,ff,sk]) =>
          `<button type="button" class="alert${cf2==="new"?" new":""}"
             data-tab="${tab}" data-cf="${cf2||""}" data-ff="${ff||""}"
             ${sk?` data-sku="${sk}"`:""}>${esc(t)}</button>`).join("")
        : "<p class='meta'>Todo al día — nada pide atención.</p>";
      // DEALS se armo al evaluar el modulo: si desde entonces vencio
      // el corte de frescura, dealOK lo vuelve a filtrar al pintar
      const deals3 = DEALS.filter(s => dealOK(s, "all"))
        .sort((a,b)=>dealScore(b)-dealScore(a)).slice(0,3);
      $("#g-ini-deals").innerHTML = deals3.map(favCard).join("")
        || "<p class='meta'>Sin gangas verificadas hoy.</p>";
      $("#g-ini-favs").innerHTML = favList.slice(0,3)
        .map(favCard).join("")
        || "<p class='meta'>Marca productos con ☆ para seguirlos"
         + " — aparecen aquí con su veredicto.</p>";
    },
    "pane-cambios": () => {
      // "nuevas" muestra TODO lo nuevo (no solo precios): el chip del
      // resumen cuenta stock y nuevos tambien, el destino debe coincidir
      const cambios = ev.filter(e=>!deadPrice(e) && (cfe==="new"
        ? NEWSET.has(e) && f(e)
        : ["bajo","subio","oferta_termino","rebaja"].includes(e.type)
          && (cfe==="all" ? true : cfe==="fav" ? FAV.has(e.sku)
              : cfe==="bajo" ? (e.type==="bajo"||e.type==="rebaja")
              : e.type===cfe)
          && f(e)));
      // bajaron/subieron van por magnitud: el Eufy -48% no se entierra
      // bajo -2%s
      if (cfe === "bajo" || cfe === "rebaja")
        cambios.sort((a,b) => (a.pct??0) - (b.pct??0));
      if (cfe === "subio") cambios.sort((a,b) => (b.pct??0) - (a.pct??0));
      // confesion: cuantos ajustes de catalogo se ocultaron EN ESTA
      // VISTA (mismo alcance del chip activo). Clic = auditoria: los
      // muestra atenuados, marcados — no se mezclan con lo accionable
      const dead = ev.filter(e => deadPrice(e) && f(e) && (cfe==="new"
        ? NEWSET.has(e)
        : ["bajo","subio","oferta_termino","rebaja"].includes(e.type)
          && (cfe==="all" || (cfe==="fav" ? FAV.has(e.sku)
              : cfe==="bajo" ? (e.type==="bajo"||e.type==="rebaja")
              : e.type===cfe))));
      const deadHtml = SHOW_DEAD ? "<div class='deadzone'>"
        + groupClubs(dead).map(g => card(g[0], g)).join("")
        + "</div>" : "";
      const cGroups = groupClubs(cambios);
      $("#g-cambios").innerHTML = (cGroups.slice(0, PAGE.cambios)
        .map(g => card(g[0], g)).join("")
        || "<p class='meta'>Sin cambios</p>")
        + deadHtml
        + (dead.length
          ? `<p class='meta dead-toggle' style='grid-column:1/-1;cursor:pointer'>`
          + `${dead.length} ajuste${dead.length>1?"s":""} de precio en artículos sin stock`
          + ` — ${SHOW_DEAD ? "mostrando" : "ocultos"} ${SHOW_DEAD ? "▲" : "▸ ver"}</p>` : "");
      moreBtn("cambios", Math.min(PAGE.cambios, cGroups.length),
              cGroups.length);
      $("#cf-new").style.display = NEWV.length ? "" : "none";
      movChart(cambios);
    },
    "pane-ofertas": () => {
      const dealList = DEALS
        .filter(s => dealOK(s, OF_F)
                 && (!q || matchQ(q, (D.products[s]||{}).title)))
        .sort((a,b) => dealScore(b) - dealScore(a));
      $("#g-ofertas").innerHTML = dealList.slice(0, PAGE.ofertas)
        .map(favCard).join("") || "<p class='meta'>Sin gangas hoy</p>";
      moreBtn("ofertas", Math.min(PAGE.ofertas, dealList.length),
              dealList.length);
      dealChart(dealList);
    },
    // el feed cuenta solo transiciones del producto a nivel pais
    // (hay / no hay / existe / no existe). "se agota" es urgencia que
    // vive en las cards, y lo que pasa en un club puntual es detalle
    // que vive en la ficha — ninguno de los dos es cambio de estado.
    "pane-stock": () => {
      const st = ev
        .filter(e=>["agotado","reaparecio","salio_del_catalogo",
                    "regreso"].includes(e.type) && f(e));
      $("#g-stock").innerHTML = st.slice(0, PAGE.stock)
        .map(e=>card(e)).join("")
        || "<p class='meta'>Sin cambios de disponibilidad</p>";
      moreBtn("stock", Math.min(PAGE.stock, st.length), st.length);
    },
    "pane-nuevos": () => {
      const nv = ev.filter(e=>e.type==="nuevo"&&f(e));
      $("#g-nuevos").innerHTML =
        nv.slice(0, PAGE.nuevos).map(e=>card(e)).join("")
        || "<p class='meta'>Sin productos nuevos</p>";
      moreBtn("nuevos", Math.min(PAGE.nuevos, nv.length), nv.length);
    },
    "pane-favs": () => {
      const show = favFilter === "all" ? favList
                 : favList.filter(FAVFF[favFilter] || (()=>true));
      const ffEl = $("#fav-filter");
      ffEl.style.display = favFilter === "all" ? "none" : "";
      if (favFilter !== "all") {
        const lbl = {oferta:"en oferta", resurtir:"para resurtir",
          sinstock:"sin stock", clubout:`agotado en ${MYCLUB}`,
          seagota:"se están agotando"}[favFilter];
        ffEl.textContent = `viendo: ${lbl} · ${show.length} ✕`;
      }
      // cold start: sin lista, sugerir lo mas barato de hoy para empezar
      const SUGG = show.length || FAV.size ? [] : DEALS
        .filter(atMin)
        .sort((a,b) => dealScore(b) - dealScore(a)).slice(0, 8);
      $("#g-favs").innerHTML = show.slice(0, PAGE.favs)
        .map(favCard).join("")
        || (FAV.size === 0 && SUGG.length
            ? `<p class='meta' style='margin-bottom:8px'>Tu lista está vacía — `
            + `marca ☆ en lo que compras seguido`
            + (AW.user ? "" : ` (con "cuenta" se sincroniza entre teléfono y PC)`)
            + `. Lo más barato hoy para empezar:</p>`
            + SUGG.map(favCard).join("")
            : `<p class='meta'>Marca productos con ☆ para seguirlos aquí.`
            + (AW.user ? "" : ` Con 'cuenta' se sincronizan entre teléfono y PC.`)
            + `</p>`);
      moreBtn("favs", Math.min(PAGE.favs, show.length), show.length);
      if (FAV.size) {
        const vs = favList.map(verdict);
        const ok = vs.filter(v=>v.rank<=4).length,
              up = vs.filter(v=>v.rank===6).length,
              out = vs.filter(v=>v.rank===8).length,
              nv = vs.filter(v=>v.rank===9).length;
        // "sin verificar" no es "sin stock": el desglose lo separa —
        // un dato vencido no confirma quiebre
        $("#favs-sum").textContent = favFilter === "all"
          ? `${ok} en buen precio · ${up} subieron · ${out} sin stock`
            + (nv ? ` · ${nv} sin verificar` : "")
            + ` — ordenados por conveniencia`
          : `viendo ${show.length} de ${FAV.size} en tu lista`;
      } else $("#favs-sum").textContent = "";
    },
    // siman: alertas agrupadas por busqueda vigilada (acordeon).
    // se conserva que grupos tiene abiertos el usuario entre renders
    "pane-siman": () => {
      const sGroups = {};
      // en el tab Siman el buscador global filtra estas cards (titulo,
      // marca o vigilancia) en vez de cubrir el pane con el catalogo
      simAl.filter(p => !q || matchQ(q, p.t, p.b, p.w)).forEach(p =>
        (sGroups[(p.w||"otros") + (p.ta ? " · "+p.ta : "")] ??= []).push(p));
      document.querySelectorAll("#g-siman details.acc").forEach(d =>
        ACC_OPEN[d.dataset.k] = d.open);
      const gMin = k => Math.min(...sGroups[k].map(p => p.p ?? Infinity));
      const gDisc = k => Math.max(...sGroups[k].map(sDisc));
      const sKeys = Object.keys(sGroups).sort({
        count: (a,b) => sGroups[b].length - sGroups[a].length
                 || sGroups[b].filter(x=>x.broke).length
                    - sGroups[a].filter(x=>x.broke).length,
        disc:  (a,b) => gDisc(b) - gDisc(a)
                 || sGroups[b].length - sGroups[a].length,
        price: (a,b) => gMin(a) - gMin(b)
                 || sGroups[b].length - sGroups[a].length,
        az:    (a,b) => a.localeCompare(b),
      }[SSORT]);
      $("#g-siman").innerHTML = sKeys.map(k => {
        const items = sGroups[k]
          .sort((a,b) => (b.broke-a.broke) || sDisc(b)-sDisc(a));
        const min = gMin(k);
        const open = k in ACC_OPEN ? ACC_OPEN[k] : items.length <= 3;
        return `<details class="acc" data-k="${esc(k)}"${open?" open":""}>
          <summary>${esc(k)}
            <span class="meta">${items.length}${min<Infinity
              ? " · desde "+fmt(Math.round(min*100)) : ""}</span></summary>
          <div class="grid">${items.map(sCard).join("")}</div>
        </details>`;
      }).join("")
        || (q ? `<p class='meta'>Sin coincidencias en Siman</p>`
            : `<p class='meta'>Sin alertas hoy — ${SIMAN.n_items||0} variantes `
            + `bajo vigilancia.</p>`);
      document.querySelectorAll("#siman-sort .chip").forEach(c =>
        c.classList.toggle("on", c.dataset.ss === SSORT));
      $("#siman-sum").textContent =
        `vigilando ${SWATCH.length} artículos · ${nSiman} alertan`;
      // procedencia honesta: de cuando es la ultima lectura Siman y si
      // ya hay items cuya observacion caduco (excluidos de las alertas)
      const sfEl = document.getElementById("siman-fresh");
      if (sfEl) {
        const sd = PWData.sourceDate("siman");
        const nOld = SIMAN.items
          .filter(p => PWData.siman(p).state !== "available").length;
        sfEl.textContent = sd
          ? `lectura ${sd}${nOld ? ` · ${nOld} ya no vigente${nOld>1?"s":""}` : ""}`
          : "";
      }
      $("#siman-watches").innerHTML = SWATCH.map(w =>
        `<span class="chip on">${esc(w.q)}${w.talla?` · ${esc(w.talla)}`:""}
         <button type="button" class="chip" style="padding:0 6px;color:var(--up)"
            aria-label="dejar de vigilar ${esc(w.q)}"
            data-wq="${esc(w.q)}|${esc(w.talla||"")}">✕</button></span>`
      ).join(" ")
        + (AW.user ? "" :
           " <span class='meta'>sin sesión: cambios solo locales</span>");
      // silenciados (👎): restaurables; cada regla "pid|tkey" muestra
      // el titulo
      $("#siman-muted").innerHTML = SMUTE.size
        ? `<span class="meta">silenciados:</span> ` + [...SMUTE].map(r =>
            `<span class="chip">${esc(r.split("|")[1] || r)}
             <button type="button" class="chip" style="padding:0 6px;color:var(--down)"
                aria-label="restaurar ${esc(r.split("|")[1] || r)} a las alertas"
                data-mu="${esc(r)}">↩</button></span>`).join(" ")
        : "";
    },
    "pane-buscar": () => {
      if (q.length >= 2) {
        const hits = Object.keys(D.products)
          .filter(s => { const p = D.products[s]||{};
            return matchQ(q, p.title, p.brand, p.category, s); });
        $("#g-buscar").innerHTML = hits.slice(0, PAGE.buscar)
          .map(favCard).join("")
          || "<p class='meta'>Sin coincidencias en el catálogo</p>";
        moreBtn("buscar", Math.min(PAGE.buscar, hits.length),
                hits.length);
      } else { $("#g-buscar").innerHTML = ""; moreBtn("buscar", 0, 0); }
    },
  };
  const act = document.querySelector(".pane.on");
  if (act && PANES[act.id]) PANES[act.id]();
  sparks();
}
// card compacta: titulo, precio, un veredicto, estado de tu club con
// fecha, fecha de la observacion, carrito (modo compra), estrella y
// boton de detalle. Sparks, comparativas, todos los clubes, objetivos
// y compras viven en la ficha — la card no repite la ficha
function favCard(sku){
  const p = D.products[sku]||{}, l = (D.series[sku]||[]).slice(-1)[0],
        v = verdict(sku), inCart = CART.has(sku), pf = PWData.product(sku);
  const mc = MYCLUB ? (D.clubs[sku]||{})[MYCLUB] : null;
  const mcs = mc ? PWData.product(sku, MYCLUB) : null;
  // el club va con su fecha de observacion — "agotado" solo se afirma
  // de una lectura vigente
  // el simbolo sale SOLO del estado de la observacion (available ✓ /
  // unavailable ✗ / otra cosa = "sin verificar") — jamas de
  // mc.in_stock crudo: un club sin lectura vigente no dice ni si ni no
  const clubTag = mc
    ? `<span class="tag ${mcs.state === "available" ? "bajo"
        : mcs.state === "unavailable" ? "agotado"
        : "salio_del_catalogo"}">📍 ${esc(MYCLUB)} ${
        mcs.state === "available" ? "✓"
        : mcs.state === "unavailable" ? "✗" : "sin verificar"}${
        mcs.observedAt ? " "+esc(mcs.observedAt.slice(5)) : ""}</span>`
    : "";
  return `<article class="card${SHOP&&inCart?" incart":""}">
    ${SHOP?`<input type="checkbox" class="cartcheck" ${inCart?"checked":""}
      aria-label="agregar ${esc(p.title||sku)} al carrito"
      onclick="cartToggle(${jsArg(sku)},this.checked,${PWStore.currentEpoch()})">`:star(sku)}
    ${img(sku)?`<img src="${esc(img(sku))}" alt="" loading="lazy" onerror="this.remove()">`:""}
    <div style="flex:1;min-width:0">
      <h3 class="t">${esc(p.title||sku)}</h3>
      <div><span class="pr">${l?fmt(l[1]):"—"}</span>
        <span class="tag ${v.cls}">${v.label}</span>
        ${l&&l[3]>0&&PWData.buyable(sku)
          ?`<span class="tag oferta">-$${(+l[3]).toFixed(2)}</span>`:""}
        ${clubTag}</div>
      <div class="meta">${v.tip?v.tip+" · ":""}lectura ${pf.observedAt||"sin fecha"}</div>
      <button type="button" class="det"
        onclick="openProd(${jsArg(sku)})">detalle ›</button>
    </div></article>`;
}
function sparks(){
  // solo el panel visible: render() reconstruye los 7 panes en cada
  // tecla del buscador — pintar sparks de panes ocultos era trabajo
  // tirado (los panes ocultos se rellenan al cambiar de tab)
  document.querySelectorAll(".pane.on .spark").forEach(el => {
    const s = D.series[el.dataset.sku]||[];
    if (s.length < 2) return;
    const pts = s.map(p=>p[1]), mn=Math.min(...pts), mx=Math.max(...pts);
    const w=280,h=28, rng=(mx-mn)||1;
    const xy = pts.map((v,i)=>`${(i/(pts.length-1)*w).toFixed(1)},${(h-2-(v-mn)/rng*(h-4)).toFixed(1)}`).join(" ");
    const col = s[s.length-1][1] <= s[0][1] ? "var(--down)" : "var(--up)";
    el.innerHTML = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${xy}" fill="none" stroke="${col}" stroke-width="1.5"/></svg>`;
  });
}
