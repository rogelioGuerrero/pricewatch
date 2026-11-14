"""
build_site.py - Genera docs/index.html (dashboard estatico) desde
prices.db + events.jsonl. Muestra lo que el usuario final ve.

Modular: compute_agg / build_siman_payload / build_site son testeables
sin tocar el filesystem del repo; main() solo corre bajo __main__.
"""

import json
import math
import os
import sqlite3
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from common import SV_TZ, read_events, talla_hit
from data_health import inspect_data

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ajustes de catalogo: precio movido sobre articulo sin stock ese dia —
# el front y notify.py los ocultan; el conteo queda en el log del build
# para que el filtro sea auditable (si revienta, se nota aqui)
PRICE_TYPES = ("bajo", "subio", "oferta", "oferta_termino", "rebaja")


def _stock_on(series, sku, dt):
    st = None
    for r in series.get(sku, []):
        if r[0] <= dt:
            st = r[2]
        else:
            break
    return st


def compute_agg(series, latest):
    """Agregados historicos por sku: min/max/med, n de cambios, racha
    de agotado, cadencia de ofertas — lo que pricesmart.com no muestra.
    `series`: {sku: [[date, price, in_stock, saving?], ...]} asc;
    `latest`: {sku: fila} del ultimo dia (para el flag de temporada)."""
    # el payload recorta filas a 3 cols cuando no hay ahorro; pad a 4
    # para que los indices [3] no revienten en series recortadas
    series = {s: [r + [0] * (4 - len(r)) for r in v]
              for s, v in series.items()}
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
        n_out = sum(1 for i in range(1, len(s))
                    if s[i - 1][2] and not s[i][2])
        # cadencia de ofertas: inicios de episodio con letrero de ahorro
        of_starts = [s[i][0] for i in range(1, len(s))
                     if (s[i][3] or 0) > 0 and not (s[i - 1][3] or 0)]
        gaps = [(date.fromisoformat(b) - date.fromisoformat(a)).days
                for a, b in zip(of_starts, of_starts[1:])]
        last_of = next((r[0] for r in reversed(s) if (r[3] or 0) > 0),
                       None)
        saves = [r[3] for r in s if (r[3] or 0) > 0]
        # racha de letrero activa (of_cur) y ultima ya terminada (of_end)
        run = None
        last_run = None
        for i, r in enumerate(s):
            if (r[3] or 0) > 0:
                if run is None:
                    run = r[0]
            elif run is not None:
                last_run = [run, s[i - 1][0]]
                run = None
        agg[sku] = {
            "min": min_p, "max": max_p, "med": round(med),
            "pct_min": (round((last_p - min_p) / min_p * 100, 1)
                        if min_p else None),
            "vs_med": (round((last_p - med) / med * 100, 1)
                       if med else None),
            "n_ch": n_ch, "last_ch": last_ch,
            "d_out": d_out if not s[-1][2] else 0,
            "pct_stock": round(sum(1 for r in s if r[2]) / len(s) * 100),
            "n_out": n_out,
            "n_of": len(of_starts),
            "of_every": round(statistics.median(gaps)) if gaps else None,
            "of_last": ((date.fromisoformat(s[-1][0])
                         - date.fromisoformat(last_of)).days
                        if last_of else None),
            "of_save": (round(statistics.median(saves), 2)
                        if saves else None),
            "of_cur": run, "of_end": last_run,
            # vida corta y ya salio del catalogo = producto de temporada
            "temp": (sku not in latest
                     and (date.fromisoformat(s[-1][0])
                          - date.fromisoformat(s[0][0])).days < 60)
                    or None,
        }
    return agg


