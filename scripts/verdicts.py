"""
verdicts.py - Logica de veredictos de catalogo compartida entre
build_site.py (agregados del dashboard) y notify.py (digest/push).

Fase 1: extraccion SIN cambiar comportamiento. Las divergencias entre
la lectura del sitio y la del digest quedan fijadas en
tests/fixtures/verdicts_golden.json (min/max sobre precio 0, n_ch con
saltos a/desde None, in_stock con fecha de hoy, historia completa).
"""

import statistics
from datetime import date, timedelta

# Detector de ancla inflada: la estafa pre-Black-Friday de subir el
# precio unos dias para que la bajada posterior luzca como descuento.
# Lo corto de la maniobra es justamente lo que la delata.
ANCHOR_RISE_MIN = 5.0     # subida minima (%) para sospechar ancla
ANCHOR_SPIKE_MAX_D = 14   # techo de duracion del inflado (dias)
ANCHOR_DROP_MAX_D = 30    # la bajada deja de ser "oferta" tras 30d
ANCHOR_BASE_D = 30        # ventana de referencia previa al inflado


def detect_anchor(rows):
    """Ancla inflada (oferta falsa): subida fuerte sostenida POCOS
    dias seguida de bajada presentada como descuento. `rows`:
    [(date, price)] asc, solo precios validos (>0).

    La referencia honesta es el MAXIMO de los ANCHOR_BASE_D dias
    previos al inflado, no el tramo inmediatamente anterior: el ciclo
    genuino de oferta (normal -> oferta -> vuelve a normal) no
    dispara porque la "subida" solo regresa a un nivel ya visto en la
    ventana. Limitacion v1: inflados en escalera (varios pasos
    ascendentes) se detectan pero `pre` queda un paso arriba del
    verdadero; bajadas en varios pasos no se detectan.
    Devuelve {pre, pct, d, rose} — solo hechos con fechas: la
    gravedad la evalua el front comparando pre vs el precio actual."""
    if len(rows) < 3:
        return None
    runs = []  # [price, start, end] por tramo de precio constante
    for d, p in rows:
        if runs and runs[-1][0] == p:
            runs[-1][2] = d
        else:
            runs.append([p, d, d])
    if len(runs) < 2:
        return None
    cur, spike = runs[-1], runs[-2]
    if cur[0] >= spike[0]:
        return None  # el tramo actual no es una bajada
    def days(r):
        return (date.fromisoformat(r[2])
                - date.fromisoformat(r[1])).days + 1
    if days(spike) > ANCHOR_SPIKE_MAX_D:
        return None  # aguanto demasiado: ya era su precio real
    if days(cur) > ANCHOR_DROP_MAX_D:
        return None  # la bajada es vieja: ya es el precio normal
    spike_start = date.fromisoformat(spike[1])
    cut = spike_start - timedelta(days=ANCHOR_BASE_D)
    base = [p for d, p in rows
            if cut <= date.fromisoformat(d) < spike_start]
    if not base:
        return None  # nacio dentro del inflado: sin referencia honesta
    pre = max(base)
    if spike[0] < pre * (1 + ANCHOR_RISE_MIN / 100):
        return None  # no supera lo ya visto: no hay inflado que anclar
    return {"pre": pre,
            "pct": round((spike[0] - pre) / pre * 100, 1),
            "d": days(spike), "rose": spike[1]}


def series_stats(rows):
    """Primitivas sobre una serie [(date, price), ...] asc por fecha.

    Devuelve (prices, changes):
    - prices: los valores tal cual; los consumidores descartan
      precios no positivos (decision de fase 2: 0/None no es lectura
      valida, la regla que notify ya aplicaba con falsy).
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
        # <=0 o ausente no es precio observado (misma regla que
        # catalog_state: era la divergencia #1, resuelta a favor de
        # notify — un 0 de parseo no puede ser el minimo)
        prices = [p for p in raw_prices if p is not None and p > 0]
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
        # ancla inflada: solo viaja cuando se detecta (es rara y el
        # objeto cuesta bytes por sku — misma dieta que saving=0)
        anch = detect_anchor([(r[0], r[1]) for r in s
                              if r[1] is not None and r[1] > 0])
        if anch:
            agg[sku]["anch"] = anch
    return agg


def price_verdict(agg_entry, series_rows, generated):
    """Veredicto estatico de precio (schema 3): lo que el front ya no
    recalcula. Replica EXACTA de atMin()/PWData.score SIN sus gates de
    cliente (buyable/vigencia los aplica el front al leer):
    - at_min: en el piso, se movio alguna vez, serie exportada >=3
      filas y ultimo cambio a <=30d de `generated` — misma regla que
      atMin() sobre D.agg/D.series/D.generated.
    - score: max(0, ahorro_declarado%, vs_max%, -vs_med/100) con los
      mismos numeros que PWData.score, redondeado a 4 decimales —
      salvo dos correcciones anti-ancla: con `anch` detectada el max y
      la mediana pueden ser el propio inflado (y el letrero es parte
      de la maniobra), asi que solo cuenta el ahorro REAL vs el
      pre-subida; y -vs_med exige la misma historia suficiente del
      front (>=5 lecturas validas en >=14d) porque una mediana de 3
      lecturas no es habitualidad, es ruido.
    Devuelve dict solo con las claves verdaderas (omitidas ahorran
    bytes) o None si no hay nada que publicar."""
    a = agg_entry or {}
    out = {}
    last_ch = a.get("last_ch")
    fresh = bool(last_ch) and bool(generated) and (
        date.fromisoformat(generated)
        - date.fromisoformat(last_ch)).days <= 30
    pct_min = a.get("pct_min")
    if (pct_min is not None and pct_min <= 0
            and (a.get("n_ch") or 0) >= 1
            and len(series_rows) >= 3 and fresh):
        out["at_min"] = True
    last = series_rows[-1] if series_rows else []
    price = last[1] if len(last) > 1 else None
    # mismo criterio que cents(): entero positivo o no hay score
    if isinstance(price, int) and not isinstance(price, bool) \
            and price > 0:
        anch = a.get("anch") or {}
        pre = anch.get("pre")
        if isinstance(pre, int) and not isinstance(pre, bool) \
                and pre > 0:
            # ancla: solo el ahorro real contra el pre-subida — si el
            # "descuento" no le gana ni a eso, score 0 y la ganga
            # inflada desaparece del ranking
            sc = max(0.0, (pre - price) / pre)
        else:
            saved = max(0, last[3] or 0) * 100 if len(last) > 3 else 0
            advertised = saved / (price + saved)
            mx = a.get("max")
            from_max = (mx - price) / mx if mx and mx > 0 else 0
            vm = a.get("vs_med") or 0
            if vm < 0:
                # misma regla de suficiencia del front: >=5 lecturas
                # validas y >=14 dias de span (sobre la serie
                # exportada, como D.series — paridad deliberada)
                val = [r for r in series_rows
                       if len(r) > 1 and isinstance(r[1], int)
                       and not isinstance(r[1], bool) and r[1] > 0]
                span = ((date.fromisoformat(val[-1][0])
                         - date.fromisoformat(val[0][0])).days
                        if len(val) >= 2 else 0)
                if len(val) < 5 or span < 14:
                    vm = 0
            sc = max(0, advertised, from_max, -vm / 100)
        if sc:
            out["score"] = round(sc, 4)
    return out or None
