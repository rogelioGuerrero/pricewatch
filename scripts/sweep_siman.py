"""
sweep_siman.py - Vigilancia de Siman (VTEX) por busquedas.

La unidad de vigilancia es la BUSQUEDA (marca/tipo de articulo), no el
productId: Siman recodifica productos y el codigo muere; la busqueda
siempre vuelve a encontrar el listing. Cuando un listing desaparece y
aparece otro con titulo casi igual, se emite 'recodificado' y se enlaza
la historia.

El precio por VARIANTE (talla) se guarda por itemId; las alertas en el
PWA filtran por la talla del watch y por stock de esa talla.

Uso:
    python scripts/sweep_siman.py         # fetch + historia + eventos
    python scripts/sweep_siman.py --dry   # diff entre los 2 ultimos snapshots
"""

import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
from datetime import datetime, timezone
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
SNAP_DIR = os.path.join(DATA_DIR, "siman_snapshots")
EVENTS_LOG = os.path.join(DATA_DIR, "siman_events.jsonl")
DB_PATH = os.path.join(DATA_DIR, "siman.db")
WATCH_FILE = os.path.join(DATA_DIR, "watchlist_siman.json")

API = "https://sv.siman.com/api/catalog_system/pub/products/search/"
HEADERS = {"accept": "application/json", "user-agent": "Mozilla/5.0"}
ROWS = 50          # por pagina
MAX_PAGES = 3      # cap: 150 productos por busqueda
SLEEP = 0.4        # educado
MIN_MOVE_PCT = 1.0

TOKEN_RE = re.compile(r"[a-z0-9]+")


