"""
verdicts.py - Logica de veredictos de catalogo compartida entre
build_site.py (agregados del dashboard) y notify.py (digest/push).

Fase 1: extraccion SIN cambiar comportamiento. Las divergencias entre
la lectura del sitio y la del digest quedan fijadas en
tests/fixtures/verdicts_golden.json (min/max sobre precio 0, n_ch con
saltos a/desde None, in_stock con fecha de hoy, historia completa).
"""

import statistics
from datetime import date


def series_stats(rows):
    """Primitivas sobre una serie [(date, price), ...] asc por fecha.

    Devuelve (prices, changes):
    - prices: los valores tal cual. Cada consumidor filtra distinto:
      el agg del sitio descarta solo None, catalog_state de notify
      tambien el 0 (falsy) — divergencia deliberada, ver golden.
    - changes: [(date, prev, cur)] por cada transicion cur != prev
      entre filas consecutivas, INCLUIDOS los saltos a/desde None.
      El 'n_ch' del sitio cuenta solo cambios entre precios validos;
      el 'last_ch' de ambos es siempre changes[-1].date (cualquier dif).
    """
    rows = list(rows)
    prices = [p for _, p in rows]
    changes = [(d, prev, p) for (_, prev), (d, p)
               in zip(rows, rows[1:]) if p != prev]
    return prices, changes


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
        raw_prices, changes = series_stats((r[0], r[1]) for r in s)
        # el sitio filtra SOLO None: un 0 entra al min (y tumba pct_min)
        prices = [p for p in raw_prices if p is not None]
        if not prices:
            continue
        min_p, max_p = min(prices), max(prices)
        med = statistics.median(prices)
        last_p = prices[-1]
        # n_ch cuenta solo cambios entre precios validos (ambos no-None);
        # last_ch es la ultima transicion cualquiera (== notify)
        n_ch = sum(1 for _, po, pn in changes
                   if po is not None and pn is not None)
        last_ch = changes[-1][0] if changes else None
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
