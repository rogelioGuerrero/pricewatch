"""Replay del golden de veredictos (tests/fixtures/verdicts_golden.json):
el refactor a verdicts.py debe producir EXACTAMENTE las salidas
volcadas con el codigo pre-extraccion, tanto en compute_agg como en
notify.catalog_state con TODAY fijado."""
import json
import os
import sqlite3
from datetime import date, timedelta

import build_site
import notify
import verdicts

FIXTURE = os.path.join(os.path.dirname(__file__),
                       "fixtures", "verdicts_golden.json")
GOLDEN = json.load(open(FIXTURE, encoding="utf-8"))


def _prices_db(path, case):
    con = sqlite3.connect(path)
    con.execute("create table products (sku text, title text,"
                " image text)")
    con.execute("""create table prices (sku text, date text,
                   price int, sign_price int, saving real,
                   in_stock int)""")
    for sku in case["series"]:
        con.execute("insert into products values (?,?,?)",
                    (sku, f"Prod {sku}", f"img-{sku}"))
    for sku, rows in case["series"].items():
        for r in rows:
            con.execute("insert into prices values (?,?,?,?,?,?)",
                        (sku, r[0], r[1], r[1],
                         r[3] if len(r) > 3 else 0, r[2]))
    con.commit()
    con.close()


def _cases():
    return [(c["name"], c) for c in GOLDEN["cases"]]


def test_compute_agg_golden():
    for name, c in _cases():
        got = verdicts.compute_agg(c["series"], c["latest"])
        assert got == c["compute_agg"], name


def test_compute_agg_reexported():
    # los tests existentes importan build_site.compute_agg
    assert build_site.compute_agg is verdicts.compute_agg


def test_catalog_state_golden(tmp_path, monkeypatch):
    monkeypatch.setattr(notify, "TODAY", GOLDEN["meta"]["today"])
    for name, c in _cases():
        db = str(tmp_path / (name + ".db"))
        _prices_db(db, c)
        monkeypatch.setattr(notify, "DB", db)
        state, indice = notify.catalog_state()
        assert {"state": state, "indice": indice} == \
            c["catalog_state"], name


def test_catalog_state_missing_db(monkeypatch):
    monkeypatch.setattr(notify, "DB", "nope/prices.db")
    assert notify.catalog_state() == ({}, None)


def test_catalog_state_at_min_parity(tmp_path, monkeypatch):
    """at_min del digest = price_verdict sobre la historia COMPLETA;
    el front evalua la misma regla sobre la serie exportada a 90d —
    divergencia aceptada: notify ve mas filas."""
    monkeypatch.setattr(notify, "TODAY", GOLDEN["meta"]["today"])
    for name, c in _cases():
        db = str(tmp_path / ("p-" + name + ".db"))
        _prices_db(db, c)
        monkeypatch.setattr(notify, "DB", db)
        state, _ = notify.catalog_state()
        agg = verdicts.compute_agg(c["series"], c["latest"])
        for sku in c["series"]:
            a = agg.get(sku)
            rows = [r + [0] * (4 - len(r)) for r in c["series"][sku]]
            v = verdicts.price_verdict(a, rows, GOLDEN["meta"]["today"]) \
                if a else None
            assert state[sku]["at_min"] == bool(v and v.get("at_min")), \
                name + "/" + sku


# ---------- price_verdict: el veredicto estatico que viaja en agg ----------

ROWS = [["2026-11-10", 2000, 1, 0],
        ["2026-11-11", 1500, 1, 0],
        ["2026-11-12", 1000, 1, 0]]
GEN = "2026-11-12"


def test_price_verdict_at_min_y_score():
    # en el piso, 2 cambios, ultimo cambio hoy -> at_min; el score es
    # el max de ahorro declarado / vs max / -vs_med (misma formula que
    # tenia PWData.score): from_max = (2000-1000)/2000 = 0.5
    a = {"pct_min": 0, "n_ch": 2, "last_ch": GEN, "max": 2000,
         "vs_med": -33}
    assert verdicts.price_verdict(a, ROWS, GEN) == \
        {"at_min": True, "score": 0.5}


