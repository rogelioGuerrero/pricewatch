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
import sqlite3
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import quote

import requests
from common import aw_env, aw_rows, hamming, norm, prune_jsonl, tkey, today_sv
from common import talla_hit as talla_hit  # re-export: tests la importan

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
SNAP_DIR = os.path.join(DATA_DIR, "siman_snapshots")
EVENTS_LOG = os.path.join(DATA_DIR, "siman_events.jsonl")
DB_PATH = os.path.join(DATA_DIR, "siman.db")
WATCH_FILE = os.path.join(DATA_DIR, "watchlist_siman.json")

API = "https://sv.siman.com/api/catalog_system/pub/products/search/"
HEADERS = {"accept": "application/json", "user-agent": "Mozilla/5.0"}

# una sola sesion: keep-alive TLS + gzip automatico en todos los fetch
SESSION = requests.Session()
ROWS = 50          # por pagina
MAX_PAGES = 3      # cap: 150 productos por busqueda
SLEEP = 0.4        # educado
MIN_MOVE_PCT = 1.0

def img_hash(url):
    """aHash 8x8 del contenido de la foto. Siman re-sube el asset con un
    id nuevo en cada recode (el URL siempre cambia), pero la imagen es la
    misma: distancia observada ~2/64 bits tras re-encoding."""
    try:
        import io

        from PIL import Image
        r = SESSION.get(url, headers=HEADERS, timeout=20)
        r.raise_for_status()
        data = r.content
        im = Image.open(io.BytesIO(data)).convert("L")
        im = im.resize((8, 8), Image.LANCZOS)
        px = list(im.getdata())
        avg = sum(px) / len(px)
        return format(sum(1 << i for i, v in enumerate(px) if v > avg),
                      "016x")
    except Exception:
        return None


def attach_hashes(items):
    """p['imghash'] por item, con cache por URL en siman.db — solo se
    descargan las fotos de listings nuevos (el resto ya tiene hash)."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS imgcache (
        url TEXT PRIMARY KEY, h TEXT)""")
    cached = {u: h for u, h in conn.execute("SELECT url, h FROM imgcache")}
    todo = [u for u in {it["image"] for it in items.values()
                        if it.get("image")}
            if u not in cached]
    for n, u in enumerate(todo, 1):
        h = img_hash(u)
        if h:
            conn.execute("INSERT OR REPLACE INTO imgcache VALUES (?,?)",
                         (u, h))
            cached[u] = h
        if n % 25 == 0:
            conn.commit()
            time.sleep(SLEEP)
    conn.commit()
    for it in items.values():
        it["imghash"] = cached.get(it.get("image"))
    conn.close()
    print(f"Imagenes hasheadas: {len(todo)} nuevas, "
          f"{len(cached)} en cache")


def fetch_search(q):
    """Todas las paginas de una busqueda; lista de items normalizados."""
    items = []
    for page in range(MAX_PAGES):
        url = (f"{API}?ft={quote(q)}&_from={page*ROWS}"
               f"&_to={page*ROWS + ROWS - 1}")
        for attempt in range(2):
            try:
                response = SESSION.get(url, headers=HEADERS, timeout=30)
                response.raise_for_status()
                res = response.json()
                if not isinstance(res, list):
                    raise ValueError("respuesta de busqueda invalida")
                break
            except Exception:
                if attempt:
                    raise
                time.sleep(3)
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
    if not all(aw_env()):
        return []
    try:
        out = []
        for r in aw_rows("siman_watch"):
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
            # No reemplazar el snapshot con un barrido parcial: los items
            # omitidos parecerian salidos y luego nuevos/recodificados.
            raise RuntimeError(f"busqueda '{q}' incompleta: {e}") from e
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


def link_recoded_history(conn, events):
    """'recodificado': el listing murio y otro lo reemplazo — copiar la
    serie historica del itemId viejo al nuevo y heredar su first_seen,
    para que el precio minimo historico no muera con el id efimero."""
    for e in events or []:
        if e.get("type") != "recodificado" or not e.get("old_iid"):
            continue
        conn.execute(
            "INSERT OR IGNORE INTO prices "
            "(itemId, date, price, list, qty, avail, card) "
            "SELECT ?, date, price, list, qty, avail, card "
            "FROM prices WHERE itemId = ?",
            (e["iid"], e["old_iid"]))
        conn.execute(
            "UPDATE items SET first_seen = (SELECT MIN(first_seen) "
            "FROM items WHERE itemId IN (?, ?)) WHERE itemId = ?",
            (e["iid"], e["old_iid"], e["iid"]))


