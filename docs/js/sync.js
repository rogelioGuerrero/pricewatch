// sync.js - Appwrite: auth, outbox durable de mutaciones y merge
// bidireccional (favs, compras, watches, mutes, seen, targets) por
// namespace de cuenta via PWStore.

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
// permisos por fila para el dueno LIGADO (PWStore.currentUser). Se
// computan al ejecutar el request — jamas sintaxis cruda ni un SDK
// que no esta cargado (offline)
const docPerms = uid => {
  if (!uid) return undefined;
  try { return ["read","update","delete"]
    .map(p => Appwrite.Permission[p](Appwrite.Role.user(uid))); }
  catch (_) { return undefined; }
};
// el dueno de una mutacion local es el namespace ligado, no la sesion
// viva: offline con hint del ultimo uid, la intencion se encola para
// ESA cuenta y espera a que vuelva a autenticarse
const boundUid = () => PWStore.currentUser();
const favId = sku => `${boundUid()}-${sku}`;
// Appwrite corta en 500 filas por request: paginar por cursor sobre el
// orden estable de $id hasta una pagina corta. Si el cursor no avanza
// la API esta ignorando cursorAfter — lanzar en vez de devolver una
// lista muda: el merge la leeria como "borrado remoto" y vaciaria local
// live: fn opcional () => bool — cuando se pasa, cada pagina se pide
// solo si el dueno/epoch capturado sigue vigente; si cambio, devuelve
// null (lectura obsoleta) y NO pide la pagina siguiente
const listAll = async (tableId, live) => {
  const rows = [];
  let cursor = null;
  for (;;) {
    if (live && !live()) return null;
    const queries = [Appwrite.Query.limit(500),
                     Appwrite.Query.orderAsc("$id")];
    if (cursor) queries.push(Appwrite.Query.cursorAfter(cursor));
    const page = (await AW.dbs.listRows({databaseId: AW_DB, tableId,
                                         queries})).rows;
    if (live && !live()) return null;   // pagina obsoleta: descartar
    if (!page.length) return rows;
    const last = page[page.length - 1].$id;
    if (!last || last === cursor)
      throw new Error("listAll: cursor sin avance en " + tableId);
    rows.push(...page);
    if (page.length < 500) return rows;
    cursor = last;
  }
};
const ckey = c => `${c.sku}|${c.date||""}|${c.paid}`;

// ---- baseline confirmado + outbox durable ----
// snapJ[coll] = llaves que la nube CONFIRMO tener: local - snap =
// agregado aqui (subir); snap - remoto = borrado alla (bajar, no
// resucitar). Nunca registra exitos supuestos: una op solo entra al
// snap cuando su request se confirmo (o era un 404/409 equivalente).
const snapJ = PWStore.read("pw-sync-snap", {}, PWStore.valid.snap);
const saveSyncSnap = () => PWStore.write("pw-sync-snap", snapJ);
// OUTBOX = intenciones locales no confirmadas. Sobrevive recargas y
// cambios de pagina; cada op lleva {id,uid,tableId,rowId,kind,data,
// permissions,key,createdAt,attempts} — el id es estable entre
// reintentos y el uid fija el dueno de la intencion.
const OUTBOX = PWStore.read("pw-outbox", [], PWStore.valid.outbox);
const saveOutbox = () => PWStore.write("pw-outbox", OUTBOX);
const SYNC = { state: "local", err: "" };
let _opSeq = 0;
const opId = () => "op-" + Date.now().toString(36) + "-" + (++_opSeq);
const SNAP_COLL = { favs: "favs", compras: "compras",
  siman_watch: "watch", siman_muted: "mute",
  siman_seen: "seen", targets: "targets" };
