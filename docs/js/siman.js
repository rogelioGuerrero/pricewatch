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
const SMUTE = new Set(
  PWStore.read("pw-siman-mute", [], PWStore.valid.strList));
const SSEEN = PWStore.read("pw-siman-seen", {}, PWStore.valid.numMap);
// watches = estado del namespace (guest o cuenta): el dataset publico
// (D.siman.watches) jamas siembra estado — solo se migra el valor
// legacy local via PWStore. Sembrar subia queries del dataset a una
// cuenta nueva como si fueran suyas
let SWATCH = PWStore.read("pw-siman-watch", [], PWStore.valid.watch);
const saveSMute = () => PWStore.write("pw-siman-mute", [...SMUTE]);
const saveSSeen = () => PWStore.write("pw-siman-seen", SSEEN);
const saveSWatch = () => PWStore.write("pw-siman-watch", SWATCH);
const sKey = p =>
  `${p.pid}|${tkeyJS(p.t)}|${(p.ihs||[]).join(",")}`;
// distancia hamming entre aHash hex de 64 bits — la misma foto re-subida
// difiere ~2 bits (re-encoding); fotos distintas andan >>10
const hDist = (a, b) => {
  // hash corrupto (regla editada, data rara) nunca llega a BigInt:
  // 99 = "no parecido" en vez de un throw que tumba isMuted/seenAt
  try {
    a = String(a || ""); b = String(b || "");
    if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b))
      return 99;
    let x = BigInt("0x" + a) ^ BigInt("0x" + b), n = 0;
    while (x) { n += Number(x & 1n); x >>= 1n; }
    return n;
  } catch (_) { return 99; }
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
// reglas viejas reemplazadas por la migracion de abajo: syncAll() las
// borra de la nube para no acumular filas obsoletas en siman_muted/seen
const SUPG_MUTE = [], SUPG_SEEN = [];
// migra reglas viejas (tkey plano) a la llave completa sKey() cuando el
// producto sigue en la data — quedan blindadas contra edicion de titulo
// y recodificado con renombre (via foto). Corre al eval y al rehidratar
// otro namespace: las colas SUPG siempre pertenecen al usuario activo
const upgradeSimanRules = () => {
  SUPG_MUTE.length = 0; SUPG_SEEN.length = 0;
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
    if (u !== r) { SMUTE.delete(r); SMUTE.add(u);
      SUPG_MUTE.push(r); dirty = true; }
  }
  for (const r of Object.keys(SSEEN)) {
    const u = upg(r);
    if (u !== r) { SSEEN[u] = SSEEN[r]; delete SSEEN[r];
      SUPG_SEEN.push(r); dirty = true; }
  }
  if (dirty) { saveSMute(); saveSSeen(); }
};
upgradeSimanRules();
const h16 = s => { let h=5381;
  for (const c of s) h = (h*33 ^ c.charCodeAt(0)) >>> 0;
  return h.toString(36); };
// las ops de nube pasan por el outbox durable de sync.js: intencion
// persistida antes del request, coalesce por fila, reintento con el
// mismo op.id. Resuelven true solo si el cambio quedo confirmado
const muteUp = t => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "siman_muted",
    rowId: `${boundUid()}-${h16(t)}`, kind: "create", key: t,
    data: { tkey: t } });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
const muteDown = t => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "siman_muted",
    rowId: `${boundUid()}-${h16(t)}`, kind: "delete", key: t });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
const seenUp = (t, p) => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "siman_seen",
    rowId: `${boundUid()}-${h16(t)}`, kind: "upsert", key: t,
    data: { tkey: t, price: p, date: todaySV() } });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
const seenDown = t => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "siman_seen",
    rowId: `${boundUid()}-${h16(t)}`, kind: "delete", key: t });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
// upsert (no create): la fila es singleton por q|talla — un 409 o una
// fila previa del otro dispositivo lleva el filtro local deseado con
// update en vez de confirmar a ciegas
const watchUp = w => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "siman_watch",
    rowId: `${boundUid()}-${h16(w.q + "|" + (w.talla || ""))}`,
    kind: "upsert", key: w.q + "|" + (w.talla || ""),
    data: { q: w.q, talla: w.talla || "",
            filtro: (w.solo || []).join(",") } });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
const watchDown = (q, t) => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "siman_watch",
    rowId: `${boundUid()}-${h16(q + "|" + (t || ""))}`,
    kind: "delete", key: q + "|" + (t || "") });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
