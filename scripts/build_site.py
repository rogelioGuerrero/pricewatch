"""
build_site.py - Genera docs/index.html (dashboard estatico) desde
prices.db + events.jsonl. Muestra lo que el usuario final ve.
"""

import json
import os
import sqlite3
from collections import defaultdict

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

data = {
    "generated": max((r[0] for s in series.values() for r in s), default=""),
    "n_products": len(products),
    "n_stockout": sum(1 for r in latest.values() if not r["in_stock"]),
    "products": products, "series": series, "events": events,
    "mis": mis, "ofertas": ofertas, "clubs": clubs,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(os.path.join(ROOT, "scripts", "template.html"),
          encoding="utf-8") as f:
    html = f.read().replace("__DATA__", json.dumps(data, ensure_ascii=False))
with open(OUT, "w", encoding="utf-8") as f:
    f.write(html)
print(f"Dashboard: {OUT}")