def test_price_verdict_cambio_vencido_30d():
    a = {"pct_min": 0, "n_ch": 2, "last_ch": "2026-10-10",
         "max": 2000, "vs_med": -33}
    v = verdicts.price_verdict(a, ROWS, GEN)
    assert v == {"score": 0.5}          # sin at_min: 33d > 30d


def test_price_verdict_serie_corta_no_at_min():
    a = {"pct_min": 0, "n_ch": 1, "last_ch": GEN, "max": 2000}
    v = verdicts.price_verdict(a, ROWS[:2], GEN)
    assert "at_min" not in v            # <3 filas como exige el front


def test_price_verdict_sin_movimiento_no_at_min():
    a = {"pct_min": 0, "n_ch": 0, "last_ch": None, "max": 2000}
    v = verdicts.price_verdict(a, ROWS, GEN)
    assert v is None or "at_min" not in v


def test_price_verdict_score_ahorro_declarado():
    # saving en la ultima fila: advertised = saved/(price+saved) con
    # saved en centavos: 250/(1000+250) = 0.2 > from_max 0
    a = {"pct_min": 33, "n_ch": 2, "last_ch": GEN, "max": 1000,
         "vs_med": 0}
    rows = ROWS[:2] + [["2026-11-12", 1000, 1, 2.5]]
    assert verdicts.price_verdict(a, rows, GEN) == {"score": 0.2}


def test_price_verdict_score_vs_med():
    # sin ahorro y price == max: solo queda -vs_med/100 = 0.33 — con
    # historia suficiente (>=5 lecturas validas en >=14d de span)
    a = {"pct_min": 0, "n_ch": 2, "last_ch": GEN, "max": 1000,
         "vs_med": -33}
    rows = [["2026-10-25", 1300, 1, 0], ["2026-10-29", 1200, 1, 0],
            ["2026-11-02", 1100, 1, 0], ["2026-11-08", 1050, 1, 0],
            ["2026-11-12", 1000, 1, 0]]
    v = verdicts.price_verdict(a, rows, GEN)
    assert v["score"] == 0.33


def test_price_verdict_vs_med_sin_historia_no_cuenta():
    # 3 lecturas en 2 dias de span: una mediana de 3 lecturas no es
    # habitualidad, es ruido — el componente vs_med se anula y no hay
    # score que publicar (correccion deliberada: antes daba 0.33)
    a = {"pct_min": 0, "n_ch": 2, "last_ch": GEN, "max": 1000,
         "vs_med": -33}
    rows = ROWS[:2] + [["2026-11-12", 1000, 1, 0]]
    v = verdicts.price_verdict(a, rows, GEN)
    assert v is None or "score" not in v


def test_price_verdict_ancla_falsa_no_puntua():
    # caso ninja: el "descuento" (18799) no le gana ni al pre-subida
    # (18499) — ni el letrero, ni from_max (el max ES el inflado), ni
    # vs_med secuestrado cuentan: score 0, fuera del ranking de gangas
    a = {"pct_min": 1.6, "n_ch": 2, "last_ch": "2026-11-26",
         "max": 21499, "vs_med": -12.6,
         "anch": {"pre": 18499, "pct": 16.2, "d": 6,
                  "rose": "2026-11-20"}}
    rows = [["2026-11-19", 18499, 1, 0], ["2026-11-20", 21499, 1, 0],
            ["2026-11-25", 21499, 1, 0], ["2026-11-26", 18799, 1, 2.0]]
    v = verdicts.price_verdict(a, rows, "2026-11-26")
    assert v is None or "score" not in v


def test_price_verdict_ancla_con_ahorro_real_usa_el_honesto():
    # descuento exagerado: si le gana al pre-subida, el score es el
    # ahorro REAL vs pre — no el inflado vs max (0.25) ni el letrero:
    # (10000-9000)/10000 = 0.1 exactamente
    a = {"pct_min": 5, "n_ch": 2, "last_ch": "2026-11-26",
         "max": 12000, "vs_med": -20,
         "anch": {"pre": 10000, "pct": 20.0, "d": 5,
                  "rose": "2026-11-20"}}
    rows = [["2026-11-15", 10000, 1, 0], ["2026-11-20", 12000, 1, 0],
            ["2026-11-26", 9000, 1, 3.0]]
    v = verdicts.price_verdict(a, rows, "2026-11-26")
    assert v["score"] == 0.1


