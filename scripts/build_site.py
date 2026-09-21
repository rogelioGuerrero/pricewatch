"""
build_site.py - Genera docs/index.html (dashboard estatico) desde
prices.db + events.jsonl. Muestra lo que el usuario final ve.
"""

import json
import os
import sqlite3
import statistics
from collections import defaultdict
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "prices.db")
EVENTS = os.path.join(ROOT, "data", "events.jsonl")
OUT = os.path.join(ROOT, "docs", "index.html")
MIS_COMPRAS = os.path.join(ROOT, "data", "mis-compras.json")

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
products = {r["sku"]: dict(r) for r in conn.execute("SELECT * FROM products")}
rows = conn.execute("SELECT * FROM prices ORDER BY date").fetchall()

series = defaultdict(list)
for r in rows:
    series[r["sku"]].append([r["date"], r["price"], r["in_stock"],
                             r["saving"] or 0])

latest = {}
for r in conn.execute(
        "SELECT * FROM prices WHERE date = (SELECT MAX(date) FROM prices)"):
    latest[r["sku"]] = dict(r)

# Stock por club del último fetch disponible (nivel 2, solo eventos)
clubs = defaultdict(dict)
try:
    for r in conn.execute(
            "SELECT * FROM club_stock WHERE date = "
            "(SELECT MAX(date) FROM club_stock)"):
        clubs[r["sku"]][r["club_name"]] = {
            "in_stock": bool(r["in_stock"]), "qty": r["qty"]}
except sqlite3.OperationalError:
    pass  # tabla aun no existe
conn.close()

events = []
if os.path.exists(EVENTS):
    for line in open(EVENTS, encoding="utf-8"):
        line = line.strip()
        if line:
            events.append(json.loads(line))
events = events[-200:]

mis = []
if os.path.exists(MIS_COMPRAS):
    for m in json.load(open(MIS_COMPRAS, encoding="utf-8")):
        sku = str(m["sku"])
        cur = latest.get(sku)
        hist = [p[1] for p in series.get(sku, [])]
        mis.append({
            "sku": sku, "paid": m["paid"], "date": m.get("date"),
            "title": products.get(sku, {}).get("title", sku),
            "now": cur["price"] if cur else None,
            "hist_min": min(hist) if hist else None,
        })

ofertas = [{"sku": s, "saving": r["saving"], "price": r["price"],
            **products.get(s, {})}
           for s, r in latest.items() if (r["saving"] or 0) > 0]

# Archivo: el PWA solo embebe productos vistos en los ultimos 45 dias
# (o referenciados por eventos/compras, para que sus cards tengan titulo).
# prices.db conserva la historia completa para siempre (deteccion de
# 'regreso', ficha historica); el payload no se llena de muertos.
gen = max((r[0] for s in series.values() for r in s), default="")
if gen:
    cutoff = (date.fromisoformat(gen) - timedelta(days=45)).isoformat()
    keep = {s for s, ser in series.items() if ser[-1][0] >= cutoff}
    keep |= {e["sku"] for e in events} | {m["sku"] for m in mis}
    series = {s: v for s, v in series.items() if s in keep}
    products = {s: p for s, p in products.items() if s in keep}

# Agregados historicos por sku: lo que pricesmart.com no puede mostrar
agg = {}
for sku, s in series.items():
    prices = [r[1] for r in s if r[1] is not None]
    if not prices:
        continue
    min_p, max_p = min(prices), max(prices)
    med = statistics.median(prices)
    last_p = prices[-1]
    n_ch = sum(1 for i in range(1, len(s))
               if s[i][1] is not None and s[i - 1][1] is not None
               and s[i][1] != s[i - 1][1])
    last_ch = None
    for i in range(len(s) - 1, 0, -1):
        if s[i][1] != s[i - 1][1]:
            last_ch = s[i][0]
            break
    d_out = 0  # racha actual de dias agotado
    for r in reversed(s):
        if r[2]:
            break
        d_out += 1
    n_out = sum(1 for i in range(1, len(s)) if s[i - 1][2] and not s[i][2])
    # cadencia de ofertas: inicios de episodio con letrero de ahorro
    of_starts = [s[i][0] for i in range(1, len(s))
                 if (s[i][3] or 0) > 0 and not (s[i - 1][3] or 0)]
    gaps = [(date.fromisoformat(b) - date.fromisoformat(a)).days
            for a, b in zip(of_starts, of_starts[1:])]
    last_of = next((r[0] for r in reversed(s) if (r[3] or 0) > 0), None)
    saves = [r[3] for r in s if (r[3] or 0) > 0]
    # racha de letrero activa (of_cur) y ultima racha ya terminada (of_end)
    run = None; last_run = None
    for i, r in enumerate(s):
        if (r[3] or 0) > 0:
            if run is None: run = r[0]
        elif run is not None:
            last_run = [run, s[i - 1][0]]; run = None
    agg[sku] = {
        "min": min_p, "max": max_p, "med": round(med),
        "pct_min": round((last_p - min_p) / min_p * 100, 1) if min_p else None,
        "vs_med": round((last_p - med) / med * 100, 1) if med else None,
        "n_ch": n_ch, "last_ch": last_ch,
        "d_out": d_out if not s[-1][2] else 0,
        "pct_stock": round(sum(1 for r in s if r[2]) / len(s) * 100),
        "n_out": n_out,
        "n_of": len(of_starts),
        "of_every": round(statistics.median(gaps)) if gaps else None,
        "of_last": (date.fromisoformat(s[-1][0])
                    - date.fromisoformat(last_of)).days if last_of else None,
        "of_save": round(statistics.median(saves), 2) if saves else None,
        "of_cur": run, "of_end": last_run,
        # vida corta y ya salio del catalogo = producto de temporada
        "temp": (sku not in latest
                 and (date.fromisoformat(s[-1][0])
                      - date.fromisoformat(s[0][0])).days < 60) or None,
    }

# Indice PriceWatch: % mediano de cambio de precio entre las 2 ultimas
# observaciones = "la inflacion de la tienda" segun nuestros datos
chg = []
for s in series.values():
    if len(s) >= 2 and s[-1][1] and s[-2][1]:
        chg.append((s[-1][1] - s[-2][1]) / s[-2][1] * 100)
indice = round(statistics.median(chg), 2) if chg else None

# ¿aun hay datos sinteticos del demo? (snapshot marcado o fechas pre-inicio)
SNAP_DIR = os.path.join(ROOT, "data", "snapshots")
demo = False
if os.path.isdir(SNAP_DIR):
    for f in os.listdir(SNAP_DIR):
        try:
            with open(os.path.join(SNAP_DIR, f), encoding="utf-8") as fh:
                if json.load(fh).get("synthetic"):
                    demo = True
                    break
        except Exception:
            pass

data = {
    "generated": max((r[0] for s in series.values() for r in s), default=""),
    "demo": demo,
    "n_products": len(latest),
    "n_stockout": sum(1 for r in latest.values() if not r["in_stock"]),
    "products": products, "series": series, "events": events,
    "mis": mis, "ofertas": ofertas, "clubs": clubs, "agg": agg,
    "indice": indice, "n_cambios_idx": len(chg),
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(os.path.join(ROOT, "scripts", "template.html"),
          encoding="utf-8") as f:
    html = f.read().replace("__DATA__", json.dumps(data, ensure_ascii=False))
with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)
print(f"Dashboard: {OUT}")
