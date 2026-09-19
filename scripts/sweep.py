"""
sweep.py - Snapshot del catalogo PriceSmart SV via Bloomreach Discovery.

Itera las 25 categorias raiz (cada una incluye subcategorias), pagina de
200 en 200, deduplica por master_sku, guarda el snapshot y lo compara
con el anterior para emitir eventos de variacion.

Uso:
    python scripts/sweep.py            # fetch + diff + eventos
    python scripts/sweep.py --dry      # solo diff entre los 2 ultimos snapshots
"""

import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
SNAP_DIR = os.path.join(DATA_DIR, "snapshots")
EVENTS_LOG = os.path.join(DATA_DIR, "events.jsonl")
DB_PATH = os.path.join(DATA_DIR, "prices.db")

API = "https://www.pricesmart.com/api/br_discovery/getProductsByKeyword"
API_PRODUCT = "https://www.pricesmart.com/api/ct/getProduct"
CHANNEL = "1bad5650-9b56-4490-b3c5-2d50f86c6716"
COOKIE = (
    "vsf-locale=es-sv; vsf-currency=USD; vsf-country=sv; "
    f"vsf-store=SV; vsf-channel={CHANNEL}"
)
FL = ",".join([
    "pid", "title", "brand", "slug", "master_sku", "currency",
    "thumb_image",
    "price_SV", "sign_price_SV", "original_price_without_saving_SV",
    "saving_amount_SV", "availability_SV", "inventory_SV",
])
ROWS = 200
SLEEP = 0.4  # educado: ~2.5 req/s
MIN_MOVE_PCT = 1.0  # cambios de precio <1% son ruido, no evento

# Categorias raiz es-sv (del sitemap; la query del padre incluye hijos)
CATEGORIES = {
    "G10D03": "Alimentos", "U11D13": "Audiologia", "A10D20": "Automotriz",
    "B10D27": "Bebe", "C10D29": "Computadoras y tablets", "S30D26": "Deportes",
    "S20D23": "Electrodomesticos", "E10D24": "Electronicos", "L10D22": "Equipaje",
    "O20D30": "Exteriores", "H10D21": "Ferreteria", "H30D22": "Hogar",
    "J10D44": "Joyeria y relojes", "T10D46": "Juguetes", "G10D08014": "Licor",
    "M10D43": "Linea blanca", "P10D51": "Mascotas", "F10D40": "Moda",
    "F20D27": "Muebles", "O10D25": "Oficina", "U10D72": "Optica",
    "T20D42": "Peliculas/musica/libros", "S10D45": "Temporada",
    "H20D09": "Salud y belleza", "R10D22": "Restaurantes",
}

FIELDS = ["title", "brand", "slug", "thumb_image", "price_SV", "sign_price_SV",
          "original_price_without_saving_SV", "saving_amount_SV",
          "inventory_SV", "availability_SV"]


def fetch_category(cat_key):
    """Pagina una categoria completa; devuelve docs y el numFound reportado."""
    docs, start, num_found = [], 0, None
    while True:
        body = [{
            "url": f"https://www.pricesmart.com/es-sv/categoria/{cat_key}",
            "start": start, "q": cat_key, "fq": [],
            "search_type": "category", "rows": ROWS,
            "account_id": "7024", "auth_key": "ev7libhybjg5h1d1",
            "request_id": int(time.time() * 1000),
            "domain_key": "pricesmart_bloomreach_io_es",
            "fl": FL, "view_id": "SV",
        }]
        req = Request(API, data=json.dumps(body).encode(),
                      headers={"content-type": "application/json",
                               "cookie": COOKIE, "accept": "application/json"})
        with urlopen(req, timeout=30) as r:
            resp = json.loads(r.read())["response"]
        if num_found is None:
            num_found = resp["numFound"]
        docs.extend(resp["docs"])
        start += len(resp["docs"])
        if start >= num_found or not resp["docs"]:
            break
        time.sleep(SLEEP)
    return docs, num_found


