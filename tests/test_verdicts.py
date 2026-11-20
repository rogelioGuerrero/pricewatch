"""Replay del golden de veredictos (tests/fixtures/verdicts_golden.json):
el refactor a verdicts.py debe producir EXACTAMENTE las salidas
volcadas con el codigo pre-extraccion, tanto en compute_agg como en
notify.catalog_state con TODAY fijado."""
import json
import os
import sqlite3

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
    # sin ahorro y price == max: solo queda -vs_med/100 = 0.33
    a = {"pct_min": 0, "n_ch": 2, "last_ch": GEN, "max": 1000,
         "vs_med": -33}
    rows = ROWS[:2] + [["2026-11-12", 1000, 1, 0]]
    v = verdicts.price_verdict(a, rows, GEN)
    assert v["score"] == 0.33


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
