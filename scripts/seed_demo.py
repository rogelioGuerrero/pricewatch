"""
seed_demo.py - Siembra historia sintetica (45 dias) en prices.db para
demostrar el dashboard antes de tener historia real acumulada.

Los precios base y nombres son REALES (del snapshot de hoy); la trayectoria
temporal es inventada. Ejecutar una sola vez; sweep.py --dry regenera
eventos desde los snapshots sinteticos.
"""

import json
import os
import random
import sqlite3
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, "data", "prices.db")
SNAP_DIR = os.path.join(ROOT, "data", "snapshots")
random.seed(42)

snap = json.load(open(os.path.join(SNAP_DIR, "2026-09-19.json")))
products = snap["products"]

# 60 productos variados + la lampara + algunos con ahorro actual
skus = list(products.keys())
random.shuffle(skus)
demo_skus = skus[:60]
if "500388" in products:
    demo_skus.append("500388")
with_save = [s for s, p in products.items() if p.get("saving_usd")][:10]
demo_skus += [s for s in with_save if s not in demo_skus]

conn = sqlite3.connect(DB)
conn.execute("""CREATE TABLE IF NOT EXISTS prices (
    sku TEXT, date TEXT, price INT, sign_price INT, saving REAL,
    in_stock INT, PRIMARY KEY (sku, date))""")
conn.execute("""CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY, title TEXT, brand TEXT, category TEXT, slug TEXT)""")

today = date(2026, 9, 19)
days = [today - timedelta(days=i) for i in range(45, -1, -1)]
paths = {}

for sku in demo_skus:
    p = products[sku]
    conn.execute("INSERT OR REPLACE INTO products VALUES (?,?,?,?,?)",
                 (sku, p.get("title"), p.get("brand"), p.get("category"),
                  p.get("slug")))
    cur = p.get("price_SV") or 1000
    # trayectoria: precio base "viejo", con 1-3 saltos discretos hacia el actual
    n_jumps = random.randint(1, 3)
    jump_days = sorted(random.sample(range(5, 42), n_jumps))
    price_path, prev = [], int(cur * random.choice([1.15, 1.25, 1.35, 1.0, 0.9]))
    for i in range(46):
        if i in jump_days:
            prev = max(100, int(prev * random.choice([0.75, 0.85, 0.9, 1.1, 1.2])))
        price_path.append(prev)
    price_path[-1] = cur  # el ultimo punto = precio real de hoy
    stock_path = [1] * 46
    if random.random() < 0.25:
        a, b = sorted(random.sample(range(10, 44), 2))
        for i in range(a, b):
            stock_path[i] = 0
    stock_path[-1] = int(p.get("inventory_SV") == "in stock")
    for i, d in enumerate(days):
        conn.execute("INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?)",
                     (sku, d.isoformat(), price_path[i], price_path[i],
                     0.0, stock_path[i]))
    paths[sku] = (price_path, stock_path)

# snapshots sinteticos de los 2 dias anteriores (catalogo completo:
# valores de hoy, salvo los demo_skus que usan su trayectoria historica)
for d in days[-3:-1]:
    f = os.path.join(SNAP_DIR, f"{d.isoformat()}.json")
    idx = days.index(d)
    snap_products = {}
    for sku, p in products.items():
        p2 = dict(p)
        if sku in paths:
            pp, sp = paths[sku]
            p2["price_SV"] = pp[idx]
            p2["inventory_SV"] = "in stock" if sp[idx] else "x"
        snap_products[sku] = p2
    json.dump({"date": d.isoformat(), "products": snap_products}, open(f, "w"))

conn.commit()
print(f"Seed: {len(demo_skus)} productos x 46 dias en {DB}")
print(f"Snapshots demo: {days[-3]} y {days[-2]} en {SNAP_DIR}")