def build_siman_payload(siman_db, siman_events, watchlist, gen_date):
    """Bloque 'siman' del payload: items vivos (vistos <=14d de
    `gen_date`), eventos recientes y las busquedas vigiladas."""
    # ---- Siman (VTEX): radar de ofertas reales por busqueda ----
    # La unidad vigilada es la busqueda (marca/tipo); el itemId es
    # efimero (Siman recodifica). Alerta = precio rompe su propio
    # minimo historico.
    siman = {"items": [], "events": [], "n_items": 0, "watches": [],
             "generated": "", "coverage": []}
    has_memberships = False
    memberships = defaultdict(list)
    if os.path.exists(siman_db):
        sc = sqlite3.connect(siman_db)
        sc.row_factory = sqlite3.Row
        try:
            sitems = {r["itemId"]: dict(r)
                      for r in sc.execute("SELECT * FROM items")}
            siman["generated"] = sc.execute(
                "SELECT MAX(date) FROM prices").fetchone()[0] or ""
            tables = {r[0] for r in sc.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")}
            if "sweep_runs" in tables:
                run = sc.execute(
                    "SELECT date, coverage FROM sweep_runs "
                    "ORDER BY date DESC LIMIT 1").fetchone()
                if run:
                    siman["generated"] = run["date"]
                    siman["coverage"] = [
                        {"max_products": row["max_products"]}
                        for row in json.loads(run["coverage"])]
            if "watch_memberships" in tables:
                has_memberships = True
                for r in sc.execute(
                        "SELECT itemId, q, talla FROM watch_memberships "
                        "WHERE observed_at = ?", (siman["generated"],)):
                    memberships[r["itemId"]].append(
                        {"q": r["q"], "talla": r["talla"]})
            # frescura ~14d: un itemId no visto es un listing muerto
            # (Siman recodifica) congelado con su ultimo avail — fuera
            # del payload o alertaria como zombie y engordaria el html
            if (gen_date and sitems
                    and "last_seen" in next(iter(sitems.values()))):
                fcut = (date.fromisoformat(gen_date)
                        - timedelta(days=14)).isoformat()
                sitems = {i: it for i, it in sitems.items()
                          if (it.get("last_seen") or "") >= fcut}
                # solo la historia de items vivos: la de los muertos no
                # alimenta ninguna card
                srows = sc.execute(
                    "SELECT * FROM prices WHERE itemId IN "
                    "(SELECT itemId FROM items WHERE last_seen >= ?) "
                    "ORDER BY date", (fcut,))
            else:
                srows = sc.execute("SELECT * FROM prices ORDER BY date")
            sser = defaultdict(list)
            for r in srows:
                if r["itemId"] in sitems:
                    sser[r["itemId"]].append(
                        [r["date"], r["price"], r["avail"], r["list"],
                         r["card"]])
        except sqlite3.OperationalError:
            sitems, sser = {}, defaultdict(list)  # tablas aun no existen
        sc.close()
        siman["events"] = [e for e in read_events(siman_events)
                           if e.get("iid")][-200:]
        groups = defaultdict(list)
        for iid, it in sitems.items():
            s = sser.get(iid, [])
            if not s:
                continue
            watches = (memberships[iid] if has_memberships else
                       [{"q": it.get("watch") or "",
                         "talla": it.get("talla") or ""}])
            for w in watches:
                groups[(it["pid"], w["q"], w["talla"] or "")].append(
                    (iid, it, s))
        prod = []
        for (pid, query, size), variants in groups.items():
            # Pick the requested size before comparing prices. Every price,
            # discount and historical claim below belongs to this same row.
            current = [v for v in variants
                       if v[2][-1][0] == siman["generated"]]
            available = [v for v in current if v[2][-1][2]]
            matching = [v for v in current if talla_hit(v[1]["vname"], size)]
            stocked = [v for v in matching if v[2][-1][2]]
            eligible = [v for v in stocked if _valid_price(v[2][-1][1])]
            candidates = eligible or stocked or matching
            iid, it, s = (min(candidates, key=lambda v:
                              (v[2][-1][1] if _valid_price(v[2][-1][1])
                               else math.inf, v[0]))
                          if candidates else max(variants,
                                                 key=lambda v: v[2][-1][0]))
            last = s[-1]
            price = last[1] if candidates and _valid_price(last[1]) else None
            lp = last[3] if candidates and _valid_price(last[3]) else None
            prev_min = min((x[1] for x in s[:-1] if _valid_price(x[1])),
                           default=None)
            active = bool(eligible)
            prod.append({
                "pid": pid, "iid": iid, "t": it["title"], "b": it["brand"],
                "l": it["link"], "img": it["image"], "w": query,
                "ta": size or None, "p": price, "lp": lp, "ok": bool(stocked),
                "price_cents": round(price * 100) if price is not None else None,
                "currency": "USD",
                "broke": bool(active and prev_min is not None
                              and price < prev_min),
                "decl": bool(active and lp is not None and price < lp),
                "n": len(s), "crd": bool(active and last[4]),
                "avail": bool(available), "last": last[0],
                "current": bool(matching) and last[0] == siman["generated"],
                "ihs": sorted({v[1]["imghash"] for v in variants
                               if v[1].get("imghash")}),
            })
        siman["items"] = sorted(prod,
                                key=lambda x: (not x["broke"], not x["decl"]))
        siman["n_items"] = sum(
            bool(sser.get(i) and sser[i][-1][0] == siman["generated"])
            and (not has_memberships or bool(memberships[i]))
            for i in sitems)
    # Compatibility key only: private watch configuration is never a seed for
    # a new browser/account. Product groups still describe the public radar.
    return siman


def _valid_price(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value > 0)


def build_site(root_dir=ROOT):
    """Construye el payload completo y escribe docs/data.json,
    docs/index.html (desde scripts/template.html) y docs/version.json.
    Devuelve el dict `data`."""
    data_dir = os.path.join(root_dir, "data")
    docs_dir = os.path.join(root_dir, "docs")
    db = os.path.join(data_dir, "prices.db")
    events_path = os.path.join(data_dir, "events.jsonl")
    snap_dir = os.path.join(data_dir, "snapshots")

    products, latest = {}, {}
    series = defaultdict(list)
    clubs = defaultdict(dict)
    clubh = defaultdict(lambda: defaultdict(list))
    if os.path.exists(db):
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        try:
            products = {r["sku"]: dict(r)
                        for r in conn.execute("SELECT * FROM products")}
            # ORDER BY sku,date recorre el indice primario en orden —
            # ORDER BY date solo forzaba un sort completo en memoria
            for r in conn.execute(
                    "SELECT * FROM prices ORDER BY sku, date"):
                series[r["sku"]].append(
                    [r["date"], r["price"], r["in_stock"],
                     r["saving"] or 0])
            for r in conn.execute(
                    "SELECT * FROM prices "
                    "WHERE date = (SELECT MAX(date) FROM prices)"):
                latest[r["sku"]] = dict(r)
        except sqlite3.OperationalError:
            pass  # db recien creada sin tablas
        # Stock por club: última observación por sku (nivel 2 solo corre
        # para candidatos; usar la fecha global MAX(date) borraba el
        # desglose de los que no se chequearon ese día)
        try:
            for r in conn.execute(
                    "SELECT cs.sku, cs.club_name, cs.in_stock, cs.qty, cs.date "
                    "FROM club_stock cs "
                    "JOIN (SELECT sku, MAX(date) AS md FROM club_stock "
                    "      GROUP BY sku) m "
                    "ON cs.sku = m.sku AND cs.date = m.md"):
                clubs[r["sku"]][r["club_name"]] = {
                    "in_stock": bool(r["in_stock"]), "qty": r["qty"],
                    "observed_at": r["date"]}
        except sqlite3.OperationalError:
            pass  # tabla aun no existe
        # Historial reciente de qty por club para la ficha (grafico de
        # trayectoria): ~3 semanas bastan para ver el drenaje sin
        # inflar payload
        try:
            cutoff = (datetime.now(SV_TZ).date()
                      - timedelta(days=21)).isoformat()
            for r in conn.execute(
                    "SELECT sku, club_name, date, qty FROM club_stock "
                    "WHERE date >= ? ORDER BY sku, club_name, date",
                    (cutoff,)):
                clubh[r["sku"]][r["club_name"]].append(
                    [r["date"], r["qty"]])
        except sqlite3.OperationalError:
            pass  # tabla aun no existe
        conn.close()

    events = [e for e in read_events(events_path) if e.get("sku")][-200:]
    n_dead = sum(1 for e in events if e["type"] in PRICE_TYPES
                 and e.get("date")
                 and _stock_on(series, e.get("sku"), e["date"]) == 0)
    if n_dead:
        print(f"  {n_dead} ajustes de catalogo sobre articulos sin stock "
              f"(ocultos en front/email)")

    # Personal purchase history stays on the device/Appwrite, never in Pages.
    # Keep the compatibility field empty; do not alter the private source file.
    mis = []

    # Archivo: el PWA solo embebe productos vistos en los ultimos 45 dias
    # (o referenciados por eventos/compras, para que sus cards tengan
    # titulo). prices.db conserva la historia completa para siempre
    # (deteccion de 'regreso', ficha historica); el payload no se llena
    # de muertos.
    gen = max((r[0] for s in series.values() for r in s), default="")
    coverage = {}
    if gen:
        current_snapshot = os.path.join(snap_dir, gen + ".json")
        if os.path.exists(current_snapshot):
            with open(current_snapshot, encoding="utf-8") as f:
                snapshot = json.load(f)
            observed = snapshot["products"]
            latest = {s: r for s, r in latest.items()
                      if s in observed and not observed[s].get("_carried")}
            coverage = {"failed_categories": snapshot.get("failed_categories", []),
                        "inherited_count": snapshot.get("inherited_count", 0)}
        cutoff = (date.fromisoformat(gen) - timedelta(days=45)).isoformat()
        keep = {s for s, ser in series.items() if ser[-1][0] >= cutoff}
        keep |= {e["sku"] for e in events}
        series = {s: v for s, v in series.items() if s in keep}
        products = {s: p for s, p in products.items() if s in keep}

    agg = compute_agg(series, latest)
    ofertas = [{"sku": s, "saving": r["saving"], "price": r["price"],
                **products.get(s, {})}
               for s, r in latest.items() if (r["saving"] or 0) > 0]

    siman = build_siman_payload(
        os.path.join(data_dir, "siman.db"),
        os.path.join(data_dir, "siman_events.jsonl"),
        os.path.join(data_dir, "watchlist_siman.json"), gen)

    # Indice PriceWatch: % mediano de cambio de precio entre las 2
    # ultimas observaciones = "la inflacion de la tienda" segun
    # nuestros datos
    chg = []
    for s in series.values():
        if len(s) >= 2 and s[-1][1] and s[-2][1]:
            chg.append((s[-1][1] - s[-2][1]) / s[-2][1] * 100)
    indice = round(statistics.median(chg), 2) if chg else None

    # cada serie exportada se acota a ~90d: agg/veredictos arriba ya
    # usaron la historia completa; el front no renderiza nada mas viejo
    # y asi el payload deja de crecer sin tope dia a dia
    if gen:
        scut = (date.fromisoformat(gen) - timedelta(days=90)).isoformat()
        series = {s: [r for r in v if r[0] >= scut]
                  for s, v in series.items()}

    # payload liviano: "sku" es redundante (ya es la llave del objeto) y
    # >90% de los puntos llevan ahorro 0 — el front lee r[3] || 0
    products = {s: {**{k: v for k, v in p.items()
                      if k != "sku" and v not in (None, "")},
                    "observed_at": series[s][-1][0] if series.get(s) else "",
                    "current": s in latest, "currency": "USD"}
                for s, p in products.items()}
    series = {s: [r[:3] if not r[3] else r for r in v]
              for s, v in series.items()}

    # ¿aun hay datos sinteticos del demo? (snapshot marcado o fechas
    # pre-inicio)
    demo = False
    if os.path.isdir(snap_dir):
        for f in os.listdir(snap_dir):
            try:
                with open(os.path.join(snap_dir, f),
                          encoding="utf-8") as fh:
                    if json.load(fh).get("synthetic"):
                        demo = True
                        break
            except Exception:
                pass

    data = {
        "schema_version": 2,
        "quality": inspect_data(data_dir),
        "generated": gen,
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "demo": demo,
        "n_products": len(latest),
        "n_stockout": sum(1 for r in latest.values() if not r["in_stock"]),
        "products": products, "series": series, "events": events,
        "mis": mis, "ofertas": ofertas, "clubs": clubs, "clubh": clubh,
        "agg": agg,
        "indice": indice, "n_cambios_idx": len(chg),
        "siman": siman,
    }
    data["quality"]["sources"]["pricesmart"]["coverage"] = coverage
    out = os.path.join(docs_dir, "index.html")
    os.makedirs(docs_dir, exist_ok=True)
    # payload separado del HTML: el shell (~14 KB) se cachea solo y solo
    # data.json cambia entre builds — antes cada visita bajaba los ~4 MB
    # completos con los datos inline
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(docs_dir, "data.json"), "w",
              encoding="utf-8") as f:
        f.write(payload)
    with open(os.path.join(root_dir, "scripts", "template.html"),
              encoding="utf-8") as f:
        html = f.read()
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    # version.json: ~50 bytes que el PWA consulta (sin pasar por el cache
    # del service worker) para detectar que hay un build mas nuevo
    with open(os.path.join(docs_dir, "version.json"), "w",
              encoding="utf-8") as f:
        json.dump({"built": data["built"]}, f)
    print(f"Dashboard: {out} + data.json ({len(payload) // 1024} KiB)")
    return data


def main():
    build_site()


if __name__ == "__main__":
    main()