// ops pendientes por tabla (kind opcional) — el merge los usa para no
// reimportar lo que ya esta muerto en intencion y no pisar updates.
// Incluye key Y rowId: ops viejas de compras llevaron el tuple en
// key mientras la llave remota es el rid — por rowId tambien matchean
const opPending = (tableId, kind) => {
  const s = new Set();
  for (const o of OUTBOX)
    if (o.tableId === tableId && (!kind || o.kind === kind)) {
      if (o.key != null) s.add(o.key);
      if (o.rowId != null) s.add(o.rowId);
    }
  return s;
};
// coalesce por fila logica (tableId+rowId): la ultima intencion local
// gana, pero conserva el id del op original para que un reintento sea
// el mismo request ante el servidor
function opEnqueue(op) {
  const i = OUTBOX.findIndex(o => o.tableId === op.tableId
    && o.rowId === op.rowId);
  if (i >= 0) {
    op.id = OUTBOX[i].id;
    op.attempts = OUTBOX[i].attempts || 0;
    OUTBOX.splice(i, 1);
  }
  op.id = op.id || opId();
  op.uid = op.uid || boundUid() || null;
  op.attempts = op.attempts || 0;
  op.createdAt = op.createdAt
    || (typeof todaySV === "function" ? todaySV()
        : new Date().toISOString().slice(0, 10));
  OUTBOX.push(op); saveOutbox();
  return op;
}
// un op confirmado: sale de la cola y la baseline avanza — creates/
// upserts suman la llave confirmada, deletes la quitan. Solo se
// confirma el op EXACTO (mismo objeto en la cola vigente): un op
// coalescido/reemplazado durante el request jamas se marca logrado
// por un request viejo que pudo haber llegado o no
const opAck = op => {
  const i = OUTBOX.indexOf(op);
  if (i < 0) return;                // obsoleto: coalescido u otra ns
  // marcador EFIMERO en el objeto op (no persiste): "confirmado" solo
  // lo sabe este op exacto — un op coalescido/reemplazado/obsoleto o
  // uno ausente del array de OTRO namespace jamas reporta exito
  op.confirmed = true;
  OUTBOX.splice(i, 1);
  saveOutbox();
  const coll = SNAP_COLL[op.tableId];
  if (coll && op.key != null) {
    const s = new Set(snapJ[coll] || []);
    if (op.kind === "delete") s.delete(op.key); else s.add(op.key);
    snapJ[coll] = [...s];
    saveSyncSnap();
  }
  // una compra confirmada deja de marcarse pendiente en local —
  // "rid sin confirmar" es distinto de "borrada remotamente"
  if (op.tableId === COL_C && op.kind !== "delete"
      && typeof COMPRAS !== "undefined") {
    let ch = false;
    for (const c of COMPRAS)
      if (c.rid === op.rowId && c.pend) { delete c.pend; ch = true; }
    if (ch && typeof saveCompras === "function") saveCompras();
  }
};
// la fila remota actual matchea lo que este op espera? Un 409 sobre
// una fila distinta (compra de otro owner, colision de hash en watch)
// NUNCA se confirma — se retiene con error para revision
const rowMatches = (op, d) => {
  if (!d || d.$id !== op.rowId) return false;
  const x = op.data || {};
  switch (op.tableId) {
    case "favs":        return d.sku === x.sku;
    case "compras":     return d.sku === x.sku && d.paid === x.paid
      && (d.date || "") === (x.date || "");
    case "targets":     return d.sku === x.sku;
    case "siman_watch": return d.q === x.q
      && (d.talla || "") === (x.talla || "");
    case "siman_muted": return d.tkey === x.tkey;
    case "siman_seen":  return d.tkey === x.tkey;
    default:            return false;
  }
};
const opVerify = async (op, live) => {
  try {
    const d = await AW.dbs.getRow({ databaseId: AW_DB,
      tableId: op.tableId, rowId: op.rowId });
    return live() ? rowMatches(op, d) : null;
  } catch (e) { return live() ? "unknown" : null; }
};
// 404 en delete = ya no existe (logrado). 409 en create = la fila ya
// estaba: se VERIFICA identidad antes de confirmar (respuesta perdida
// del request anterior llego igual). 409 en el create dentro de un
// upsert = la fila existe con otro valor: reintentar el update para
// llevarla al dato deseado. Kind desconocido lanza — nunca cae a un
// request implicito. Antes de CADA request y despues de CADA await se
// re-verifica live(): un vuelo del dueno viejo jamas emite otro
// request (getRow, retry, fallback create) bajo la sesion nueva
const opRun = async (op, live) => {
  const a = { databaseId: AW_DB, tableId: op.tableId, rowId: op.rowId };
  const stale = () => { const e = new Error("vuelo obsoleto");
                        e.stale = true; throw e; };
  try {
    if (op.kind === "create") {
      const r = await AW.dbs.createRow({ ...a, data: op.data,
        permissions: docPerms(op.uid) });
      if (!live()) stale();
      return r;
    }
    if (op.kind === "update") {
      const r = await AW.dbs.updateRow({ ...a, data: op.data });
      if (!live()) stale();
      return r;
    }
    if (op.kind === "upsert") {
      let r;
      try { r = await AW.dbs.updateRow({ ...a, data: op.data }); }
      catch (e) {
        if (!live()) stale();
        if (e && e.code === 404) {
          r = await AW.dbs.createRow({ ...a, data: op.data,
            permissions: docPerms(op.uid) });
        } else throw e;
      }
      if (!live()) stale();
      return r;
    }
    if (op.kind === "delete") {
      const r = await AW.dbs.deleteRow(a);
      if (!live()) stale();
      return r;
    }
    throw new Error("kind desconocido: " + op.kind);
  } catch (e) {
    if (e && e.stale) throw e;
    if (!live()) stale();        // fallo obsoleto: no seguir requests
    if (e && e.code === 404 && op.kind === "delete") return {};
    if (e && e.code === 409 && op.kind === "upsert") {
      const r = await AW.dbs.updateRow({ ...a, data: op.data });
      if (!live()) stale();
      return r;
    }
    if (e && e.code === 409 && op.kind === "create") {
      const v = await opVerify(op, live);
      if (v === null) stale();   // cuenta cambio durante getRow
      if (v === true) return {};
      if (v === "unknown") {     // getRow ilegible: un reintento
        const r = await AW.dbs.createRow({ ...a, data: op.data,
          permissions: docPerms(op.uid) });
        if (!live()) stale();
        return r;
      }
      throw new Error("409: la fila remota no es la esperada");
    }
    throw e;
  }
};
// cada request captura dueno+epoch: si la cuenta cambia durante un
// await, el resultado queda obsoleto — no confirma, no marca intentos
// ni errores, y el loop corta sin mandar mas requests del dueno viejo.
// La intencion persiste en el outbox de SU namespace y se reintenta
// (idempotente) cuando esa cuenta vuelva
const liveOwner = () => AW.user && AW.user.$id;
const flushKey = () => (liveOwner() || "-") + "|" + PWStore.currentEpoch();
// guard completo: el dueno de AW.user y el de PWStore deben coincidir
// (un estado AW=userA + namespace B jamas es "vigente")
const ownedKey = key => key === flushKey()
  && !!liveOwner() && liveOwner() === PWStore.currentUser();
