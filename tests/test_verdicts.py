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
