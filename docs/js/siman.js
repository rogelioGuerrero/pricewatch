// siman.js - radar Siman (VTEX): vigilias, silenciados, vistos
// y tarjetas de alerta. Sus ops de nube (mute/seen/watch)
// las usa tambien sync.js en el merge bidireccional.

// ---- Siman (VTEX): radar de ofertas reales por busqueda ----
// La vigilancia es por busqueda (marca/tipo); el itemId es efimero
// (Siman recodifica). 'no me gusta' y 'ya lo vi' usan reglas triples
// "pid|tkey|imghashes": el producto coincide por su id de producto, por
// titulo normalizado O por la FOTO (aHash 64b — Siman re-sube la imagen
// con asset id nuevo en cada recode, pero el contenido es identico).
// Reglas viejas: sin "|" = tkey plano; "pid|tkey" = v2 sin foto.
const SIMAN = D.siman || {items:[], events:[], watches:[]};
const tkeyJS = s => (s||"").toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g," ").trim();
const SMUTE = new Set(JSON.parse(localStorage.getItem("pw-siman-mute")||"[]"));
const SSEEN = JSON.parse(localStorage.getItem("pw-siman-seen")||"{}");
let SWATCH = JSON.parse(localStorage.getItem("pw-siman-watch")||"null")
  || SIMAN.watches || [];
const saveSMute = () =>
  localStorage.setItem("pw-siman-mute", JSON.stringify([...SMUTE]));
const saveSSeen = () =>
  localStorage.setItem("pw-siman-seen", JSON.stringify(SSEEN));
const saveSWatch = () =>
  localStorage.setItem("pw-siman-watch", JSON.stringify(SWATCH));
const sKey = p =>
  `${p.pid}|${tkeyJS(p.t)}|${(p.ihs||[]).join(",")}`;
// distancia hamming entre aHash hex de 64 bits — la misma foto re-subida
// difiere ~2 bits (re-encoding); fotos distintas andan >>10
const hDist = (a, b) => {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};
// regla "pid|tkey|h1,h2,..": matchea por CUALQUIERA de las tres —
// el pid cubre ediciones de titulo, el tkey cubre recodificados, y la
// foto cubre recodes con titulo renombrado (donde ambos cambian)
const ruleHit = (rule, p, tk) => {
  const pt = rule.split("|");
  if (pt.length < 2) return rule === tk;                    // legacy: tkey
  if (pt[0] === String(p.pid) || pt[1] === tk) return true; // v2: pid O tkey
  const hs = pt[2];
  return !!hs && (p.ihs || []).some(m =>
    hs.split(",").some(h => hDist(h, m) <= 8));
};
const isMuted = p => {
  const tk = tkeyJS(p.t);
  for (const r of SMUTE) if (ruleHit(r, p, tk)) return true;
  return false;
};
// mayor precio "visto" entre las reglas que matchean — reavisa solo si
// el precio actual queda por debajo de lo que ya reconociste
const seenAt = p => {
  const tk = tkeyJS(p.t);
  let best = null;
  for (const r in SSEEN)
    if (ruleHit(r, p, tk) && (best === null || SSEEN[r] > best))
      best = SSEEN[r];
  return best;
};
// migra reglas viejas (tkey plano) a la llave completa sKey() cuando el
// producto sigue en la data — quedan blindadas contra edicion de titulo
// y recodificado con renombre (via foto)
{
  const upg = r => {
    const pt = r.split("|");
    if (pt.length >= 3) return r;
    const p = pt.length === 2
      ? SIMAN.items.find(x => x.pid === pt[0] || tkeyJS(x.t) === pt[1])
      : SIMAN.items.find(x => tkeyJS(x.t) === r);
    return p ? sKey(p) : r;
  };
  let dirty = false;
  for (const r of [...SMUTE]) {
    const u = upg(r);
    if (u !== r) { SMUTE.delete(r); SMUTE.add(u); dirty = true; }
  }
  for (const r of Object.keys(SSEEN)) {
    const u = upg(r);
    if (u !== r) { SSEEN[u] = SSEEN[r]; delete SSEEN[r]; dirty = true; }
  }
  if (dirty) { saveSMute(); saveSSeen(); }
}
const h16 = s => { let h=5381;
  for (const c of s) h = (h*33 ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36); };