const _flushBody = async key => {
  const live = () => ownedKey(key);
  const tried = new Set();   // cada revision/op se intenta a lo sumo
                             // una vez por vuelo — nada de loop infinito
  for (;;) {
    if (!live()) return;                    // cambio de cuenta/epoch
    const owner = liveOwner();
    const op = OUTBOX.find(o => !tried.has(o)
      && (!o.uid || o.uid === owner));
    if (!op) return;
    tried.add(op);
    const mine = () => live() && OUTBOX.includes(op);
    try {
      await opRun(op, live);
      if (!mine()) continue;   // request viejo o op reemplazado:
                               // nada que confirmar; la intencion
                               // vigente sigue en la cola y drena abajo
      opAck(op);
    } catch (e) {
      if (e && e.stale) continue;   // vuelo obsoleto: sale arriba,
                                    // sin tocar intentos ni estado
      if (!mine()) continue;
      op.attempts++;
      SYNC.err = String(e && e.message || e).slice(0, 80);
      saveOutbox();
    }
  }
};
// single-flight por dueno/epoch: una llamada mientras corre el vuelo
// de OTRA cuenta se encadena al terminar esa — jamas devuelve el
// resultado ajeno como propio
let _flushing = null;        // {key, promise}
const opFlush = () => {
  // namespace corrupto (outbox/snap/dominio ilegible): congelar el
  // sync de nube hasta la recuperacion explicita — jamas se sube ni
  // se pisa a ciegas sobre un estado que no pudimos leer
  if (PWStore.corruptBlocking()) return Promise.resolve(false);
  const key = flushKey();
  if (_flushing && _flushing.key === key) return _flushing.promise;
  const p = (_flushing ? _flushing.promise : Promise.resolve())
    .then(() => _flushBody(key), () => _flushBody(key));
  _flushing = { key, promise: p };
  const done = () => {
    if (_flushing && _flushing.promise === p) _flushing = null;
    if (typeof paintAcct === "function") paintAcct();
  };
  p.then(done, done);
  return p;
};
const ridOf = () => {
  try { return Appwrite.ID.unique(); }
  catch (_) { return "loc-" + Date.now().toString(36)
      + Math.random().toString(36).slice(2, 8); }
};

// ---- helpers de dominio: encolan y disparan flush si hay sesion.
// Resuelven confirmado/pendiente; una falla NUNCA pierde la
// intencion — queda en OUTBOX para el proximo sync ----
// true solo si opAck marco ESTE op — no "ya no esta en el array" (un
// op ausente del OUTBOX de otra ns reportaba confirmacion falsa)
const _opDone = op => !!op.confirmed;
const favUp = sku => {
  if (!sku || !boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: COL_F, rowId: favId(sku),
    kind: "create", key: sku, data: { sku } });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
const favDown = sku => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: COL_F, rowId: favId(sku),
    kind: "delete", key: sku });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
// la compra recibe rid ANTES del request y el rid ES su identidad
// (op.key, rowId, snap) — dos compras identicas de sku/precio/fecha
// son filas distintas; el tuple ckey solo migra data vieja. Si la
// respuesta se pierde, el reintento reusa la misma fila (409 se
// verifica y confirma) — jamas una segunda ID.unique por reintento
const compraUp = c => {
  if (!c || c.sku == null || !(c.paid > 0))
    return Promise.resolve({ $id: null, pending: false });
  const key = flushKey();           // dueno+epoch al momento de encolar
  if (!c.rid) c.rid = ridOf();
  if (!boundUid())          // guest: solo local, sin intencion remota
    return Promise.resolve({ $id: c.rid, pending: true });
  const op = opEnqueue({ tableId: COL_C, rowId: c.rid,
    kind: "create", key: c.rid,
    data: { sku: c.sku, paid: c.paid, date: c.date || "1970-01-01" } });
  return opFlush().then(() => {
    const pend = !op.confirmed;
    // callback tardio tras cambio de cuenta: no escribir el
    // namespace que ahora esta activo
    if (key === flushKey()) {
      pend ? c.pend = 1 : delete c.pend;
      if (typeof saveCompras === "function") saveCompras();
    }
    return { $id: c.rid, pending: pend };
  }).catch(() => ({ $id: c.rid, pending: true }));
};
const compraDown = rid => {
  if (!boundUid()) return Promise.resolve(false);
  const op = opEnqueue({ tableId: COL_C, rowId: rid,
    kind: "delete", key: rid });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
// precios objetivo: row id = <userId>-<sku>, un target por producto
const tgtSet = (sku, t) => {
  const uid = boundUid();
  if (!sku || !(t > 0) || !uid) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "targets",
    rowId: `${uid}-${sku}`, kind: "upsert", key: sku,
    data: { sku, target: t } });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};
const tgtDel = sku => {
  const uid = boundUid();
  if (!uid) return Promise.resolve(false);
  const op = opEnqueue({ tableId: "targets",
    rowId: `${uid}-${sku}`, kind: "delete", key: sku });
  return opFlush().then(() => _opDone(op)).catch(() => false);
};