def record_history(items, date, events=None):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS items (
        itemId TEXT PRIMARY KEY, pid TEXT, title TEXT, brand TEXT,
        link TEXT, image TEXT, vname TEXT, watch TEXT, talla TEXT,
        first_seen TEXT, last_seen TEXT, imghash TEXT)""")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
    if "imghash" not in cols:
        conn.execute("ALTER TABLE items ADD COLUMN imghash TEXT")
    conn.execute("""CREATE TABLE IF NOT EXISTS prices (
        itemId TEXT, date TEXT, price REAL, list REAL, qty INT,
        avail INT, card INT, PRIMARY KEY (itemId, date))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS imgcache (
        url TEXT PRIMARY KEY, h TEXT)""")
    conn.executemany(
        """INSERT INTO items (itemId, pid, title, brand, link, image,
           vname, watch, talla, first_seen, last_seen, imghash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(itemId) DO UPDATE SET
           pid=excluded.pid, title=excluded.title,
           link=excluded.link, image=excluded.image,
           vname=excluded.vname, watch=excluded.watch,
           talla=excluded.talla, last_seen=excluded.last_seen,
           imghash=excluded.imghash""",
        [(iid, p["pid"], p["title"], p["brand"], p["link"],
          p["image"], p["vname"], p.get("watch"), p.get("talla"),
          date, date, p.get("imghash")) for iid, p in items.items()])
    conn.executemany(
        "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?)",
        [(iid, date, p.get("price"), p.get("list"), p.get("qty"),
          int(p["avail"]), int(p.get("card") or 0))
         for iid, p in items.items()])
    link_recoded_history(conn, events)
    # poda de mantenimiento: sin esto items/prices/imgcache de listings
    # muertos (Siman recodifica a diario) crecen sin tope en el cache
    cutoff = (datetime.strptime(date, "%Y-%m-%d").date()
              - timedelta(days=120)).isoformat()
    conn.execute("DELETE FROM items WHERE last_seen < ?", (cutoff,))
    conn.execute("DELETE FROM prices WHERE itemId NOT IN "
                 "(SELECT itemId FROM items)")
    conn.execute("DELETE FROM imgcache WHERE url NOT IN "
                 "(SELECT image FROM items WHERE image IS NOT NULL)")
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
    # recodificado: murio uno y aparecio otro con el mismo titulo — o con
    # la misma FOTO (aHash): cubre recodes donde editaron el titulo, que
    # sin imagen caian como salio+nuevo y perdian el hilo
    new_by_t = {}
    for p in new_items:
        new_by_t.setdefault(tkey(p["title"]), []).append(p)
    consumed = set()
    for d in dead_items:
        cands = [x for x in new_by_t.get(tkey(d["title"]), [])
                 if x["iid"] not in consumed]
        if not cands and d.get("imghash"):
            cands = [x for x in new_items
                     if x["iid"] not in consumed and x.get("imghash")
                     and hamming(x["imghash"], d["imghash"]) <= 8]
        if cands:
            n = cands[0]
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
    prune_log()


def prune_log(keep_days=45):
    """Recorta el log a los ultimos `keep_days` dias: el sitio solo
    muestra los ultimos 200 y el digest solo lee hoy; la historia
    vive en siman.db."""
    prune_jsonl(EVENTS_LOG, keep_days)


def main():
    os.makedirs(SNAP_DIR, exist_ok=True)
    # Fecha SV (GMT-6), consistente con notify.py
    today = today_sv()
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
        if not prev and not known:
            events = []
    else:
        watches = load_watches()
        print(f"[{today}] Siman: {len(watches)} busquedas vigiladas")
        cur = sweep(watches)
        print(f"Total: {len(cur)} items unicos")
        attach_hashes(cur)   # foto = identidad que sobrevive recodes
        snap_file = os.path.join(SNAP_DIR, f"{today}.json")
        with open(snap_file, "w") as f:
            json.dump({"date": today, "items": cur}, f)
        print(f"Snapshot: {snap_file}")
        known = history_index()[0]
        events = diff(prev, cur, today, known)
        if not prev and not known:
            # primera observacion (o perdida del cache): no reportar
            # miles de 'nuevo' por un arranque en frio
            events = []
        record_history(cur, today, events)
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