def sweep():
    """Fetch del catalogo completo; devuelve {sku: producto}."""
    products = {}
    for cat_key, cat_name in CATEGORIES.items():
        try:
            docs, num_found = fetch_category(cat_key)
        except Exception as e:
            print(f"  ! {cat_name}: fallo ({e})")
            continue
        for d in docs:
            sku = str(d.get("master_sku") or d.get("pid"))
            if sku in products:
                continue
            p = {f: d.get(f) for f in FIELDS}
            p["category"] = cat_name
            # saving_amount_SV viene como string negativo ("-2.2" = $2.20)
            try:
                p["saving_usd"] = abs(float(p["saving_amount_SV"]))
            except (TypeError, ValueError):
                p["saving_usd"] = 0.0
            products[sku] = p
        print(f"  {cat_name}: {len(docs)}/{num_found} docs "
              f"({len(products)} unicos acumulados)")
        time.sleep(SLEEP)
    return products


def _is_synthetic(path):
    try:
        with open(path, encoding="utf-8") as f:
            return bool(json.load(f).get("synthetic"))
    except Exception:
        return False


def load_previous_snapshot():
    """Devuelve el snapshot mas reciente, prefiriendo uno real
    (los sinteticos del demo no deben contaminar el diff de produccion)."""
    if not os.path.isdir(SNAP_DIR):
        return None, None
    snaps = sorted(os.listdir(SNAP_DIR))
    if not snaps:
        return None, None
    real = [s for s in snaps if not _is_synthetic(os.path.join(SNAP_DIR, s))]
    last = real[-1] if real else snaps[-1]
    with open(os.path.join(SNAP_DIR, last), encoding="utf-8") as f:
        return last[:-5], json.load(f)


def cleanup_synthetic():
    """Purga snapshots/filas demo cuando ya hay suficiente historia real."""
    snaps = sorted(os.listdir(SNAP_DIR)) if os.path.isdir(SNAP_DIR) else []
    real, synt = [], []
    for s in snaps:
        path = os.path.join(SNAP_DIR, s)
        (synt if _is_synthetic(path) else real).append(s)
    if len(real) < 5:
        return
    first_real = real[0][:-5]
    for s in synt:
        os.remove(os.path.join(SNAP_DIR, s))
        print("snapshot sintetico eliminado:", s)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM prices WHERE date < ?", (first_real,))
    n = conn.total_changes
    conn.commit()
    conn.close()
    if n:
        print("filas demo eliminadas de prices.db:", n)


def history_index():
    """Indice de prices.db: skus conocidos, ultimo estado por sku,
    y ultima fecha con stock (para 'dias fuera')."""
    known, last, last_in = set(), {}, {}
    if not os.path.exists(DB_PATH):
        return known, last, last_in
    conn = sqlite3.connect(DB_PATH)
    try:
        for sku, price, d, st in conn.execute(
                "SELECT sku, price, date, in_stock FROM prices "
                "ORDER BY sku, date"):
            known.add(sku)
            last[sku] = (price, d)
            if st:
                last_in[sku] = d
    except sqlite3.OperationalError:
        pass
    conn.close()
    return known, last, last_in


def _days_between(d_old, d_new):
    try:
        return (datetime.strptime(d_new, "%Y-%m-%d")
                - datetime.strptime(d_old, "%Y-%m-%d")).days
    except (TypeError, ValueError):
        return None