// ---- reconciliacion generica por coleccion contra la lectura
// remota + snap confirmado + outbox pendiente ----
// - remoto nuevo -> baja a local (excepto lo pendiente local)
// - remoto existente sin intento local -> applyRemote (updates del
//   otro dispositivo: targets/seen/filtros cambian)
// - snap presente y remoto ausente -> borrado remoto confirmado:
//   sale local, EXCEPTO si hay mutacion local pendiente — esa gana
//   (la llave sale del snap pero el valor local sobrevive el retry)
// - local nuevo (no remoto) -> op de alta, salvo que ya haya una
//   mutacion pendiente para esa llave (nada de ops duplicadas)
// - snap presente, remoto presente, local ausente -> borrado local
//   hecho offline -> op de borrado; la lectura vieja que aun lo trae
//   NO lo reimporta (pdel). Un delete confirmado en esta misma
//   corrida tampoco resucita por esa lectura anterior.
const mergeKeyed = (r, sk, A) => {
  const remote = new Set(r.map(A.remoteKey));
  // A.snap permite resolver llaves migradas (tuple->rid en compras)
  const snap = new Set(A.snap || snapJ[sk] || []);
  const pdel = opPending(A.table, "delete");
  const pany = opPending(A.table, null);   // cualquier intento local
  for (const k of snap)
    if (!A.localHas(k) && remote.has(k) && !pdel.has(k)) {
      pdel.add(k); A.delOp(k);
    }
  for (const k of snap)
    if (!remote.has(k)) {
      // protected: llave ambigua (tuple de compra sin distincion) —
      // jamas se borra local ni sale del baseline: se re-evalua cada
      // sync hasta que alguien resuelva la duplicidad
      if (A.protected && A.protected.has(k)) continue;
      if (!pany.has(k)) A.localDel(k);
      snap.delete(k);
    }
  for (const k of A.localKeys())
    if (!remote.has(k) && !pany.has(k)) A.upOp(k);
  for (const d of r) {
    const k = A.remoteKey(d);
    // skip: fila ambigua (tuple legacy sin distincion) — conservarla
    // remota y local sin tocar; jamas la confirmamos ni la borramos
    if (A.skip && A.skip.has(k)) continue;
    if (pdel.has(k) || pany.has(k)) continue;
    if (!A.localHas(k)) { A.importRow(d); snap.add(k); continue; }
    if (A.applyRemote) A.applyRemote(d);
  }
  snapJ[sk] = [...snap];
};