def norm(s):
    """minisculas, sin tildes, solo alfanumerico."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(TOKEN_RE.findall(s))


def tkey(title):
    """Identidad del producto que sobrevive recodificados."""
    return norm(title)


def talla_hit(vname, talla):
    """La variante corresponde a la talla pedida? '36X32'->36, 'BLUE:38'->38,
    'NAVY:L'->L. Solo matching de token exacto para no confundir 11 con 110."""
    if not talla:
        return True
    v = (vname or "").upper()
    v = re.sub(r"(?<=\d)[Xx](?=\d)", " ", v)   # 36X32 -> 36 32
    v = re.sub(r"[:/\-_,]", " ", v)
    t = str(talla).upper()
    return re.search(rf"(?<![0-9A-Z]){re.escape(t)}(?![0-9A-Z])", v) is not None


def fetch_search(q):
    """Todas las paginas de una busqueda; lista de items normalizados."""
    items = []
    for page in range(MAX_PAGES):
        url = (f"{API}?ft={quote(q)}&_from={page*ROWS}"
               f"&_to={page*ROWS + ROWS - 1}")
        req = Request(url, headers=HEADERS)
        try:
            with urlopen(req, timeout=30) as r:
                res = json.loads(r.read())
        except Exception:
            time.sleep(3)
            with urlopen(req, timeout=30) as r:   # un reintento por pagina
                res = json.loads(r.read())
        if not res:
            break
        for p in res:
            pid = str(p.get("productId") or "")
            title = p.get("productName") or ""
            link = p.get("link") or ""
            for v in p.get("items", []):
                iid = str(v.get("itemId") or "")
                if not iid:
                    continue
                imgs = v.get("images") or []
                img = imgs[0].get("imageUrl") if imgs else None
                best = None   # el seller mas barato con stock (o el 1ro)
                for s in v.get("sellers", []):
                    o = s.get("commertialOffer") or {}
                    if best is None or (
                            o.get("IsAvailable") and o.get("Price")
                            and (not best.get("IsAvailable")
                                 or o["Price"] < best["Price"])):
                        best = o
                o = best or {}
                teasers = json.dumps(o.get("Teasers") or [], ensure_ascii=False)
                items.append({
                    "iid": iid, "pid": pid, "title": title,
                    "brand": p.get("brand"), "link": link, "image": img,
                    "vname": v.get("name") or "",
                    "price": o.get("Price"), "list": o.get("ListPrice"),
                    "qty": o.get("AvailableQuantity") or 0,
                    "avail": bool(o.get("IsAvailable")),
                    "card": "credisiman" in teasers.lower(),
                })
        time.sleep(SLEEP)
        if len(res) < ROWS:
            break
    return items


def watches_remote():
    """Watches del usuario en Appwrite (si hay API key); [] si no."""
    ep, pid, key = (os.environ.get("APPWRITE_ENDPOINT"),
                    os.environ.get("APPWRITE_PROJECT_ID"),
                    os.environ.get("APPWRITE_API_KEY"))
    if not (ep and pid and key):
        return []
    try:
        q = quote('{"method":"limit","values":[500]}')
        req = Request(f"{ep}/tablesdb/pricewatch/tables/siman_watch/rows"
                      f"?queries%5B%5D={q}",
                      headers={"X-Appwrite-Project": pid,
                               "X-Appwrite-Key": key})
        rows = json.load(urlopen(req, timeout=15)).get("rows", [])
        out = []
        for r in rows:
            w = {"q": r.get("q")}
            if r.get("talla"):
                w["talla"] = r["talla"]
            if r.get("filtro"):
                w["solo"] = [t.strip() for t in str(r["filtro"]).split(",")
                             if t.strip()]
            if w["q"]:
                out.append(w)
        return out
    except Exception as e:
        print(f"  (watches remotos no disponibles: {e})")
        return []


def load_watches():
    w = watches_remote()
    if w:
        return w
    if os.path.exists(WATCH_FILE):
        with open(WATCH_FILE, encoding="utf-8") as f:
            return json.load(f)
    return []


def sweep(watches):
    """{iid: item} de todas las busquedas; anota el watch que lo trajo."""
    items = {}
    for w in watches:
        q = w["q"]
        try:
            found = fetch_search(q)
        except Exception as e:
            print(f"  ! '{q}': fallo ({e})")
            continue
        solo = [norm(x) for x in (w.get("solo") or [])]
        n = 0
        for it in found:
            if solo and not any(t in norm(it["title"]) for t in solo):
                continue
            if it["iid"] not in items:
                it["watch"] = q
                it["talla"] = w.get("talla")
                items[it["iid"]] = it
                n += 1
        print(f"  '{q}': {n} items")
        time.sleep(SLEEP)
    return items


def history_index():
    """skus conocidos, ultimo estado y ultima fecha con stock."""
    known, last, last_in = set(), {}, {}
    if not os.path.exists(DB_PATH):
        return known, last, last_in
    conn = sqlite3.connect(DB_PATH)
    try:
        for iid, price, d, av in conn.execute(
                "SELECT itemId, price, date, avail FROM prices "
                "ORDER BY itemId, date"):
            known.add(iid)
            last[iid] = (price, d)
            if av:
                last_in[iid] = d
    except sqlite3.OperationalError:
        pass
    conn.close()
    return known, last, last_in


def record_history(items, date):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS items (
        itemId TEXT PRIMARY KEY, pid TEXT, title TEXT, brand TEXT,
        link TEXT, image TEXT, vname TEXT, watch TEXT, talla TEXT,
        first_seen TEXT, last_seen TEXT)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS prices (
        itemId TEXT, date TEXT, price REAL, list REAL, qty INT,
        avail INT, card INT, PRIMARY KEY (itemId, date))""")
    for iid, p in items.items():
        conn.execute(
            """INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(itemId) DO UPDATE SET
               pid=excluded.pid, title=excluded.title,
               link=excluded.link, image=excluded.image,
               vname=excluded.vname, last_seen=excluded.last_seen""",
            (iid, p["pid"], p["title"], p["brand"], p["link"],
             p["image"], p["vname"], p.get("watch"), p.get("talla"),
             date, date))
        conn.execute(
            "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)",
            (iid, date, p.get("price"), p.get("list"), p.get("qty"),
             int(p["avail"]), int(p.get("card") or 0)))
    conn.commit()
    conn.close()


