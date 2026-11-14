// storage.js - adaptador de persistencia local: lectura defensiva,
// namespace por cuenta (guest / cada uid) y rescate de valores
// corruptos. Se evalua PRIMERO: los demas modulos leen su estado
// a traves de PWStore.

// localStorage puede lanzar (modo privado, cuota, deshabilitado):
// todo acceso pasa por raw/rawSet y el estado queda en status() —
// la app sigue viva con los datos en memoria aunque nada persista.
const PWStore = (() => {
  let broken = false, lastErr = "";
  // overlay en memoria por llave COMPLETA (namespace incluido): un
  // write va primero al overlay y luego al disco; si el disco falla,
  // las lecturas siguen viendo el valor durante esta ejecucion —
  // persisted:false lo reporta honestamente
  const overlay = new Map();
  const raw = k => {
    try { return localStorage.getItem(k); }
    catch (e) { broken = true; lastErr = "get:" + k; return null; }
  };
  const rawSet = (k, v) => {
    try { localStorage.setItem(k, v); return true; }
    catch (e) { broken = true; lastErr = "set:" + k; return false; }
  };
  const rawGet = k => overlay.has(k) ? overlay.get(k) : raw(k);
  const rawPut = (k, v) => { overlay.set(k, v); return rawSet(k, v); };
  const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));

  // namespace activo: null = guest (sin cuenta). Cada uid tiene su
  // propio prefijo — jamas se mezclan colecciones entre cuentas.
  // epoch crece en cada activate: un vuelo async captura (uid,epoch)
  // y si cambian, su resultado queda obsoleto — no toca el estado
  // del namespace nuevo
  let uid = null, epoch = 0;
  const pref = u => u ? `pw:user:${u}:` : "pw:guest:";
  const ns = () => pref(uid);
  const currentUser = () => uid;
  const currentEpoch = () => epoch;

  // colecciones de dominio namespaced; las prefs de UI (tab, club,
  // orden de acordeones) quedan globales — no son datos de cuenta
  const DOMAIN = ["pw-favs", "pw-compras", "pw-targets", "pw-cart",
    "pw-cart-lines", "pw-siman-watch", "pw-siman-mute", "pw-siman-seen",
    "pw-sync-snap", "pw-outbox"];

  // llaves que devolvieron fallback por estar corruptas, por
  // namespace: una A rota no congela el sync de una B sana
  const CORRUPT = new Map();
  // full-keys de cuarentena escritas en esta sesion (para export sin
  // depender de localStorage.key/length, que puede no existir)
  const QUAR = new Set();
  const markCorrupt = (u, key) => {
    const p = pref(u);
    if (!CORRUPT.has(p)) CORRUPT.set(p, new Set());
    CORRUPT.get(p).add(key);
  };
  // llaves corruptas del namespace ACTIVO (sin prefijo)
  const corruptKeys = () => [...(CORRUPT.get(ns()) || [])];
  // estado corrupto que congela el sync: outbox/snap ilegibles o
  // cualquier coleccion de dominio — nunca se sube ni se pisa a
  // ciegas; la recuperacion explicita decide
  const corruptBlocking = () =>
    corruptKeys().some(k => DOMAIN.includes(k));

  // la data vieja sin namespace se copia a guest UNA vez — el
  // original sin prefijo queda intacto (recuperable / migrable)
  const migrateLegacy = () => {
    for (const k of DOMAIN)
      if (rawGet(ns() + k) == null && rawGet(k) != null)
        rawPut(ns() + k, rawGet(k));
  };

  // hint de la ultima cuenta ligada: offline arranca con SU
  // namespace — sus datos siguen usables aunque Appwrite no responda
  const HINT = "pw-uid-hint";
  const activate = u => {
    u = u || null;
    if (u === uid) {                // mismo namespace: no resetear
      if (!uid) migrateLegacy();    // (arranque guest igual migra)
      return;
    }
    uid = u;
    epoch++;
    rawPut(HINT, uid || "");
    if (!uid) migrateLegacy();
  };

  // lectura defensiva: parse + validacion de forma. Un valor
  // corrupto NO tumba el arranque ni se borra — se conserva bajo
  // pw-corrupt-<ns><key> para recuperar/exportar y se devuelve
  // el fallback intacto (clone: nunca la misma referencia)
  const readAs = (u, key, fb, valid) => {
    const fk = pref(u) + key;
    const v = rawGet(fk);
    if (v == null) return clone(fb);
    try {
      const j = JSON.parse(v);
      if (valid && !valid(j)) throw new Error("forma invalida");
      return j;
    } catch (e) {
      rawPut("pw-corrupt-" + fk, v);
      QUAR.add("pw-corrupt-" + fk);
      markCorrupt(u, key);
      lastErr = "corrupt:" + fk;
      return clone(fb);
    }
  };
  const read = (k, fb, v) => readAs(uid, k, fb, v);
  const write = (k, v) => {
    let ok;
    try { ok = rawPut(ns() + k, JSON.stringify(v)); }
    catch (e) { lastErr = "json:" + k; ok = false; }
    if (!ok) broken = true;
    return ok;
  };

  // prefs globales en texto plano (no namespaced): pw-tab, pw-club…
  const get = k => rawGet(k);
  const set = (k, v) => { if (!rawPut(k, String(v))) broken = true; };

  const status = () => ({ persisted: !broken, error: lastErr,
                          user: uid, ns: ns(), epoch });

  // validadores de forma por coleccion: rechazan basura bien formada
  // (array donde va objeto, entradas sin la llave minima, Infinity
  // por 1e999) — un shape malo jamas llega al dominio ni a un
  // request remoto
  const isoDate = s => typeof s === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const fin = x => Number.isFinite(x);
  const finPos = x => Number.isFinite(x) && x > 0;
  const OP_KIND = new Set(["create", "update", "upsert", "delete"]);
  const OP_TABLE = new Set(["favs", "compras", "targets",
    "siman_watch", "siman_muted", "siman_seen"]);
  const valid = {
    strList: a => Array.isArray(a)
      && a.every(x => typeof x === "string"),
    compras: a => Array.isArray(a)
      && a.every(c => c && typeof c === "object"
        && (typeof c.sku === "string" || typeof c.sku === "number")
        && finPos(c.paid)
        && (c.date == null || isoDate(c.date))
        && (c.rid == null || typeof c.rid === "string")
        && (c._imported_from == null
            || typeof c._imported_from === "string")),
    map: o => o && typeof o === "object" && !Array.isArray(o),
    numMap: o => o && typeof o === "object" && !Array.isArray(o)
      && Object.values(o).every(x => fin(x) && x >= 0),
    watch: a => Array.isArray(a)
      && a.every(w => w && typeof w.q === "string"
        && (w.talla == null || typeof w.talla === "string")
        && (w.solo == null || (Array.isArray(w.solo)
            && w.solo.every(x => typeof x === "string")))),
    // el snapshot solo tiene colecciones: {nombre: [llaves string]}
    snap: o => o && typeof o === "object" && !Array.isArray(o)
      && Object.values(o).every(v => Array.isArray(v)
          && v.every(x => typeof x === "string")),
    // un op invalido jamas se ejecuta: kind/table en whitelist,
    // uid/key/rowId strings, data objeto con campos numericos finitos
    outbox: a => Array.isArray(a)
      && a.every(o => o && typeof o === "object"
        && typeof o.rowId === "string"
        && OP_KIND.has(o.kind)
        && OP_TABLE.has(o.tableId)
        && (o.uid == null || typeof o.uid === "string")
        && (o.key == null || typeof o.key === "string")
        && (o.kind === "delete" || (o.data
            && typeof o.data === "object"
            && (o.data.paid == null || finPos(o.data.paid))
            && (o.data.price == null || finPos(o.data.price))
            && (o.data.target == null || finPos(o.data.target))))),
    // carrito con cantidad+precio por linea: {sku: {quantity, unitCents}}
    cartLines: o => o && typeof o === "object" && !Array.isArray(o)
      && Object.values(o).every(l => l && typeof l === "object"
        && Number.isInteger(l.quantity) && l.quantity >= 1
        && l.quantity <= 99
        && (l.unitCents == null || (Number.isInteger(l.unitCents)
            && l.unitCents > 0))),
  };

  // limpia solo las llaves corruptas del namespace activo con sus
  // defaults ya parseados — la cuarentena pw-corrupt-* queda
  // intacta para el export; CORRUPT se reinicia porque el valor
  // fuente ya es sano
  const repairCorrupt = defaults => {
    const ks = corruptKeys();
    for (const k of ks)
      if (Object.prototype.hasOwnProperty.call(defaults, k))
        write(k, defaults[k]);
    CORRUPT.delete(ns());
    return ks;
  };

  // export privado del namespace activo: todo el estado de dominio
  // parseado cuando se puede + los originales en crudo cuando no
  // (los corruptos van verbatim para recuperacion manual fuera de
  // la app). Incluye ops pendientes y cuarentena — es la copia de
  // seguridad antes de cualquier recuperacion destructiva.
  const exportNS = () => {
    const p = ns(), out = { app: "pricewatch-sv", ns: p,
      exported_at: new Date().toISOString(), data: {}, quarantine: {} };
    for (const k of DOMAIN) {
      const v = rawGet(p + k);
      if (v == null) continue;
      try { out.data[k] = JSON.parse(v); }
      catch (_) { out.data[k] = { _raw: v }; }
    }
    const pref2 = "pw-corrupt-" + p;
    const scan = k => {
      if (k && k.startsWith(pref2)) {
        const v = rawGet(k);
        if (v != null) out.quarantine[k.slice(pref2.length)] = v;
      }
    };
    QUAR.forEach(scan);
    try {
      for (let i = 0; i < localStorage.length; i++)
        scan(localStorage.key(i));
    } catch (_) { /* storage roto/limited: QUAR ya cubrio esta sesion */ }
    return out;
  };

  activate(rawGet(HINT) || null);
  return { read, readAs, write, get, set, activate, currentUser,
           currentEpoch, status, valid, corruptKeys, corruptBlocking,
           repairCorrupt, exportNS };
})();