def test_price_verdict_ancla_empate_exacto_no_puntua():
    # hoy cuesta exactamente el pre-subida: ahorro real cero — sin
    # margen para colarse al ranking
    a = {"pct_min": 0, "n_ch": 2, "last_ch": "2026-11-26",
         "max": 12000, "vs_med": -15,
         "anch": {"pre": 10000, "pct": 20.0, "d": 5,
                  "rose": "2026-11-20"}}
    rows = [["2026-11-15", 10000, 1, 0], ["2026-11-20", 12000, 1, 0],
            ["2026-11-26", 10000, 1, 0]]
    v = verdicts.price_verdict(a, rows, "2026-11-26")
    assert v is None or "score" not in v


def test_price_verdict_precio_invalido_sin_score():
    # 0 o None en la ultima fila = sin lectura de precio -> sin score
    a = {"pct_min": 0, "n_ch": 2, "last_ch": GEN, "max": 2000}
    for bad in (0, None):
        rows = ROWS[:2] + [["2026-11-12", bad, 1, 0]]
        v = verdicts.price_verdict(a, rows, GEN)
        assert v == {"at_min": True}, bad


def test_price_verdict_vacio_es_none():
    # precio en su max y encima de la mediana: sin ahorro, sin margen
    # vs max, -vs_med negativo -> score 0 omitido y sin at_min -> None
    a = {"pct_min": 50, "n_ch": 2, "last_ch": GEN, "max": 2000,
         "vs_med": 10}
    rows = ROWS[:2] + [["2026-11-12", 2000, 1, 0]]
    assert verdicts.price_verdict(a, rows, GEN) is None
    assert verdicts.price_verdict(a, [], GEN) is None


# ---------- detect_anchor: ancla inflada pre-Black-Friday ----------
# La firma de la estafa: subida fuerte -> sostenida pocos dias ->
# bajada presentada como oferta. Referencia honesta = maximo de los
# 30d previos al inflado (un regreso a precio ya visto no es ancla).

def _rows(spec):
    """spec: [(start, end, price), ...] -> [(date, price)] diarios."""
    out = []
    for start, end, price in spec:
        d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
        for n in range((d1 - d0).days + 1):
            out.append(((d0 + timedelta(days=n)).isoformat(), price))
    return out


# el caso real que motivo el detector: Ninja Crispi SKU 513177,
# PriceSmart, Black Friday 2026
NINJA = [("2026-11-19", "2026-11-19", 18499),
         ("2026-11-20", "2026-11-25", 21499),
         ("2026-11-26", "2026-11-26", 18799)]


def test_anchor_ninja_caso_real():
    a = verdicts.detect_anchor(_rows(NINJA))
    assert a == {"pre": 18499, "pct": 16.2, "d": 6, "rose": "2026-11-20"}


def test_anchor_ciclo_genuino_de_oferta_no_dispara():
    # normal -> oferta -> vuelve a normal -> bajadita: la "subida"
    # solo regresa al nivel ya visto en la ventana — no es ancla
    rows = _rows([("2026-10-05", "2026-10-28", 1000),
                  ("2026-11-01", "2026-11-03", 800),
                  ("2026-11-04", "2026-11-08", 1000),
                  ("2026-11-09", "2026-11-09", 950)])
    assert verdicts.detect_anchor(rows) is None


def test_anchor_bajada_genuina_no_dispara():
    # precio estable mucho tiempo y baja: no hay subida previa
    rows = _rows([("2026-10-01", "2026-11-10", 1000),
                  ("2026-11-11", "2026-11-12", 850)])
    assert verdicts.detect_anchor(rows) is None


