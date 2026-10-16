// sync.js - Appwrite: auth, filas y merge bidireccional con
// localStorage (favs, compras, watches, mutes, seen, targets).

// ---- sync Appwrite: favs + compras entre dispositivos (opcional) ----
const AW = {ok:false, user:null};
try {
  const c = new Appwrite.Client()
    .setEndpoint("https://sfo.cloud.appwrite.io/v1")
    .setProject("6ab1922d00020f5a2e99");
  AW.acc = new Appwrite.Account(c);
  AW.dbs = new Appwrite.TablesDB(c);
  AW.ok = true;
} catch(e) {}
const AW_DB = "pricewatch", COL_F = "favs", COL_C = "compras";
const docPerms = uid => ["read","update","delete"]
  .map(p => Appwrite.Permission[p](Appwrite.Role.user(uid)));
const favId = sku => `${AW.user.$id}-${sku}`;
const listAll = tableId => AW.dbs
  .listRows({databaseId: AW_DB, tableId,
             queries: [Appwrite.Query.limit(500)]})
  .then(r => r.rows);
const favUp = sku => AW.dbs.createRow({databaseId: AW_DB, tableId: COL_F,
  rowId: favId(sku), data: {sku}, permissions: docPerms(AW.user.$id)})
  .then(() => true).catch(() => false);
const favDown = sku => AW.dbs.deleteRow({databaseId: AW_DB, tableId: COL_F,
  rowId: favId(sku)}).catch(()=>{});
const compraUp = c => AW.dbs.createRow({databaseId: AW_DB, tableId: COL_C,
  rowId: Appwrite.ID.unique(),
  data: {sku:c.sku, paid:c.paid, date:c.date||"1970-01-01"},
  permissions: docPerms(AW.user.$id)});
const compraDown = rid => AW.dbs.deleteRow({databaseId: AW_DB, tableId: COL_C,
  rowId: rid}).catch(()=>{});
const ckey = c => `${c.sku}|${c.date||""}|${c.paid}`;
// precios objetivo: row id = <userId>-<sku>, un target por producto
const tgtSet = (sku,t) => {
  const rid = `${AW.user.$id}-${sku}`;
  return AW.dbs.updateRow({databaseId:AW_DB, tableId:"targets", rowId:rid,
    data:{sku, target:t}})
    .then(() => true)
    .catch(() => AW.dbs.createRow({databaseId:AW_DB, tableId:"targets",
      rowId:rid, data:{sku, target:t},
      permissions:docPerms(AW.user.$id)})
      .then(() => true).catch(() => false));
};
const tgtDel = sku => AW.dbs.deleteRow({databaseId:AW_DB,
  tableId:"targets", rowId:`${AW.user.$id}-${sku}`}).catch(()=>{});
// snapshot de llaves confirmadas en la nube en el ultimo syncAll:
// local - snap = agregado aqui (subir); snap - remoto = borrado alla
// (bajar, no resucitar). Sin el, la union aditiva re-subia lo borrado
// en otro dispositivo
const snapJ = JSON.parse(localStorage.getItem("pw-sync-snap") || "{}");
const saveSyncSnap = () =>
  localStorage.setItem("pw-sync-snap", JSON.stringify(snapJ));