const muteUp = t => AW.dbs.createRow({databaseId:AW_DB,tableId:"siman_muted",
  rowId:`${AW.user.$id}-${h16(t)}`, data:{tkey:t},
  permissions:docPerms(AW.user.$id)}).catch(()=>{});
const muteDown = t => AW.dbs.deleteRow({databaseId:AW_DB,
  tableId:"siman_muted",
  rowId:`${AW.user.$id}-${h16(t)}`}).catch(()=>{});
const seenUp = (t,p) => {
  const rid = `${AW.user.$id}-${h16(t)}`;
  const data = {price:p, date:new Date().toISOString().slice(0,10)};
  AW.dbs.updateRow({databaseId:AW_DB, tableId:"siman_seen", rowId:rid, data})
    .catch(()=>AW.dbs.createRow({databaseId:AW_DB, tableId:"siman_seen",
      rowId:rid, data:{tkey:t,...data},
      permissions:docPerms(AW.user.$id)}).catch(()=>{}));
};
const watchUp = w => AW.dbs.createRow({databaseId:AW_DB,tableId:"siman_watch",
  rowId:`${AW.user.$id}-${h16(w.q+"|"+(w.talla||""))}`,
  data:{q:w.q, talla:w.talla||"", filtro:(w.solo||[]).join(",")},
  permissions:docPerms(AW.user.$id)}).catch(()=>{});
const watchDown = (q,t) => AW.dbs.deleteRow({databaseId:AW_DB,
  tableId:"siman_watch",
  rowId:`${AW.user.$id}-${h16(q+"|"+(t||""))}`}).catch(()=>{});
const yaLoVi = (rule,p) => {
  SSEEN[rule] = p; saveSSeen();
  if (AW.user) seenUp(rule, p);
  render();
};
const noMeGusta = rule => {
  SMUTE.add(rule); saveSMute();
  if (AW.user) muteUp(rule);
  render();
};
const simanAlerts = () => SIMAN.items.filter(p => {
  if (!p.avail || !(p.broke || p.decl) || (p.ta && !p.ok)) return false;
  if (isMuted(p)) return false;
  const sp = seenAt(p);
  return !(sp != null && p.p != null && p.p >= sp);
});
// orden de los grupos del acordeon (persiste) y cuales estan abiertos
let SSORT = localStorage.getItem("pw-siman-sort") || "count";
const ACC_OPEN = {};
// sugerencias del buscador: terminos reales de los titulos vigilados
const SSTOP = new Set(("para del la el con sin en un una por color hombre "
  + "mujer caballero dama unisex pack set los las y al de es s l m xl xxl")
  .split(" "));
const STERM = (() => {
  const uni = {}, bi = {};
  for (const p of SIMAN.items) {
    const toks = tkeyJS(p.t).split(" ")
      .filter(x => x.length > 2 && !SSTOP.has(x));
    toks.forEach(x => uni[x] = (uni[x]||0) + 1);
    for (let i = 0; i < toks.length - 1; i++) {
      const b = toks[i] + " " + toks[i+1]; bi[b] = (bi[b]||0) + 1; }
  }
  const out = [];
  for (const [t,n] of Object.entries(uni)) if (n >= 3) out.push([t,n]);
  for (const [t,n] of Object.entries(bi)) if (n >= 2) out.push([t,n]);
  return out;
})();
// descuento declarado como fraccion (0 si no hay o lp no supera al precio)
const sDisc = p => (p.lp && p.p && p.lp > p.p) ? 1 - p.p/p.lp : 0;
function sCard(p){
  const tk = tkeyJS(p.t), tags = [];
  if (p.broke) tags.push(`<span class="tag real">mín histórico</span>`);
  // el descuento declarado ya lo dice el precio tachado; -N% lo cuantifica
  const disc = Math.round(sDisc(p)*100);
  if (disc) tags.push(`<span class="tag oferta">-${disc}%</span>`);
  if (p.crd) tags.push(`<span class="tag oferta">con CrediSiman</span>`);
  if (p.ta) tags.push(`<span class="tag ${p.ok?"nuevo":"agotado"}">talla ${esc(p.ta)} ${p.ok?"✓":"✗"}</span>`);
  return `<div class="card" ${p.l?`data-l="${esc(p.l)}"
    onclick="window.open(this.dataset.l,'_blank','noopener')"`:''}>
    ${p.l?`<span class="slink">↗</span>`:""}
    ${p.img?`<img src="${p.img}" loading="lazy" onerror="this.remove()">`:""}
    <div style="flex:1;min-width:0">
      <div class="t">${esc(p.t)}</div>
      <div><span class="pr">${p.p!=null?fmt(Math.round(p.p*100)):"—"}</span>
        ${p.lp&&p.p&&p.lp>p.p?` <span class="old">${fmt(Math.round(p.lp*100))}</span>`:""}
        ${tags.join("")}</div>
      <div class="meta">${p.b?esc(p.b)+" · ":""}vigilado por "${esc(p.w||"")}"${p.n>1?` · ${p.n} obs`:""}</div>
      <div class="sact">
        <a class="sic" title="ya lo vi — reavisa si baja más"
           onclick="event.stopPropagation();yaLoVi('${p.pid}|${tk}|${(p.ihs||[]).join(",")}',${p.p||0})">👁</a>
        <a class="sic neg" title="no me gusta — no volver a mostrar (restaurable en ▸)"
           onclick="event.stopPropagation();noMeGusta('${p.pid}|${tk}|${(p.ihs||[]).join(",")}')">👎</a>
      </div></div></div>`;
}