def test_anchor_inflado_largo_es_precio_real():
    # la subida aguanto 15d (>ANCHOR_SPIKE_MAX_D): ya no es maniobra
    rows = _rows([("2026-10-01", "2026-10-20", 1000),
                  ("2026-10-21", "2026-11-04", 1200),
                  ("2026-11-05", "2026-11-06", 1100)])
    assert verdicts.detect_anchor(rows) is None


def test_anchor_subida_bajo_umbral_no_dispara():
    # 4% < ANCHOR_RISE_MIN: ruido, no maniobra
    rows = _rows([("2026-10-15", "2026-11-01", 1000),
                  ("2026-11-02", "2026-11-05", 1040),
                  ("2026-11-06", "2026-11-06", 1010)])
    assert verdicts.detect_anchor(rows) is None


def test_anchor_nacido_en_el_inflado_no_dispara():
    # sin lecturas previas al inflado no hay referencia honesta:
    # silencio, no inventar
    rows = _rows([("2026-11-20", "2026-11-24", 21499),
                  ("2026-11-26", "2026-11-26", 18799)])
    assert verdicts.detect_anchor(rows) is None


def test_anchor_bajada_vencida_no_dispara():
    # el tramo bajo ya dura 31d: dejo de ser "oferta", es el precio
    rows = _rows([("2026-09-20", "2026-10-01", 1000),
                  ("2026-10-02", "2026-10-05", 1200),
                  ("2026-10-06", "2026-11-12", 1100)])
    assert verdicts.detect_anchor(rows) is None


def test_anchor_tramo_actual_alza_no_dispara():
    # la ultima transicion es subida, no bajada: sin oferta que auditar
    rows = _rows([("2026-10-15", "2026-11-01", 1000),
                  ("2026-11-02", "2026-11-05", 1200),
                  ("2026-11-06", "2026-11-06", 1100),
                  ("2026-11-07", "2026-11-07", 1150)])
    assert verdicts.detect_anchor(rows) is None


def test_anchor_huecos_none_no_rompen_el_tramo():
    # un dia sin lectura en medio del inflado (None filtrado antes de
    # llamar) no corta el tramo: las fechas mandan
    rows = [(d, p) for d, p in _rows(NINJA)
            if d != "2026-11-22"]   # hueco en medio del inflado
    a = verdicts.detect_anchor(rows)
    assert a is not None and a["pre"] == 18499


def test_anchor_inflado_en_escalera_limitacion_documentada():
    # v1 no fusiona pasos ascendentes: detecta, pero `pre` queda un
    # paso arriba del verdadero (1100 en vez de 1000) — comportamiento
    # pineado a conciencia, mejorable si aparece en la practica
    rows = _rows([("2026-10-10", "2026-10-31", 1000),
                  ("2026-11-01", "2026-11-02", 1100),
                  ("2026-11-03", "2026-11-05", 1200),
                  ("2026-11-06", "2026-11-06", 1050)])
    a = verdicts.detect_anchor(rows)
    assert a == {"pre": 1100, "pct": 9.1, "d": 3, "rose": "2026-11-03"}


def test_compute_agg_publica_anch_solo_cuando_dispara():
    series = {"A": [list(r) + [1, 0] for r in _rows(NINJA)],
              "B": [list(r) + [1, 0] for r in _rows(
                  [("2026-10-01", "2026-11-10", 1000),
                   ("2026-11-11", "2026-11-26", 850)])]}
    agg = verdicts.compute_agg(series, {})
    assert agg["A"]["anch"] == {"pre": 18499, "pct": 16.2, "d": 6,
                                "rose": "2026-11-20"}
    assert "anch" not in agg["B"]


def test_compute_agg_anch_tolera_none_en_medio():
    rows = [list(r) + [1, 0] for r in _rows(NINJA)]
    rows.insert(3, ["2026-11-22", None, 1, 0])   # lectura perdida
    # ojo: la fila None parte el orden de fechas de _rows — rehacer
    rows = sorted(rows, key=lambda r: r[0])
    agg = verdicts.compute_agg({"A": rows}, {})
    assert agg["A"]["anch"]["pre"] == 18499