// sync single-flight por dueno/epoch igual que opFlush: una sync del
// nuevo dueno se encadena tras la vieja — nunca se confunden
let _syncing = null;         // {key, promise}
async function syncAll(){
  if (!AW.user) return false;
  // congelado por corrupcion local: el estado de este namespace no
  // se leyo completo — reportar en vez de fingir una corrida
  if (PWStore.corruptBlocking()) {
    SYNC.state = "error";
    SYNC.err = "datos locales dañados — usa 'recuperar datos'";
    if (typeof paintAcct === "function") paintAcct();
    return false;
  }
  const key = flushKey();
  if (_syncing) {
    if (_syncing.key === key) return _syncing.promise;
    return _syncing.promise.then(() => syncAll(), () => syncAll());
  }
  SYNC.state = "syncing"; SYNC.err = ""; paintAcct();
  _syncing = { key, promise: _syncBody(key) };
  const p = _syncing.promise;
  const done = () => {
    if (_syncing && _syncing.promise === p) _syncing = null;
    if (typeof paintAcct === "function") paintAcct();
  };
  p.then(done, done);
  return p;
}
// en cada await se re-verifica que el dueno/epoch siga vigente: una
// lectura que aterriza tras cambio de cuenta se descarta entera —
// nada importa filas del dueno viejo al namespace nuevo
async function _syncBody(key) {
    const live = () => ownedKey(key);
    try {
      await opFlush();                 // intenciones previas primero
      if (!live()) return false;
      const rd = t => listAll(t, live)
        .then(r => r === null ? { r: [], ok: false, stale: true }
                              : { r, ok: true })
        .catch(e => ({ r: [], ok: false, e }));
      const [Rf, Rc, Rw, Rm, Rs, Rt] = await Promise.all(
        [rd(COL_F), rd(COL_C), rd("siman_watch"),
         rd("siman_muted"), rd("siman_seen"), rd("targets")]);
      if (!live() || [Rf, Rc, Rw, Rm, Rs, Rt].some(x => x.stale))
        return false;            // lecturas del dueno viejo: fuera
      const wKey = w => w.q + "|" + (w.talla || "");
      // una coleccion ilegible conserva su estado local y marca
      // error — "sin lectura" jamas se interpreta como "todo borrado"
      const bad = (n, R) => {
        if (!R.ok)
          SYNC.err = `${n}: ${R.e && R.e.message || "sin lectura"}`
            .slice(0, 80);
      };
      if (Rf.ok) mergeKeyed(Rf.r, "favs", {
        table: COL_F, remoteKey: d => d.sku,
        localKeys: () => [...FAV],
        localHas: k => FAV.has(k),
        localDel: k => FAV.delete(k),
        delOp: k => favDown(k),
        upOp: k => favUp(k),
        importRow: d => FAV.add(d.sku),
      }); else bad("favs", Rf);
      if (Rc.ok) {
        // identidad primaria = rid/$id de fila. El tuple viejo del
        // snap se resuelve contra la lectura remota: 1 fila -> ese
        // rid; 2+ -> AMBIGUO: el tuple no distingue las candidatas —
        // se conservan remotas y locales sin borrar ni importar, la
        // llave queda protegida en el baseline y el sync se marca
        // para revision (nunca "sincronizado"); 0 -> tuple muerto:
        // las compras con rid de ese tuple son ESA fila borrada, las
        // sin rid conservan la llave tuple
        const rids = new Set(Rc.r.map(d => d.$id));
        const snapIds = new Set(), skipRows = new Set(),
              protectedKeys = new Set();
        let ambiguous = false;
        for (const k of new Set(snapJ.compras || [])) {
          if (rids.has(k)) { snapIds.add(k); continue; }
          const m = Rc.r.filter(d => ckey(d) === k);
          if (m.length === 1) snapIds.add(m[0].$id);
          else if (m.length > 1) {
            snapIds.add(k); protectedKeys.add(k); ambiguous = true;
            m.forEach(d => skipRows.add(d.$id));
          } else {
            const l = COMPRAS.filter(c => ckey(c) === k && c.rid);
            l.length ? l.forEach(c => snapIds.add(c.rid))
                     : snapIds.add(k);
          }
        }
        if (ambiguous)
          SYNC.err = "compras heredadas ambiguas: revisar antes de sincronizar";
        // adopcion sin ambiguedad: UNA fila remota y UNA compra
        // local sin rid con el mismo tuple son la misma compra —
        // la local hereda el rid; con multiples candidatos todo se
        // conserva como filas separadas (dos unidades reales)
        for (const d of Rc.r) {
          const ck2 = ckey(d);
          if (Rc.r.filter(x => ckey(x) === ck2).length !== 1) continue;
          const loc = COMPRAS.filter(c => !c.rid && ckey(c) === ck2);
          if (loc.length === 1) loc[0].rid = d.$id;
        }
        const cid = c => c.rid || ckey(c);
        mergeKeyed(Rc.r, "compras", {
          table: COL_C, snap: snapIds, skip: skipRows,
          protected: protectedKeys,
          remoteKey: d => d.$id,
          localKeys: () => COMPRAS.map(cid),
          localHas: k => COMPRAS.some(c => cid(c) === k),
          // borrar UNA copia: con unidades identicas una baja remota
          // tumba solo la fila confirmada — la otra unidad se conserva
          localDel: k => {
            const i = COMPRAS.findIndex(c => cid(c) === k);
            if (i >= 0) COMPRAS.splice(i, 1);
          },
          delOp: k => compraDown(k),
          upOp: k => { const c = COMPRAS.find(x => cid(x) === k);
                       if (c) compraUp(c); },
          importRow: d => COMPRAS.push({ sku: d.sku, paid: d.paid,
            date: d.date, rid: d.$id }),
        });
      } else bad("compras", Rc);
      if (Rw.ok) mergeKeyed(Rw.r, "watch", {
        table: "siman_watch", remoteKey: wKey,
        localKeys: () => SWATCH.map(wKey),
        localHas: k => SWATCH.some(w => wKey(w) === k),
        localDel: k => { SWATCH = SWATCH.filter(w => wKey(w) !== k); },
        delOp: k => { const i = k.lastIndexOf("|");
          return watchDown(k.slice(0, i), k.slice(i + 1)); },
        upOp: k => { const w = SWATCH.find(x => wKey(x) === k);
                     if (w) watchUp(w); },
        importRow: d => SWATCH.push({ q: d.q,
          talla: d.talla || undefined,
          solo: d.filtro ? d.filtro.split(",").filter(Boolean)
                         : undefined }),
        // la vigilancia existe: actualizar filtros del otro
        // dispositivo en vez de ignorar la fila remota
        applyRemote: d => {
          const w = SWATCH.find(x => wKey(x) === wKey(d));
          if (w) {
            w.talla = d.talla || undefined;
            w.solo = d.filtro ? d.filtro.split(",").filter(Boolean)
                              : undefined;
          }
        },
      }); else bad("watch", Rw);
      if (Rm.ok) {
        mergeKeyed(Rm.r, "mute", {
          table: "siman_muted", remoteKey: d => d.tkey,
          localKeys: () => [...SMUTE],
          localHas: k => SMUTE.has(k),
          localDel: k => SMUTE.delete(k),
          delOp: k => muteDown(k),
          upOp: k => muteUp(k),
          importRow: d => SMUTE.add(d.tkey),
        });
        // reglas migradas (tkey plano -> pid|tkey|ihs): borrar las
        // filas viejas para no acumular basura hacia el cap de 500
        if (typeof SUPG_MUTE !== "undefined") {
          SUPG_MUTE.forEach(muteDown); SUPG_MUTE.length = 0;
        }
      } else bad("mute", Rm);
      if (Rs.ok) {
        mergeKeyed(Rs.r, "seen", {
          table: "siman_seen", remoteKey: d => d.tkey,
          localKeys: () => Object.keys(SSEEN),
          localHas: k => k in SSEEN,
          localDel: k => { delete SSEEN[k]; },
          delOp: k => seenDown(k),
          upOp: k => seenUp(k, SSEEN[k]),
          // la nube baja reglas nuevas; si el precio difiere gana el
          // MAYOR — reavisa solo si baja de lo ya reconocido
          importRow: d => {
            if (d.tkey != null)
              SSEEN[d.tkey] = Math.max(SSEEN[d.tkey] ?? 0, d.price);
          },
          applyRemote: d => {
            if (d.tkey != null)
              SSEEN[d.tkey] = Math.max(SSEEN[d.tkey] ?? 0, d.price);
          },
        });
        if (typeof SUPG_SEEN !== "undefined") {
          SUPG_SEEN.forEach(seenDown); SUPG_SEEN.length = 0;
        }
      } else bad("seen", Rs);
      if (Rt.ok) mergeKeyed(Rt.r, "targets", {
        table: "targets", remoteKey: d => d.sku,
        localKeys: () => Object.keys(TARGETS),
        localHas: k => k in TARGETS,
        localDel: k => { delete TARGETS[k]; },
        delOp: k => tgtDel(k),
        upOp: k => tgtSet(k, TARGETS[k]),
        importRow: d => { if (d.sku && d.target)
          TARGETS[d.sku] = d.target; },
        applyRemote: d => { if (d.sku && d.target)
          TARGETS[d.sku] = d.target; },
      }); else bad("targets", Rt);

      await opFlush();       // intenciones inferidas en este merge
      if (!live()) return false;   // persistir solo si sigue este dueno
      const allOk = Rf.ok && Rc.ok && Rw.ok && Rm.ok && Rs.ok && Rt.ok;
      // "sincronizado" solo cuando TODO se leyo, no queda nada
      // pendiente y el estado local realmente persiste — una lectura
      // caida, un op retenido o storage roto no es exito
      SYNC.state = !allOk ? "error"
        : SYNC.err ? "error"     // p.ej. compras ambiguas: revisar
        : OUTBOX.length ? "pending"
        : !PWStore.status().persisted ? "pending" : "ok";
      saveSyncSnap();
      if (typeof saveFavs === "function") saveFavs();
      if (typeof saveCompras === "function") saveCompras();
      if (typeof saveTargets === "function") saveTargets();
      if (typeof saveCartLines === "function") saveCartLines();
      if (typeof saveSMute === "function") saveSMute();
      if (typeof saveSSeen === "function") saveSSeen();
      if (typeof saveSWatch === "function") saveSWatch();
      if (typeof rebuildPaid === "function") rebuildPaid();
      if (typeof render === "function") render();
      return SYNC.state === "ok";
    } catch (e) {
      if (!live()) return false;   // error de un dueno que ya salio:
                                   // no marcar el namespace nuevo
      SYNC.state = "error";
      SYNC.err = String(e && e.message || e).slice(0, 140);
      return false;
    }
}