// patron por coleccion: snap = llaves que la nube confirmo; bajar
// deletes locales pendientes, podar deletes remotos, subir altas
// confirmadas (las que fallan quedan fuera del snap y reintentan)
async function syncAll(){
  if (!AW.user) return;
  const [rf, rc] = await Promise.all([listAll(COL_F), listAll(COL_C)]);
  // ---- favs ----
  const rset = new Set(rf.map(d=>d.sku));
  {
    const snap = new Set(snapJ.favs || []);
    const pend = [...snap].filter(s => !FAV.has(s) && rset.has(s));
    await Promise.all(pend.map(favDown));      // borrado aqui sin sesion
    for (const s of snap)
      if (!rset.has(s)) FAV.delete(s);         // borrado remoto
    const up = await Promise.all([...FAV].filter(s => !rset.has(s))
      .map(s => favUp(s).then(ok => ok && s)));
    for (const d of rf)
      if (!pend.includes(d.sku)) FAV.add(d.sku);
    snapJ.favs = [...rset, ...up.filter(Boolean)]
      .filter(s => !pend.includes(s));
  }
  // ---- compras: fila con rid que ya no existe = borrada en otro
  // dispositivo -> fuera de local, no re-subir. Solo las sin rid son
  // altas pendientes de compraUp ----
  const rmap = {};
  rc.forEach(d => { rmap[ckey(d)] = d.$id; });
  {
    const snap = new Set(snapJ.compras || []);
    const localK = new Set(COMPRAS.map(ckey));
    const pend = [...snap].filter(k => !localK.has(k) && rmap[k]);
    await Promise.all(pend.map(k => compraDown(rmap[k])));
    for (let i = COMPRAS.length - 1; i >= 0; i--) {
      const c = COMPRAS[i], k = ckey(c);
      if (rmap[k]) { c.rid = rmap[k]; continue; }
      if (c.rid || snap.has(k)) COMPRAS.splice(i, 1);   // borrada remota
    }
    const up = await Promise.all(COMPRAS.filter(c => !c.rid)
      .map(c => compraUp(c).then(d => { c.rid = d.$id; return ckey(c); })
                           .catch(() => null)));
    for (const d of rc)
      if (!COMPRAS.some(c => ckey(c) === ckey(d)))
        COMPRAS.push({sku:d.sku, paid:d.paid, date:d.date, rid:d.$id});
    snapJ.compras = [...Object.keys(rmap), ...up.filter(Boolean)]
      .filter(k => !pend.includes(k));
  }
  // ---- siman + targets: misma reconciliacion por coleccion; si la
  // tabla no existe o Appwrite esta caido, listAll falla: no subir ni
  // borrar nada ahi (cada request pegaria 404 y el snapshot confundiria
  // "no listo" con "borrado remoto") ----
  const tryList = t => listAll(t).then(r => ({r, ok:true}))
                                 .catch(() => ({r:[], ok:false}));
  const [Rw, Rm, Rs, Rt] = await Promise.all(
    [tryList("siman_watch"), tryList("siman_muted"), tryList("siman_seen"),
     tryList("targets")]);
  const rw = Rw.r, rm = Rm.r, rs = Rs.r, rt = Rt.r;
  const wKey = w => w.q + "|" + (w.talla || "");
  if (Rw.ok) {
    const rwSet = new Set(rw.map(wKey));
    const snap = new Set(snapJ.watch || []);
    const localK = new Set(SWATCH.map(wKey));
    const pend = [...snap].filter(k => !localK.has(k) && rwSet.has(k));
    await Promise.all(pend.map(k => {
      const i = k.lastIndexOf("|");   // la busqueda puede traer "|"
      return watchDown(k.slice(0, i), k.slice(i + 1));
    }));
    for (const k of snap) if (!rwSet.has(k))
      SWATCH = SWATCH.filter(w => wKey(w) !== k);     // borrado remoto
    const up = await Promise.all(SWATCH.filter(w => !rwSet.has(wKey(w)))
      .map(w => watchUp(w).then(ok => ok && wKey(w))));
    for (const d of rw) {
      const w = {q: d.q, talla: d.talla || undefined,
        solo: d.filtro ? d.filtro.split(",").filter(Boolean) : undefined};
      const k = wKey(w);
      if (!pend.includes(k) && !SWATCH.some(x => wKey(x) === k))
        SWATCH.push(w);
    }
    snapJ.watch = [...rwSet, ...up.filter(Boolean)]
      .filter(k => !pend.includes(k));
  }
  if (Rm.ok) {
    const rmSet = new Set(rm.map(d => d.tkey));
    const snap = new Set(snapJ.mute || []);
    const pend = [...snap].filter(t => !SMUTE.has(t) && rmSet.has(t));
    await Promise.all(pend.map(muteDown));
    for (const t of snap) if (!rmSet.has(t)) SMUTE.delete(t);
    const up = await Promise.all([...SMUTE].filter(t => !rmSet.has(t))
      .map(t => muteUp(t).then(ok => ok && t)));
    rm.forEach(d => { if (!pend.includes(d.tkey)) SMUTE.add(d.tkey); });
    // reglas migradas (tkey plano -> pid|tkey|ihs): borrar las filas
    // viejas para no acumular basura hacia el cap de 500
    SUPG_MUTE.forEach(muteDown); SUPG_MUTE.length = 0;
    snapJ.mute = [...rmSet, ...up.filter(Boolean)]
      .filter(t => !pend.includes(t));
  }
  if (Rs.ok) {
    const rsSet = new Set(rs.map(d => d.tkey));
    const snap = new Set(snapJ.seen || []);
    const pend = [...snap].filter(t => !(t in SSEEN) && rsSet.has(t));
    await Promise.all(pend.map(seenDown));
    for (const t of snap) if (!rsSet.has(t)) delete SSEEN[t];
    const up = await Promise.all(Object.keys(SSEEN)
      .filter(t => !rsSet.has(t))
      .map(t => seenUp(t, SSEEN[t]).then(ok => ok && t)));
    // la nube baja reglas nuevas; si el precio difiere gana el MAYOR —
    // reavisa solo si baja de lo que ya reconociste en cualquier equipo
    rs.forEach(d => {
      if (!pend.includes(d.tkey))
        SSEEN[d.tkey] = Math.max(SSEEN[d.tkey] ?? 0, d.price);
    });
    SUPG_SEEN.forEach(seenDown); SUPG_SEEN.length = 0;
    snapJ.seen = [...rsSet, ...up.filter(Boolean)]
      .filter(t => !pend.includes(t));
  }
  // ---- targets: la nube gana si el valor difiere ----
  if (Rt.ok) {
    const rtSet = {};
    rt.forEach(d => { if (d.sku && d.target) rtSet[d.sku] = d.target; });
    const snap = new Set(snapJ.targets || []);
    const pend = [...snap].filter(s => !(s in TARGETS) && (s in rtSet));
    await Promise.all(pend.map(tgtDel));
    for (const s of snap) if (!(s in rtSet)) delete TARGETS[s];
    const up = await Promise.all(Object.keys(TARGETS)
      .filter(s => !(s in rtSet))
      .map(s => tgtSet(s, TARGETS[s]).then(ok => ok && s)));
    for (const [s, t] of Object.entries(rtSet))
      if (!pend.includes(s)) TARGETS[s] = t;
    snapJ.targets = [...Object.keys(rtSet), ...up.filter(Boolean)]
      .filter(s => !pend.includes(s));
  }
  saveSyncSnap();
  localStorage.setItem("pw-targets", JSON.stringify(TARGETS));
  saveSMute(); saveSSeen(); saveSWatch();
  localStorage.setItem("pw-favs", JSON.stringify([...FAV]));
  localStorage.setItem("pw-compras", JSON.stringify(COMPRAS));
  rebuildPaid(); render();
}
const lgDlg = document.getElementById("dlg-login");
const acctBtn = document.getElementById("acct");
const lgMsg = t => document.getElementById("lg-msg").textContent = t;
function paintAcct(){
  if (!AW.ok) return;
  acctBtn.style.display = "";
  acctBtn.textContent = AW.user ? "☁ " + AW.user.email : "cuenta";
  document.getElementById("lg-form").style.display = AW.user ? "none" : "";
  document.getElementById("lg-out").style.display = AW.user ? "" : "none";
  if (AW.user)
    document.getElementById("lg-who").textContent =
      AW.user.email + " — sincronizado";
}
acctBtn.onclick = () => {
  lgMsg(""); paintAcct(); lgDlg.showModal();
  // los inputs de login solo existen para Chrome mientras el dialogo esta
  // abierto: con el password disabled el parser no detecta contexto de
  // login y no sugiere correos en el buscador
  lgDlg.querySelectorAll("input").forEach(i => i.disabled = false);
};
lgDlg.addEventListener("close", () =>
  lgDlg.querySelectorAll("input").forEach(i => i.disabled = true));
document.getElementById("lg-in").onclick = () => doAuth(false);
document.getElementById("lg-up").onclick = () => doAuth(true);
document.getElementById("lg-off").onclick = async () => {
  await AW.acc.deleteSession("current").catch(()=>{});
  AW.user = null; paintAcct();
  lgMsg("sesión cerrada — los datos quedan en este dispositivo");
};
async function doAuth(reg){
  const em = document.getElementById("lg-email").value.trim(),
        pw = document.getElementById("lg-pass").value;
  if (!em || !pw) return lgMsg("falta correo o contraseña");
  lgMsg("…");
  try {
    if (reg) await AW.acc.create({userId: Appwrite.ID.unique(),
                                  email: em, password: pw});
    try { await AW.acc.deleteSession("current"); } catch(e) {}
    await AW.acc.createEmailPasswordSession({email: em, password: pw});
    AW.user = await AW.acc.get();
    lgMsg("sincronizando…");
    await syncAll();
    lgDlg.close();
  } catch(e) {
    lgMsg(e.code === 401 ? "correo o contraseña incorrectos"
                         : String(e.message||"error").slice(0,140));
  }
}