def diff(prev, cur, today=None, known=None, last=None, last_in=None):
    """Genera eventos comparando snapshots {sku: {price_SV, inventory_SV,...}}.

    - 'reaparecio' fusiona la vuelta de stock con el cambio de precio
      (un solo evento dice: volvio tras N dias, antes $X ahora $Y).
    - 'regreso' (volvio al catalogo tras haber salido) se distingue de
      'nuevo' (SKU jamas visto) consultando la historia en prices.db.
    """
    known, last, last_in = known or set(), last or {}, last_in or {}
    events = []
    for sku, p in cur.items():
        if sku not in prev:
            if sku in known:  # salio del catalogo y regreso: NO es nuevo
                lp, ld = last.get(sku, (None, None))
                e = {"sku": sku, "type": "regreso", "title": p["title"],
                     "price": p["price_SV"], "prev_price": lp,
                     "days_out": _days_between(ld, today)}
                if lp and p["price_SV"] and p["price_SV"] != lp:
                    e["from"], e["to"] = lp, p["price_SV"]
                    e["pct"] = round((p["price_SV"] - lp) / lp * 100, 1)
                events.append(e)
            else:
                events.append({"sku": sku, "type": "nuevo",
                               "title": p["title"], "price": p["price_SV"]})
            continue
        old = prev[sku]
        p_new, p_old = p.get("price_SV"), old.get("price_SV")
        price_changed = (p_new is not None and p_old is not None
                         and p_new != p_old)
        pct = (round((p_new - p_old) / p_old * 100, 1)
               if price_changed and p_old else None)
        # filtro de ruido: jitter <1% no es evento (movimientos que importan)
        if pct is not None and abs(pct) < MIN_MOVE_PCT:
            price_changed, pct = False, None
        s_new = p.get("inventory_SV") == "in stock"
        s_old = old.get("inventory_SV") == "in stock"
        if s_new != s_old:
            if s_new:
                # Volvio: un solo evento cubre el cambio de precio si hubo
                e = {"sku": sku, "type": "reaparecio", "title": p["title"],
                     "price": p_new, "prev_price": p_old,
                     "days_out": _days_between(last_in.get(sku), today)}
                if price_changed:
                    e["from"], e["to"], e["pct"] = p_old, p_new, pct
                events.append(e)
            else:
                events.append({"sku": sku, "type": "agotado",
                               "title": p["title"], "price": p_new})
                if price_changed:
                    events.append({
                        "sku": sku,
                        "type": "bajo" if p_new < p_old else "subio",
                        "title": p["title"], "from": p_old, "to": p_new,
                        "delta": p_new - p_old, "pct": pct})
        elif price_changed:
            events.append({
                "sku": sku, "type": "bajo" if p_new < p_old else "subio",
                "title": p["title"], "from": p_old, "to": p_new,
                "delta": p_new - p_old, "pct": pct})
        # Oferta con letrero: cambia el ahorro sin que cambie el precio
        sv_new, sv_old = p.get("saving_usd") or 0, old.get("saving_usd") or 0
        if sv_new != sv_old:
            if sv_new > sv_old:
                events.append({"sku": sku, "type": "oferta",
                               "title": p["title"], "saving": sv_new,
                               "price": p_new})
            else:
                events.append({"sku": sku, "type": "oferta_termino",
                               "title": p["title"], "price": p_new})
    for sku, old in prev.items():
        if sku not in cur:
            events.append({"sku": sku, "type": "salio_del_catalogo",
                           "title": old["title"], "price": old.get("price_SV")})
    return events


def club_stock_diff(date, skus, products):
    """Transiciones de stock por club para los skus dados: compara la
    corrida actual contra la fecha anterior registrada en club_stock.
    Devuelve eventos club_agotado / club_volvio / se_agota (velocidad:
    la cantidad cae >=40% sin llegar a cero — 'se vende rapido')."""
    if not os.path.exists(DB_PATH):
        return []
    conn = sqlite3.connect(DB_PATH)
    try:
        prev_date = conn.execute(
            "SELECT MAX(date) FROM club_stock WHERE date < ?",
            (date,)).fetchone()[0]
        if not prev_date:
            return []
        prev = {(s, c): (st, q) for s, c, st, q in conn.execute(
            "SELECT sku, club, in_stock, qty FROM club_stock "
            "WHERE date = ?", (prev_date,))}
        cur = conn.execute(
            "SELECT sku, club, club_name, in_stock, qty FROM club_stock "
            "WHERE date = ?", (date,)).fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()
    events = []
    for sku, club, name, st, qty in cur:
        if sku not in skus:
            continue
        old = prev.get((sku, club))
        if old is None:
            continue
        o_st, o_qty = old
        if o_st != st:
            events.append({
                "sku": sku,
                "type": "club_volvio" if st else "club_agotado",
                "title": (products.get(sku) or {}).get("title", sku),
                "price": (products.get(sku) or {}).get("price_SV"),
                "club": name, "prev_date": prev_date})
        elif st and qty is not None and o_qty and qty <= o_qty * 0.6 \
                and o_qty - qty >= 2:
            events.append({
                "sku": sku, "type": "se_agota",
                "title": (products.get(sku) or {}).get("title", sku),
                "price": (products.get(sku) or {}).get("price_SV"),
                "club": name, "qty_from": o_qty, "qty_to": qty,
                "prev_date": prev_date})
    return events