// ---- namespace de cuenta: rehidratar colecciones sin mezclas ----
// Relee TODO lo namespaced del usuario activo. Las colecciones son
// const vivas: se vacian y se repueblan en sitio (SWATCH es let y se
// reasigna) — jamas se sube ni fusiona data de otra cuenta
const hydrateNS = () => {
  // formularios abiertos del dueno anterior se cierran ANTES de
  // recargar colecciones: un submit tardio o un input retenido no
  // pueden escribir en este namespace con el draft de la otra cuenta
  const closed = typeof closeStaleForms === "function"
    ? closeStaleForms() : 0;
  // el estado visible y las colas de migracion pertenecen al
  // namespace anterior: resetear para que nada del dueno viejo
  // (errores, "sincronizando", reglas SUPG pendientes) contamine este
  SYNC.state = "local"; SYNC.err = "";
  const rd = (k, f, v) => PWStore.read(k, f, v);
  if (typeof FAV !== "undefined") {
    FAV.clear();
    rd("pw-favs", [], PWStore.valid.strList).forEach(x => FAV.add(x));
  }
  if (typeof COMPRAS !== "undefined") {
    COMPRAS.length = 0;
    rd("pw-compras", [], PWStore.valid.compras)
      .forEach(x => COMPRAS.push(x));
  }
  if (typeof TARGETS !== "undefined") {
    for (const k in TARGETS) delete TARGETS[k];
    Object.assign(TARGETS, rd("pw-targets", {}, PWStore.valid.numMap));
  }
  if (typeof CART !== "undefined") {
    CART.clear();
    rd("pw-cart", [], PWStore.valid.strList).forEach(x => CART.add(x));
  }
  if (typeof CART_LINES !== "undefined") {
    for (const k in CART_LINES) delete CART_LINES[k];
    Object.assign(CART_LINES,
      rd("pw-cart-lines", {}, PWStore.valid.cartLines));
    // linea huerfana (carrito sin sku): no puede existir — la
    // membresia es CART; la linea sin sku se descarta al rehidratar
    for (const k in CART_LINES)
      if (!CART.has(k)) delete CART_LINES[k];
  }
  if (typeof SMUTE !== "undefined") {
    SMUTE.clear();
    rd("pw-siman-mute", [], PWStore.valid.strList)
      .forEach(x => SMUTE.add(x));
  }
  if (typeof SSEEN !== "undefined") {
    for (const k in SSEEN) delete SSEEN[k];
    Object.assign(SSEEN, rd("pw-siman-seen", {}, PWStore.valid.numMap));
  }
  if (typeof SWATCH !== "undefined")
    // mismo criterio que el boot: el dataset publico no siembra —
    // la lista del namespace (legacy migrada incluida) o vacia
    SWATCH = rd("pw-siman-watch", [], PWStore.valid.watch);
  for (const k in snapJ) delete snapJ[k];
  Object.assign(snapJ, rd("pw-sync-snap", {}, PWStore.valid.snap));
  OUTBOX.length = 0;
  rd("pw-outbox", [], PWStore.valid.outbox).forEach(x => OUTBOX.push(x));
  // re-migrar reglas legacy del namespace activo: vacia y repuebla
  // SUPG_* — jamas borra reglas viejas de OTRO uid con los ids de este
  if (typeof upgradeSimanRules === "function") upgradeSimanRules();
  if (typeof rebuildPaid === "function") rebuildPaid();
  if (typeof render === "function") render();
  // aviso honesto DESPUES de hidratar: el formulario reabierto ya
  // muestra la data de esta cuenta — aviso sin deshacer
  if (closed && typeof undoToast === "function")
    undoToast("La cuenta cambió; vuelve a abrir el formulario.", null);
};