def diff(prev, cur, today, known):
    """Eventos entre snapshots {iid: item}. 'recodificado': un listing
    muere y otro nuevo tiene el mismo titulo normalizado."""
    events = []
    new_items, dead_items = [], []
    for iid, p in cur.items():
        if iid not in prev:
            new_items.append(p)
            continue
        old = prev[iid]
        p_new, p_old = p.get("price"), old.get("price")
        if p_new is not None and p_old is not None and p_new != p_old:
            pct = round((p_new - p_old) / p_old * 100, 1) if p_old else None
            if pct is not None and abs(pct) >= MIN_MOVE_PCT:
                events.append({
                    "iid": iid, "type": "bajo" if p_new < p_old else "subio",
                    "title": p["title"], "from": p_old, "to": p_new,
                    "pct": pct, "vname": p["vname"]})
        d_new = (p.get("list") or 0) > (p.get("price") or 0)
        d_old = (old.get("list") or 0) > (old.get("price") or 0)
        if d_new and not d_old:
            events.append({"iid": iid, "type": "oferta", "title": p["title"],
                           "price": p_new, "list": p.get("list"),
                           "vname": p["vname"]})
        elif d_old and not d_new:
            events.append({"iid": iid, "type": "oferta_termino",
                           "title": p["title"], "price": p_new,
                           "vname": p["vname"]})
        if p["avail"] != old["avail"]:
            events.append({
                "iid": iid,
                "type": "reaparecio" if p["avail"] else "agotado",
                "title": p["title"], "price": p_new, "vname": p["vname"]})
    for iid, p in prev.items():
        if iid not in cur:
            dead_items.append(p)
    # recodificado: murio uno y aparecio otro con el mismo titulo
    new_by_t = {}
    for p in new_items:
        new_by_t.setdefault(tkey(p["title"]), []).append(p)
    consumed = set()
    for d in dead_items:
        cand = new_by_t.get(tkey(d["title"]))
        if cand:
            n = cand.pop(0)
            consumed.add(n["iid"])
            events.append({"iid": n["iid"], "type": "recodificado",
                           "title": n["title"], "old_iid": d["iid"],
                           "price": n.get("price"),
                           "prev_price": d.get("price"),
                           "vname": n["vname"]})
        else:
            events.append({"iid": d["iid"], "type": "salio",
                           "title": d["title"], "price": d.get("price"),
                           "vname": d["vname"]})
    for p in new_items:
        if p["iid"] in consumed:
            continue
        if p["iid"] in known:
            events.append({"iid": p["iid"], "type": "regreso",
                           "title": p["title"], "price": p.get("price"),
                           "vname": p["vname"]})
        else:
            events.append({"iid": p["iid"], "type": "nuevo",
                           "title": p["title"], "price": p.get("price"),
                           "vname": p["vname"]})
    return events


def load_snapshots():
    if not os.path.isdir(SNAP_DIR):
        return None, {}
    snaps = sorted(f for f in os.listdir(SNAP_DIR) if f.endswith(".json"))
    if not snaps:
        return None, {}
    with open(os.path.join(SNAP_DIR, snaps[-1]), encoding="utf-8") as f:
        return snaps[-1], json.load(f)["items"]


def prune_snapshots(keep=14):
    snaps = sorted(f for f in os.listdir(SNAP_DIR) if f.endswith(".json"))
    for f in snaps[:-keep]:
        os.remove(os.path.join(SNAP_DIR, f))


def append_events(events, today):
    if not events:
        return
    with open(EVENTS_LOG, "a", encoding="utf-8") as f:
        for e in events:
            e["date"] = today
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def main():
    os.makedirs(SNAP_DIR, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    prev_name, prev = load_snapshots()

    if "--dry" in sys.argv:
        snaps = sorted(f for f in os.listdir(SNAP_DIR) if f.endswith(".json"))
        cur = prev
        prev_name, prev = None, {}
        if len(snaps) >= 2:
            prev_name = snaps[-2]
            with open(os.path.join(SNAP_DIR, snaps[-2]),
                      encoding="utf-8") as f:
                prev = json.load(f)["items"]
        print(f"Dry-run sobre {snaps[-1] if snaps else 'nada'}")
        known = history_index()[0]
        events = diff(prev, cur, today, known)
    else:
        watches = load_watches()
        print(f"[{today}] Siman: {len(watches)} busquedas vigiladas")
        cur = sweep(watches)
        print(f"Total: {len(cur)} items unicos")
        snap_file = os.path.join(SNAP_DIR, f"{today}.json")
        with open(snap_file, "w") as f:
            json.dump({"date": today, "items": cur}, f)
        print(f"Snapshot: {snap_file}")
        known = history_index()[0]
        events = diff(prev, cur, today, known)
        record_history(cur, today)
        print(f"Historia actualizada en {DB_PATH}")
        prune_snapshots()

    by_type = {}
    for e in events:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    print(f"Eventos vs {prev_name or 'nada'}: {by_type}")
    for e in events[:15]:
        print(f"  {e['type']:>12} | {e['title'][:55]} | "
              f"${e.get('to') or e.get('price') or 0}")
    if len(events) > 15:
        print(f"  ... y {len(events)-15} mas")
    if events and "--dry" not in sys.argv:
        append_events(events, today)


if __name__ == "__main__":
    main()
