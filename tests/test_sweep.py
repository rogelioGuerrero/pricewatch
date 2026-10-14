"""Tests de la logica de diff de sweep.py (PriceSmart).

Esta es la pieza mas delicada del proyecto: decide que cuenta como
evento (bajada, oferta, agotado, regreso). Un cambio silencioso aqui
corrompe el digest y el dashboard sin que nadie lo note.
"""

import json
from datetime import datetime, timedelta, timezone

import sweep


def prod(price=None, inv="in stock", saving=0, title="X"):
    return {"title": title, "price_SV": price,
            "inventory_SV": inv, "saving_usd": saving}


def types(events):
    return [e["type"] for e in events]


# ---------- _move_type ----------

def test_move_type_bajada_con_letrero():
    assert sweep._move_type(800, 1000, 200) == "bajo"


def test_move_type_rebaja_sin_letrero():
    # rebaja silenciosa: precio cae sin letrero de ahorro (suele ser permanente)
    assert sweep._move_type(800, 1000, 0) == "rebaja"


def test_move_type_subio():
    assert sweep._move_type(1100, 1000, 0) == "subio"


# ---------- diff ----------

def test_diff_bajada_emite_bajo():
    prev = {"A": prod(1000, saving=200)}
    cur = {"A": prod(800, saving=400)}
    ev = sweep.diff(prev, cur, "2026-10-14")
    assert ("bajo", -20.0) in [(e["type"], e.get("pct")) for e in ev]


def test_diff_rebaja_silenciosa():
    prev = {"A": prod(1000)}
    cur = {"A": prod(700)}
    ev = sweep.diff(prev, cur, "2026-10-14")
    assert types(ev) == ["rebaja"]
    assert ev[0]["pct"] == -30.0


def test_diff_jitter_menor_1pct_no_es_evento():
    prev = {"A": prod(1000)}
    cur = {"A": prod(995)}   # -0.5%
    assert sweep.diff(prev, cur, "2026-10-14") == []


def test_diff_agotado():
    prev = {"A": prod(1000)}
    cur = {"A": prod(1000, inv="out of stock")}
    assert types(sweep.diff(prev, cur, "2026-10-14")) == ["agotado"]


def test_diff_reaparecio_fusiona_precio():
    """Vuelta de stock + cambio de precio = UN solo evento."""
    prev = {"A": prod(1000, inv="out of stock")}
    cur = {"A": prod(800)}
    ev = sweep.diff(prev, cur, "2026-10-14",
                    last_in={"A": "2026-10-01"})
    assert types(ev) == ["reaparecio"]
    assert ev[0]["from"] == 1000 and ev[0]["to"] == 800
    assert ev[0]["pct"] == -20.0
    assert ev[0]["days_out"] == 13


def test_diff_nuevo_vs_regreso():
    """Un SKU conocido que vuelve al catalogo es 'regreso', no 'nuevo'."""
    cur = {"A": prod(500), "B": prod(300)}
    last = {"B": (400, "2026-10-01")}
    ev = sweep.diff({}, cur, "2026-10-14", known={"B"}, last=last)
    por_sku = {e["sku"]: e for e in ev}
    assert por_sku["A"]["type"] == "nuevo"
    assert por_sku["B"]["type"] == "regreso"
    assert por_sku["B"]["days_out"] == 13


def test_diff_regreso_con_cambio_precio():
    cur = {"B": prod(300)}
    last = {"B": (400, "2026-10-01")}
    ev = sweep.diff({}, cur, "2026-10-14", known={"B"}, last=last)
    assert ev[0]["type"] == "regreso"
    assert ev[0]["pct"] == -25.0


def test_diff_salio_del_catalogo():
    prev = {"A": prod(1000)}
    assert types(sweep.diff(prev, {}, "2026-10-14")) == ["salio_del_catalogo"]


def test_diff_oferta_termino_por_reversion():
    """El precio sube hasta el regular (lo que costaba sin letrero):
    no es 'subio', termino la oferta. Un solo evento."""
    prev = {"A": prod(800, saving=200)}   # regular 1000
    cur = {"A": prod(1000, saving=0)}
    ev = sweep.diff(prev, cur, "2026-10-14")
    assert types(ev) == ["oferta_termino"]


def test_diff_oferta_nueva_mismo_precio():
    prev = {"A": prod(1000, saving=0)}
    cur = {"A": prod(1000, saving=150)}
    ev = sweep.diff(prev, cur, "2026-10-14")
    assert types(ev) == ["oferta"]


# ---------- prune_log ----------

def _sv(days_ago=0):
    return (datetime.now(timezone(timedelta(hours=-6))).date()
            - timedelta(days=days_ago)).isoformat()


def test_prune_log_recorta_y_descarta_corruptos(tmp_path, monkeypatch):
    log = tmp_path / "events.jsonl"
    reciente = {"date": _sv(1), "sku": "A", "type": "bajo"}
    viejo = {"date": _sv(100), "sku": "B", "type": "bajo"}
    log.write_text(
        json.dumps(reciente) + "\n"
        + json.dumps(viejo) + "\n"
        + "linea corrupta {{{\n",
        encoding="utf-8")
    monkeypatch.setattr(sweep, "EVENTS_LOG", str(log))
    sweep.prune_log()
    lines = log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["sku"] == "A"


def test_prune_log_sin_archivo_no_falla(tmp_path, monkeypatch):
    monkeypatch.setattr(sweep, "EVENTS_LOG",
                        str(tmp_path / "inexistente.jsonl"))
    sweep.prune_log()   # no-op, sin excepcion
