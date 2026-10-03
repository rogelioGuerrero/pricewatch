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
function card(e, clubs){
  const p = D.products[e.sku]||{};
  let price;
  if (e.from != null && e.to != null)
    price = `<span class="old">${fmt(e.from)}</span> → <span class="pr">${fmt(e.to)}</span>
      <span class="tag ${e.type}">${e.pct>0?"+":""}${e.pct}%</span>
      ${["reaparecio","regreso","oferta_termino","rebaja"].includes(e.type)?`<span class="tag ${e.type}">${LABEL[e.type]}</span>`:""}`;
  else if (e.type==="oferta"){
    const a = D.agg[e.sku]||{}, hist = (D.series[e.sku]||[]).length>=3;
    price = `<span class="pr">${fmt(e.price)}</span> <span class="tag oferta">ahorra $${(+e.saving).toFixed(2)}</span>`
      + (hist && a.pct_min<=0 ? `<span class="tag real">oferta real</span>` : "");
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
  // contexto actual: "subio +12%" junto a "mínimo histórico" = no pasa nada
  const vd = verdict(e.sku);
  const vtag = e.type !== "oferta" && vd.rank <= 3
    ? ` <span class="tag ${vd.cls}">${vd.label}</span>` : "";
  // el movimiento ya se reverto por completo (promo titilando): la card
  // admite que el evento quedo obsoleto en vez de contradecir el spark
  const lp = (D.series[e.sku]||[]).at(-1)?.[1];
  const rtag = lp!=null && e.from!=null && (
    e.type==="subio" && lp<=e.from
      ? ` <span class="tag salio_del_catalogo">↩ ya volvió a bajar</span>`
    : (e.type==="bajo"||e.type==="rebaja") && lp>=e.from
      ? ` <span class="tag salio_del_catalogo">↩ ya volvió a subir</span>`
    : "");
  return `<div class="card" onclick="openProd('${e.sku}')">
    ${star(e.sku)}
    ${img(e.sku)?`<img src="${img(e.sku)}" loading="lazy" onerror="this.remove()">`:""}
    <div style="flex:1;min-width:0">
      <div class="t">${esc(e.title||p.title||e.sku)}</div><div>${price}${vtag}${rtag}</div>
      <div class="meta">${e.date||""}${dias}${odur}${ocd} · ${p.category||""}${ea.temp?" · de temporada":""}</div>
      <div class="spark" data-sku="${e.sku}"></div></div></div>`;
}
function render(){
  const q = $("#q").value.trim();
  const f = e => !q || matchQ(q, e.title, (D.products[e.sku]||{}).title);
  const cfe = cf === "new" && !NEWEV.length ? "all" : cf;
  // "nuevas" muestra TODO lo nuevo (no solo precios): el chip del resumen
  // cuenta stock y nuevos tambien, el destino debe coincidir
  const cambios = ev.filter(e=>cfe==="new"
    ? NEWSET.has(e) && f(e)
    : ["bajo","subio","oferta_termino","rebaja"].includes(e.type)
      && (cfe==="all" ? true : cfe==="fav" ? FAV.has(e.sku)
          : cfe==="bajo" ? e.type==="rebaja" : e.type===cfe)
      && f(e));
  // bajaron/subieron van por magnitud: el Eufy -48% no se entierra bajo -2%s
  if (cfe === "bajo")  cambios.sort((a,b) => (a.pct??0) - (b.pct??0));
  if (cfe === "subio") cambios.sort((a,b) => (b.pct??0) - (a.pct??0));
  $("#g-cambios").innerHTML = groupClubs(cambios)
    .map(g => card(g[0], g)).join("")
    || "<p class='meta'>Sin cambios</p>";
  $("#cf-new").style.display = NEWEV.length ? "" : "none";
  movChart(cambios);
  const dealList = DEALS
    .filter(s => dealOK(s, OF_F)
             && (!q || matchQ(q, (D.products[s]||{}).title)))
    .sort((a,b) => dealScore(b) - dealScore(a));
  $("#g-ofertas").innerHTML = dealList.slice(0, 120)
    .map(favCard).join("") || "<p class='meta'>Sin gangas hoy</p>";
  dealChart(dealList);
  // el feed cuenta solo transiciones del producto a nivel pais
  // (hay / no hay / existe / no existe). "se agota" es urgencia que
  // vive en las cards, y lo que pasa en un club puntual es detalle
  // que vive en la ficha — ninguno de los dos es cambio de estado.
  const stockEv = ev.filter(e=>["agotado","reaparecio","salio_del_catalogo",
                                "regreso"].includes(e.type) && f(e));
  $("#g-stock").innerHTML = stockEv.map(e=>card(e)).join("")
    || "<p class='meta'>Sin cambios de disponibilidad</p>";
  $("#g-nuevos").innerHTML = ev.filter(e=>e.type==="nuevo"&&f(e)).map(e=>card(e)).join("") || "<p class='meta'>Sin productos nuevos</p>";
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
  const nReb = byType("rebaja").length;
  if (nReb) alerts.push([`${nReb} rebaja${nReb>1?"s":""} silenciosa${nReb>1?"s":""}`,"cambios","bajo"]);
  const simAl = simanAlerts(), nSiman = simAl.length;
  if (nSiman) alerts.push([`${nSiman} ganga${nSiman>1?"s":""} en Siman`,"siman"]);
  for (const s in TARGETS) {
    const l = lastOf(s);
    if (l && l[2] && l[1] <= TARGETS[s])
      alerts.push([`🎯 ${(D.products[s]||{}).title||s} a ${fmt(l[1])} (objetivo ${fmt(TARGETS[s])})`, "", "", "", s]);
  }
  let deltaTxt = "";
  if (NEWEV.length) {
    const nt = t => NEWEV.filter(e => e.type === t).length, parts = [];
    const nb = nt("bajo")+nt("rebaja"), ns = nt("subio"), nof = nt("oferta"),
          nr = nt("reaparecio")+nt("club_volvio")+nt("regreso"),
          na = nt("agotado")+nt("club_agotado"), nc = nt("se_agota"),
          nn = nt("nuevo"), nf = NEWEV.filter(e => FAV.has(e.sku)).length;
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
  $("#alerts").innerHTML = alerts.map(([t,tab,cf2,ff,sk]) =>
    `<span class="alert${cf2==="new"?" new":""}" data-tab="${tab}" data-cf="${cf2||""}"
       data-ff="${ff||""}"${sk?` data-sku="${sk}"`:""}>${t}</span>`).join("");
  // pendientes = articulos unicos de tu lista que piden atencion
  RESUMEN_N = new Set([...favOf, ...resu, ...favOut, ...clubOut, ...favSA]).size;
  const bar = $("#shopbar");
  if (SHOP) {
    let tot = 0, diff = 0, nd = 0;
    for (const s of CART) {
      const l = lastOf(s), a = D.agg[s];
      if (l) tot += l[1];
      if (l && a && a.med != null) { diff += l[1] - a.med; nd++; }
    }
    bar.style.display = "flex";
    $("#shop-tot").innerHTML = `🛒 ${CART.size} · $${(tot/100).toFixed(2)}`
      + (nd ? ` · <span style="color:${diff<0?"var(--down)":"var(--up)"}">`
          + `${diff<0?"−":"+"}$${Math.abs(diff/100).toFixed(2)} vs típico</span>` : "");
  } else bar.style.display = "none";
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
    .filter(s => atMin(s) && lastOf(s)?.[2])
    .sort((a,b) => dealScore(b) - dealScore(a)).slice(0, 8);
  $("#g-favs").innerHTML = show.map(favCard).join("")
    || (FAV.size === 0 && SUGG.length
        ? `<p class='meta' style='margin-bottom:8px'>Tu lista está vacía — `
        + `marca ☆ en lo que compras seguido`
        + (AW.user ? "" : ` (con "cuenta" se sincroniza entre teléfono y PC)`)
        + `. Lo más barato hoy para empezar:</p>`
        + SUGG.map(favCard).join("")
        : `<p class='meta'>Marca productos con ☆ para seguirlos aquí.`
        + (AW.user ? "" : ` Con 'cuenta' se sincronizan entre teléfono y PC.`)
        + `</p>`);
  // siman: alertas agrupadas por busqueda vigilada (acordeon).
  // se conserva que grupos tiene abiertos el usuario entre renders
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
  $("#siman-watches").innerHTML = SWATCH.map(w =>
    `<span class="chip on">${esc(w.q)}${w.talla?` · ${esc(w.talla)}`:""}
     <a style="cursor:pointer;color:var(--up)"
        data-wq="${esc(w.q)}|${esc(w.talla||"")}">✕</a></span>`
  ).join(" ")
    + (AW.user ? "" :
       " <span class='meta'>sin sesión: cambios solo locales</span>");
  // silenciados (👎): restaurables; cada regla "pid|tkey" muestra el titulo
  $("#siman-muted").innerHTML = SMUTE.size
    ? `<span class="meta">silenciados:</span> ` + [...SMUTE].map(r =>
        `<span class="chip">${esc(r.split("|")[1] || r)}
         <a style="cursor:pointer;color:var(--down)"
            title="restaurar a las alertas"
            data-mu="${esc(r)}">↩</a></span>`).join(" ")
    : "";
  const nChFav = ev.filter(e=>["bajo","subio"].includes(e.type)&&FAV.has(e.sku)).length;
  const favN = document.querySelector('.tab[data-t="favs"] .n');
  if (favN) favN.textContent = FAV.size + (nChFav ? ` ⚡${nChFav}` : "");
  if (FAV.size) {
    const vs = favList.map(verdict);
    const ok = vs.filter(v=>v.rank<=4).length,
          up = vs.filter(v=>v.rank===6).length,
          out = vs.filter(v=>v.rank>=8).length;
    $("#favs-sum").textContent = favFilter === "all"
      ? `${ok} en buen precio · ${up} subieron · ${out} sin stock — ordenados por conveniencia`
      : `viendo ${show.length} de ${FAV.size} en tu lista`;
  } else $("#favs-sum").textContent = "";
  if (q.length >= 2) {
    $("#g-buscar").innerHTML = Object.keys(D.products)
      .filter(s => { const p = D.products[s]||{};
        return matchQ(q, p.title, p.brand, p.category, s); })
      .slice(0, 60).map(favCard).join("")
      || "<p class='meta'>Sin coincidencias en el catálogo</p>";
  }
  sparks();
}
function favCard(sku){
  const p = D.products[sku]||{}, l = (D.series[sku]||[]).slice(-1)[0],
        a = D.agg[sku]||{}, v = verdict(sku), m = PAID[sku],
        nBuys = COMPRAS.filter(c=>c.sku===sku).length,
        inCart = CART.has(sku);
  return `<div class="card${SHOP&&inCart?" incart":""}" onclick="openProd('${sku}')">
    ${SHOP?`<input type="checkbox" class="cartcheck" ${inCart?"checked":""}
      onclick="event.stopPropagation();cartToggle('${sku}',this.checked)">`:star(sku)}
    ${img(sku)?`<img src="${img(sku)}" loading="lazy" onerror="this.remove()">`:""}
    <div style="flex:1;min-width:0">
      <div class="t">${esc(p.title||sku)}</div>
      <div><span class="pr">${l?fmt(l[1]):"—"}</span>
        <span class="tag ${v.cls}">${v.label}</span>
        ${TARGETS[sku]!=null?`<span class="tag ${l&&l[1]<=TARGETS[sku]?"real":"oferta"}">🎯 ${fmt(TARGETS[sku])}</span>`:""}
        ${l&&l[3]>0?`<span class="tag oferta">-$${(+l[3]).toFixed(2)}</span>`:""}
        ${l&&!l[2]?`<span class="tag agotado">agotado</span>`:""}
        ${l&&l[2]?saTag(sku):""}
        ${SHOP&&MYCLUB&&(D.clubs[sku]||{})[MYCLUB]&&!(D.clubs[sku][MYCLUB].in_stock)
          ?`<span class="tag agotado">📍 sin stock en ${MYCLUB}</span>`:""}</div>
      ${v.tip?`<div class="meta">${v.tip}</div>`:""}
      ${m&&l?`<div class="meta">pagaste $${(+m.paid).toFixed(2)}${m.date?" el "+m.date:""}
        → ${l[1]>=m.paid*100?"+":""}${Math.round((l[1]-m.paid*100)/(m.paid*100)*100)}% hoy
        ${nBuys>1?`· ${nBuys} compras`:""}</div>`:""}
      <div class="meta" style="margin-top:4px">${buySwitch(sku,nBuys>0)}
        ${nBuys>0?`<a class="plink" style="margin:0 0 0 10px;cursor:pointer"
        onclick="event.stopPropagation();comprar('${sku}')">+ otra</a>`:""}</div>
      <div style="margin-top:5px">${clubChips(sku)}</div>
      <div class="spark" data-sku="${sku}"></div></div></div>`;
}
function sparks(){
  document.querySelectorAll(".spark").forEach(el => {
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