// importacion EXPLICITA de datos guest a la cuenta: solo por accion
// del usuario, mergeando sin borrar lo guest (queda recuperable) ni
// pisar valores que el usuario ya tiene (targets/seen conservan lo suyo)
const guestHasData = () =>
  ["pw-favs", "pw-compras", "pw-targets", "pw-cart",
   "pw-siman-watch", "pw-siman-mute", "pw-siman-seen"].some(k => {
    const v = PWStore.readAs(null, k, null, () => true);
    return Array.isArray(v) ? v.length > 0
         : v && typeof v === "object" && Object.keys(v).length > 0;
  });
const importGuest = () => {
  if (!AW.user) return 0;
  let n = 0;
  const g = (k, f, v) => PWStore.readAs(null, k, f, v);
  g("pw-favs", [], PWStore.valid.strList)
    .forEach(s => { if (!FAV.has(s)) { FAV.add(s); n++; } });
  // compras: el rid guest es fila de OTRA cuenta — no se reusa.
  // Cada importada recibe rid propio estable y recuerda de donde
  // vino (_imported_from: rid origen o tuple#n) para que una
  // segunda importacion no duplique; el dato guest queda intacto
  const occ = {};
  g("pw-compras", [], PWStore.valid.compras).forEach(c => {
    const k = ckey(c);
    const i = occ[k] = (occ[k] || 0) + 1;
    const src = c.rid || `${k}#${i}`;
    if (c.rid && COMPRAS.some(x => x.rid === c.rid)) return;
    if (COMPRAS.some(x => x._imported_from === src)) return;
    COMPRAS.push({ sku: String(c.sku), paid: c.paid, date: c.date,
                   rid: ridOf(), _imported_from: src });
    n++;
  });
  const gt = g("pw-targets", {}, PWStore.valid.numMap);
  for (const s in gt) if (!(s in TARGETS)) { TARGETS[s] = gt[s]; n++; }
  g("pw-siman-mute", [], PWStore.valid.strList)
    .forEach(t => { if (!SMUTE.has(t)) { SMUTE.add(t); n++; } });
  const gs = g("pw-siman-seen", {}, PWStore.valid.numMap);
  for (const t in gs) if (!(t in SSEEN)) { SSEEN[t] = gs[t]; n++; }
  g("pw-siman-watch", [], PWStore.valid.watch).forEach(w => {
    if (!SWATCH.some(x => x.q === w.q
        && (x.talla || "") === (w.talla || ""))) {
      SWATCH.push(w); n++; }
  });
  g("pw-cart", [], PWStore.valid.strList)
    .forEach(s => { if (!CART.has(s)) { CART.add(s); n++; } });
  const gcl = g("pw-cart-lines", {}, PWStore.valid.cartLines);
  for (const s in gcl)
    if (CART.has(s) && !CART_LINES[s]) { CART_LINES[s] = gcl[s]; n++; }
  if (typeof saveFavs === "function") saveFavs();
  if (typeof saveCompras === "function") saveCompras();
  if (typeof saveTargets === "function") saveTargets();
  if (typeof saveCart === "function") saveCart();
  if (typeof saveCartLines === "function") saveCartLines();
  if (typeof saveSMute === "function") saveSMute();
  if (typeof saveSSeen === "function") saveSSeen();
  if (typeof saveSWatch === "function") saveSWatch();
  if (typeof rebuildPaid === "function") rebuildPaid();
  if (typeof render === "function") render();
  return n;
};