def fetch_club_stock(skus, date):
    """Nivel 2: stock por club SV para los skus dados (batch de 50).
    Guarda en club_stock(sku,date,club,nombre,en_stock,qty)."""
    skus = sorted(skus)
    if not skus:
        return
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS club_stock (
        sku TEXT, date TEXT, club TEXT, club_name TEXT,
        in_stock INT, qty INT, PRIMARY KEY (sku, date, club))""")
    headers = {"content-type": "application/json", "cookie": COOKIE,
               "accept": "application/json"}
    for i in range(0, len(skus), 50):
        batch = skus[i:i + 50]
        body = [{"skus": batch},
                {"products": "getProductBySKU",
                 "metadata": {"channelId": CHANNEL}}]
        try:
            req = Request(API_PRODUCT, data=json.dumps(body).encode(),
                          headers=headers)
            with urlopen(req, timeout=60) as r:
                res = json.loads(r.read())["data"]["products"]["results"]
        except Exception as e:
            print(f"  ! club_stock batch {i}: fallo ({e})")
            continue
        for prod in res:
            for v in prod["masterData"]["current"]["allVariants"]:
                chans = (v.get("availability") or {}).get("channels", {}) \
                        .get("results", [])
                for c in chans:
                    key = c["channel"]["key"]
                    if not key.startswith("67"):
                        continue  # solo canales SV (67xx + canal nacional "67")
                    name = (c["channel"].get("nameAllLocales")
                            or [{"value": key}])[0]["value"]
                    a = c["availability"]
                    conn.execute(
                        "INSERT OR REPLACE INTO club_stock VALUES (?,?,?,?,?,?)",
                        (v["sku"], date, key, name,
                         int(a["isOnStock"]), a["availableQuantity"]))
        time.sleep(SLEEP)
    conn.commit()
    conn.close()


def record_history(products, date):
    """Anexa el snapshot a prices.db: historia longitudinal por sku/dia."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS prices (
        sku TEXT, date TEXT, price INT, sign_price INT, saving REAL,
        in_stock INT, PRIMARY KEY (sku, date))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS products (
        sku TEXT PRIMARY KEY, title TEXT, brand TEXT, category TEXT,
        slug TEXT, image TEXT)""")
    try:
        conn.execute("ALTER TABLE products ADD COLUMN image TEXT")
    except sqlite3.OperationalError:
        pass  # columna ya existe
    for sku, p in products.items():
        conn.execute(
            "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?)",
            (sku, date, p.get("price_SV"), p.get("sign_price_SV"),
             p.get("saving_usd"), int(p.get("inventory_SV") == "in stock")))
        conn.execute(
            "INSERT OR REPLACE INTO products VALUES (?,?,?,?,?,?)",
            (sku, p.get("title"), p.get("brand"), p.get("category"),
             p.get("slug"), p.get("thumb_image")))
    conn.commit()
    conn.close()


def stock_candidates(today, products):
    """SKUs a vigilar diario: ofertas activas del ultimo snapshot +
    cualquier producto con evento en los ultimos 14 dias."""
    cands = {s for s, p in products.items()
             if (p.get("saving_usd") or 0) > 0}
    try:
        from datetime import timedelta
        lim = (datetime.strptime(today, "%Y-%m-%d")
               - timedelta(days=14)).strftime("%Y-%m-%d")
        if os.path.exists(EVENTS_LOG):
            for line in open(EVENTS_LOG, encoding="utf-8"):
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("date", "") >= lim and e.get("sku"):
                    cands.add(e["sku"])
    except Exception:
        pass
    return cands


def append_events(events, today):
    """Escribe eventos al log sin duplicar (mismo date+sku+type+club)."""
    existing = set()
    if os.path.exists(EVENTS_LOG):
        for line in open(EVENTS_LOG, encoding="utf-8"):
            try:
                e = json.loads(line)
                existing.add((e.get("date"), e.get("sku"), e.get("type"),
                              e.get("club")))
            except Exception:
                pass
    new = [e for e in events
           if (today, e.get("sku"), e.get("type"), e.get("club"))
           not in existing]
    if new:
        with open(EVENTS_LOG, "a", encoding="utf-8") as f:
            for e in new:
                e["date"] = today
                f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"Eventos anexados a {EVENTS_LOG}: {len(new)}")
    return new


def main():
    os.makedirs(SNAP_DIR, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if "--stock-check" in sys.argv:
        # Chequeo diario ligero: solo stock por club de candidatos,
        # sin barrer el catalogo. Detecta velocidad de venta (se_agota).
        prev_name, prev_full = load_previous_snapshot()
        cur = prev_full["products"] if prev_full else {}
        cands = stock_candidates(today, cur)
        cands = set(sorted(cands)[:400])
        print(f"[{today}] Stock-check: {len(cands)} candidatos "
              f"(ofertas + eventos recientes)")
        fetch_club_stock(cands, today)
        events = club_stock_diff(today, cands, cur)
        print(f"Transiciones/velocidad: {len(events)}")
        for e in events[:15]:
            print(f"  {e['type']:>12} | {e['title'][:50]} | {e['club']}"
                  + (f" {e['qty_from']}->{e['qty_to']}"
                     if e["type"] == "se_agota" else ""))
        append_events(events, today)
        return

    if "--dry" not in sys.argv:
        prev_name, prev_full = load_previous_snapshot()  # antes de escribir
        prev = prev_full["products"] if prev_full else {}
        print(f"[{today}] Sweep catalogo SV...")
        cur = sweep()
        print(f"Total: {len(cur)} productos unicos")
        snap_file = os.path.join(SNAP_DIR, f"{today}.json")
        with open(snap_file, "w") as f:
            json.dump({"date": today, "products": cur}, f)
        print(f"Snapshot: {snap_file}")
        # indice de historia ANTES de grabar hoy (last = ultimo estado previo)
        hist_idx = history_index()
        record_history(cur, today)
        print(f"Historia actualizada en {DB_PATH}")
        cleanup_synthetic()
    else:
        snaps = sorted(os.listdir(SNAP_DIR))
        with open(os.path.join(SNAP_DIR, snaps[-1]), encoding="utf-8") as f:
            cur = json.load(f)["products"]
        print(f"Dry-run sobre {snaps[-1]}")
        prev_name, prev = snaps[-1], {}
        if len(snaps) >= 2:
            prev_name = snaps[-2]
            with open(os.path.join(SNAP_DIR, snaps[-2]), encoding="utf-8") as f:
                prev = json.load(f)["products"]
        hist_idx = history_index()

    known, last, last_in = hist_idx
    events = diff(prev, cur, today, known, last, last_in)
    by_type = {}
    for e in events:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    print(f"\nEventos vs snapshot anterior ({prev_name}): {by_type}")
    for e in events[:15]:
        if e["type"] in ("bajo", "subio"):
            print(f"  {e['type']:>10} | {e['title'][:55]} | "
                  f"${e['from']/100:.2f} -> ${e['to']/100:.2f} ({e['pct']}%)")
        else:
            print(f"  {e['type']:>10} | {e['title'][:55]} | "
                  f"${(e.get('price') or 0)/100:.2f}")
    if len(events) > 15:
        print(f"  ... y {len(events)-15} mas")

    # Nivel 2: stock por club para lo que importa (eventos + ofertas)
    if "--dry" not in sys.argv:
        skus_ev = {e["sku"] for e in events}
        skus_ev |= {s for s, p in cur.items() if (p.get("saving_usd") or 0) > 0}
        skus_ev = set(sorted(skus_ev)[:300])
        if skus_ev:
            print(f"Detalle por club para {len(skus_ev)} productos "
                  "(eventos + ofertas)…")
            fetch_club_stock(skus_ev, today)
            club_ev = club_stock_diff(today, skus_ev, cur)
            if club_ev:
                print(f"Transiciones por club: {len(club_ev)}")
                events.extend(club_ev)

    if events and "--dry" not in sys.argv:
        append_events(events, today)


if __name__ == "__main__":
    main()