const yaLoVi = (rule,p) => {
  SSEEN[rule] = p; saveSSeen();
  if (PWStore.currentUser()) seenUp(rule, p);
  render();
};
const noMeGusta = rule => {
  SMUTE.add(rule); saveSMute();
  if (PWStore.currentUser()) muteUp(rule);
  render();
  // deshacer: restaura la regla (el delete coalesca contra el create
  // pendiente si aun no salia el request)
  undoToast("alerta silenciada", () => {
    SMUTE.delete(rule); saveSMute();
    if (PWStore.currentUser()) muteDown(rule);
    render();
  });
};
// alertas: solo variantes verificadas vigentes (PWData.siman compara
// la observacion contra la fecha fuente del barrido — una lectura
// vieja nunca proclama ganga). rompe-minimo o declara-descuento,
// disponible (o talla pedida disponible), no silenciado, y por
// debajo del ultimo precio reconocido
const simanAlerts = () => SIMAN.items.filter(p => {
  const observation = PWData.siman(p);
  if (observation.state !== "available" || observation.priceCents == null)
    return false;
  if (!(p.broke || p.decl)) return false;
  if (isMuted(p)) return false;
  const sp = seenAt(p);
  return !(sp != null && p.p != null && p.p >= sp);
});
// orden de los grupos del acordeon (persiste) y cuales estan abiertos
let SSORT = PWStore.get("pw-siman-sort") || "count";
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
  const tags = [];
  if (p.broke) tags.push(`<span class="tag real">mín histórico</span>`);
  // el descuento declarado ya lo dice el precio tachado; -N% lo cuantifica
  const disc = Math.round(sDisc(p)*100);
  if (disc) tags.push(`<span class="tag oferta">-${disc}%</span>`);
  if (p.crd) tags.push(`<span class="tag oferta">con CrediSiman</span>`);
  if (p.ta) tags.push(`<span class="tag ${p.ok?"nuevo":"agotado"}">talla ${esc(p.ta)} ${p.ok?"✓":"✗"}</span>`);
  // el link externo solo si es http(s) de verdad: el payload es de
  // terceros y un javascript:/data: ejecutaria codigo al hacer click.
  // Va como anchor normal (nada de onclick sobre la card entera) y
  // las acciones son botones nativos etiquetados
  const link = safeHttpURL(p.l || "");
  return `<article class="card">
    ${link?`<a class="slink" href="${esc(link)}" target="_blank"
      rel="noopener" aria-label="ver ${esc(p.t)} en Siman">↗</a>`:""}
    ${p.img?`<img src="${esc(p.img)}" alt="" loading="lazy" onerror="this.remove()">`:""}
    <div style="flex:1;min-width:0">
      <h3 class="t">${link
        ?`<a href="${esc(link)}" target="_blank" rel="noopener"
            style="color:inherit;text-decoration:none">${esc(p.t)}</a>`
        :esc(p.t)}</h3>
      <div><span class="pr">${p.p!=null?fmt(Math.round(p.p*100)):"—"}</span>
        ${p.lp&&p.p&&p.lp>p.p?` <span class="old">${fmt(Math.round(p.lp*100))}</span>`:""}
        ${tags.join("")}</div>
      <div class="meta">${p.b?esc(p.b)+" · ":""}vigilado por "${esc(p.w||"")}"${p.n>1?` · ${p.n} obs`:""}${p.last?` · ${p.last}`:""}</div>
      <div class="sact">
        <button type="button" class="sbtn"
           data-sv="seen" data-rule="${esc(sKey(p))}"
           data-price="${p.p||0}">👁 ya lo vi — reavisa si baja</button>
        <button type="button" class="sbtn neg"
           data-sv="mute" data-rule="${esc(sKey(p))}">👎 no me gusta</button>
      </div></div></article>`;
}
// acciones de las cards Siman por delegacion
$("#g-siman").addEventListener("click", e => {
  const a = e.target.closest("[data-sv]");
  if (!a) return;
  if (a.dataset.sv === "seen") yaLoVi(a.dataset.rule, +a.dataset.price);
  else noMeGusta(a.dataset.rule);
});

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
  if (PWStore.currentUser()) watchUp(w);
  $("#sw-q").value = ""; $("#sw-t").value = "";
  render();
};
$("#siman-watches").onclick = e => {
  const a = e.target.closest("[data-wq]");
  if (!a) return;
  // split por el ULTIMO "|": la busqueda del usuario puede traer "|"
  const i = a.dataset.wq.lastIndexOf("|");
  const q = a.dataset.wq.slice(0, i), t = a.dataset.wq.slice(i + 1);
  SWATCH = SWATCH.filter(w => !(w.q === q && (w.talla||"") === (t||"")));
  saveSWatch();
  if (PWStore.currentUser()) watchDown(q, t);
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
// Enter en busqueda o talla = clic en "+ vigilar"
for (const el of ["#sw-q", "#sw-t"])
  $(el).addEventListener("keydown", e => {
    if (e.key === "Enter") {
      $("#sw-sug").style.display = "none";
      $("#sw-add").click();
    }
  });
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
  const a = e.target.closest("[data-mu]");
  if (!a) return;
  SMUTE.delete(a.dataset.mu); saveSMute();
  if (PWStore.currentUser()) muteDown(a.dataset.mu);
  render();
};
// orden de los acordeones de Siman
$("#siman-sort").onclick = e => {
  const c = e.target.closest("[data-ss]");
  if (!c) return;
  SSORT = c.dataset.ss;
  PWStore.set("pw-siman-sort", SSORT);
  render();
};