// recuperacion explicita de namespace corrupto (la unica salida del
// congelamiento): conserva los valores locales VALIDOS, repara solo
// las llaves corruptas a defaults parseados seguros (la cuarentena
// pw-corrupt-* queda para el export), y con cuenta ligada reconstruye
// los UPSERTS pendientes desde lo local con baseline vacio — jamas
// se infieren borrados remotos de un snap que no pudimos leer
const recoverNS = async () => {
  const fixed = PWStore.repairCorrupt({
    "pw-favs": [], "pw-compras": [], "pw-targets": {},
    "pw-cart": [], "pw-cart-lines": {},
    "pw-siman-watch": [], "pw-siman-mute": [],
    "pw-siman-seen": {}, "pw-sync-snap": {}, "pw-outbox": [] });
  if (!fixed.length) return { fixed, ok: true };
  hydrateNS();                 // re-lee los defaults reparados
  if (!PWStore.currentUser()) return { fixed, ok: true };
  // baseline vacio + upserts de todo lo valido: lo remoto ausente no
  // se interpreta como borrado y lo local se re-publica integro
  PWStore.write("pw-sync-snap", {});
  for (const k in snapJ) delete snapJ[k];
  const uid = PWStore.currentUser();
  [...FAV].forEach(s =>
    opEnqueue({ tableId: COL_F, rowId: `${uid}-${s}`,
      kind: "create", key: s, data: { sku: s } }));
  COMPRAS.forEach(c => {
    if (!c.rid) c.rid = ridOf();
    opEnqueue({ tableId: COL_C, rowId: c.rid, kind: "create",
      key: c.rid,
      data: { sku: c.sku, paid: c.paid, date: c.date || "1970-01-01" } });
  });
  for (const s in TARGETS)
    opEnqueue({ tableId: "targets", rowId: `${uid}-${s}`,
      kind: "upsert", key: s, data: { sku: s, target: TARGETS[s] } });
  SWATCH.forEach(w =>
    opEnqueue({ tableId: "siman_watch",
      rowId: `${uid}-${h16(w.q + "|" + (w.talla || ""))}`,
      kind: "upsert", key: w.q + "|" + (w.talla || ""),
      data: { q: w.q, talla: w.talla || "",
        filtro: (w.solo || []).join(",") } }));
  [...SMUTE].forEach(t =>
    opEnqueue({ tableId: "siman_muted",
      rowId: `${uid}-${h16(t)}`, kind: "create", key: t,
      data: { tkey: t } }));
  for (const r in SSEEN)
    opEnqueue({ tableId: "siman_seen",
      rowId: `${uid}-${h16(r)}`, kind: "upsert", key: r,
      data: { tkey: r, price: SSEEN[r] } });
  saveCompras();   // rids nuevos asignados arriba quedan persistidos
  const ok = await syncAll().catch(() => false);
  return { fixed, ok };
};

const lgDlg = document.getElementById("dlg-login");
const acctBtn = document.getElementById("acct");
const lgMsg = t => document.getElementById("lg-msg").textContent = t;
// estado honesto: "sincronizado" solo cuando el merge cerro completo,
// nunca por el solo hecho de tener sesion abierta
const syncLine = () => {
  const tail = PWStore.status().persisted
    ? "" : " — sin persistencia local";
  if (!AW.user)
    return "sin cuenta — datos solo en este dispositivo" + tail;
  const p = OUTBOX.length;
  if (SYNC.state === "syncing") return "sincronizando…";
  if (p) return `${p} cambio${p > 1 ? "s" : ""} pendiente${p > 1 ? "s" : ""}`
    + (SYNC.err ? " — " + SYNC.err : "") + tail;
  if (SYNC.state === "ok") return "sincronizado" + tail;
  if (SYNC.state === "error")
    return "sincronización con errores" + tail;
  return "cuenta ligada — pendiente de sincronizar" + tail;
};
function paintAcct(){
  if (!AW.ok) return;
  acctBtn.style.display = "";
  acctBtn.textContent = AW.user ? "☁ " + AW.user.email : "cuenta";
  document.getElementById("lg-form").style.display = AW.user ? "none" : "";
  document.getElementById("lg-out").style.display = AW.user ? "" : "none";
  if (AW.user)
    document.getElementById("lg-who").textContent = AW.user.email;
  const ss = document.getElementById("sync-status");
  if (ss) ss.textContent = syncLine();
  const imp = document.getElementById("lg-import");
  if (imp)
    imp.style.display = (AW.user && guestHasData()) ? "" : "none";
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
  // solo reportar exito si la sesion remota quedo cerrada de verdad
  try { await AW.acc.deleteSession("current"); }
  catch (e) { return lgMsg("no se pudo cerrar la sesión — reintenta"); }
  AW.user = null;
  PWStore.activate(null);   // a guest: sus datos quedan intactos
  hydrateNS(); paintAcct();
  lgMsg("sesión cerrada — los datos quedan en este dispositivo");
};
const lgImp = document.getElementById("lg-import");
if (lgImp) lgImp.onclick = () => {
  const n = importGuest();
  paintAcct();
  if (!n) return lgMsg("no había datos locales que importar");
  lgMsg("datos importados — sincronizando…");
  syncAll().then(ok => {
    lgMsg(ok ? `${n} dato${n > 1 ? "s" : ""} de este dispositivo agregado${n > 1 ? "s" : ""} y sincronizado${n > 1 ? "s" : ""}`
             : `${n} dato${n > 1 ? "s" : ""} de este dispositivo agregado${n > 1 ? "s" : ""} — pendiente${n > 1 ? "s" : ""} de sincronizar`);
    paintAcct();
  }).catch(() => {});
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
    // ligar el namespace de la cuenta ANTES de cualquier merge — la
    // data guest jamas se sube sola; solo por 'Importar datos…'
    PWStore.activate(AW.user.$id);
    hydrateNS();
    lgMsg("sincronizando…");
    await syncAll();
    lgDlg.close();
  } catch(e) {
    lgMsg(e.code === 401 ? "correo o contraseña incorrectos"
                         : String(e.message||"error").slice(0,140));
  }
}
