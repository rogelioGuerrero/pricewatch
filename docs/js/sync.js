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
  .catch(()=>{});
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
  AW.dbs.updateRow({databaseId:AW_DB, tableId:"targets", rowId:rid,
    data:{sku, target:t}})
    .catch(()=>AW.dbs.createRow({databaseId:AW_DB, tableId:"targets",
      rowId:rid, data:{sku, target:t},
      permissions:docPerms(AW.user.$id)}).catch(()=>{}));
};
const tgtDel = sku => AW.dbs.deleteRow({databaseId:AW_DB,
  tableId:"targets", rowId:`${AW.user.$id}-${sku}`}).catch(()=>{});
async function syncAll(){
  if (!AW.user) return;
  // la semilla del repo (mis-compras.json) se migra a la cuenta la 1a vez
  for (const m of (D.mis||[]))
    if (!COMPRAS.some(c => c.sku===m.sku && c.date===m.date && c.paid===m.paid))
      COMPRAS.push({sku:String(m.sku), paid:m.paid, date:m.date});
  const [rf, rc] = await Promise.all([listAll(COL_F), listAll(COL_C)]);
  const rset = new Set(rf.map(d=>d.sku));
  for (const s of [...FAV]) if (!rset.has(s)) await favUp(s);
  for (const d of rf) FAV.add(d.sku);
  const rmap = {}; rc.forEach(d => rmap[ckey(d)] = d.$id);
  for (const c of COMPRAS) {
    const k = ckey(c);
    if (rmap[k]) c.rid = rmap[k];
    else { const d = await compraUp(c).catch(()=>null); if (d) c.rid = d.$id; }
  }
  for (const d of rc)
    if (!COMPRAS.some(c => ckey(c) === ckey(d)))
      COMPRAS.push({sku:d.sku, paid:d.paid, date:d.date, rid:d.$id});
  // siman: union bidireccional — baja lo de la nube y sube lo que solo
  // existe local (mutes/vistos/watches hechos sin sesion no se pierden
  // al entrar desde otro dispositivo)
  const tryList = t => listAll(t).then(r => ({r, ok:true}))
                                 .catch(() => ({r:[], ok:false}));
  const [Rw, Rm, Rs, Rt] = await Promise.all(
    [tryList("siman_watch"), tryList("siman_muted"), tryList("siman_seen"),
     tryList("targets")]);
  // si la tabla no existe o Appwrite esta caido, listAll falla: no subir
  // nada ahi — cada POST pegaria 404 y llenaria la consola de errores
  const rw = Rw.r, rm = Rm.r, rs = Rs.r, rt = Rt.r;
  const wKey = w => w.q + "|" + (w.talla || "");
  const rwSet = new Set(rw.map(wKey));
  for (const d of rw) {
    const w = {q: d.q, talla: d.talla || undefined,
      solo: d.filtro ? d.filtro.split(",").filter(Boolean) : undefined};
    if (!SWATCH.some(x => wKey(x) === wKey(w))) SWATCH.push(w);
  }
  if (Rw.ok)
    for (const w of SWATCH) if (!rwSet.has(wKey(w))) await watchUp(w);
  rm.forEach(d => SMUTE.add(d.tkey));
  rs.forEach(d => { SSEEN[d.tkey] = d.price; });
  const rmSet = new Set(rm.map(d => d.tkey));
  if (Rm.ok)
    for (const t of SMUTE) if (!rmSet.has(t)) await muteUp(t);
  const rsSet = new Set(rs.map(d => d.tkey));
  if (Rs.ok)
    for (const [t, p] of Object.entries(SSEEN))
      if (!rsSet.has(t)) await seenUp(t, p);
  // targets: union como favs — baja los de la nube y sube los que solo
  // existen local (fijados sin sesion). La nube gana si difieren.
  const rtSet = {};
  rt.forEach(d => { if (d.sku && d.target) rtSet[d.sku] = d.target; });
  const localT = {...TARGETS};
  for (const [s, t] of Object.entries(rtSet)) TARGETS[s] = t;
  if (Rt.ok)
    for (const [s, t] of Object.entries(localT))
      if (!(s in rtSet)) await tgtSet(s, t);
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