// ---- handlers del panel Siman ----
// siman: alta/baja de busquedas vigiladas (si hay sesion, sube a la nube
// y el sweep la usa en la proxima corrida)
$("#sw-add").onclick = () => {
  const q = $("#sw-q").value.trim();
  if (!q) return;
  const w = {q: q.toLowerCase()};
  const t = $("#sw-t").value.trim();
  if (t) w.talla = t;
  if (SWATCH.some(x => x.q === w.q && (x.talla||"") === (w.talla||""))) {
    $("#sw-q").value = ""; $("#sw-t").value = ""; return; }
  SWATCH.push(w); saveSWatch();
  if (AW.user) watchUp(w);
  $("#sw-q").value = ""; $("#sw-t").value = "";
  render();
};
$("#siman-watches").onclick = e => {
  const a = e.target.closest("a[data-wq]");
  if (!a) return;
  const [q, t] = a.dataset.wq.split("|");
  SWATCH = SWATCH.filter(w => !(w.q === q && (w.talla||"") === (t||"")));
  saveSWatch();
  if (AW.user) watchDown(q, t);
  render();
};
// sugerencias del buscador de vigilancia: solo terminos que existen en
// la data; si no hay match, se avisa que el termino es nuevo
$("#sw-q").addEventListener("input", () => {
  const q = tkeyJS($("#sw-q").value), box = $("#sw-sug");
  if (q.length < 2) { box.style.display = "none"; return; }
  const hits = STERM.filter(([t]) =>
      t.split(" ").some(w => w.startsWith(q)) || t.startsWith(q))
    .sort((a,b) => b[1] - a[1]).slice(0, 8);
  box.innerHTML = hits.map(([t,n]) =>
      `<div class="s" data-q="${t}"><span>${t}</span><small>${n} productos</small></div>`).join("")
    + `<div class="s" data-q="${q}"><span>vigilar "${esc(q)}"</span>`
    + `<small>${hits.length ? "" : "término nuevo — se verifica mañana"}</small></div>`;
  box.style.display = "block";
});
$("#sw-sug").onclick = e => {
  const s = e.target.closest(".s");
  if (!s) return;
  $("#sw-q").value = s.dataset.q;
  $("#sw-sug").style.display = "none";
};
document.addEventListener("click", e => {
  if (!e.target.closest("#sw-sug") && e.target.id !== "sw-q")
    $("#sw-sug").style.display = "none";
});
$("#siman-tog").onclick = () => {
  const w = $("#siman-panel"), open = w.style.display !== "none";
  w.style.display = open ? "none" : "";
  $("#siman-tog").textContent = open ? "▸" : "▾";
};
// restaurar un silenciado: sale de SMUTE y baja el doc de la nube
$("#siman-muted").onclick = e => {
  const a = e.target.closest("a[data-mu]");
  if (!a) return;
  SMUTE.delete(a.dataset.mu); saveSMute();
  if (AW.user) muteDown(a.dataset.mu);
  render();
};
// orden de los acordeones de Siman
$("#siman-sort").onclick = e => {
  const c = e.target.closest("[data-ss]");
  if (!c) return;
  SSORT = c.dataset.ss;
  localStorage.setItem("pw-siman-sort", SSORT);
  render();
};
