"""Tests del merge por talla de build_siman_payload + record_history.

Casos congelados del lead (verify_data_outputs): un producto con
variantes M/L nunca puede "heredar" el precio o el flag de la talla
pedida desde la otra; cada watch (q,talla) es un grupo aparte.
"""

import json
import sqlite3
from unittest.mock import patch

import build_site as bs
import common
import pytest
import sweep_siman as sm


def variant(iid, size, price, *, list_=None, available=True,
            watches=None, card=False, qty=None):
    return {"iid": iid, "pid": "P1", "title": "Fixture shirt",
            "brand": "Fixture", "link": "https://example.invalid/p1",
            "image": "", "vname": size, "watch": "shirt",
            "talla": size, "price": price,
            "list": price if list_ is None else list_,
            "qty": int(available) if qty is None else qty,
            "avail": available, "card": card,
            "watches": watches if watches is not None
            else [{"q": "shirt", "talla": size}]}


def payload(db, today="2026-11-11"):
    return bs.build_siman_payload(str(db), str(db.parent / "ev.jsonl"),
                                  str(db.parent / "w.json"), today)


@pytest.fixture
def db(tmp_path, monkeypatch):
    """siman.db temporal: DB_PATH apuntado por monkeypatch."""
    path = tmp_path / "siman.db"
    monkeypatch.setattr(sm, "DB_PATH", str(path))
    return path


@pytest.mark.parametrize("reverse", [False, True])
def test_talla_pedida_no_hereda_precio_ni_flags(db, reverse):
    """M 20->10, L 30->30, watch L: p=30/3000c, ok, sin broke/decl —
    igual en cualquier orden de iteracion del dict."""
    first = {"M": variant("M", "M", 20), "L": variant("L", "L", 30)}
    second = {"M": {**variant("M", "M", 10), "list": 20},
              "L": variant("L", "L", 30)}
    if reverse:
        first = dict(reversed(list(first.items())))
        second = dict(reversed(list(second.items())))
    sm.record_history(first, "2026-11-10")
    sm.record_history(second, "2026-11-11")
    g = next(x for x in payload(db)["items"] if x["ta"] == "L")
    assert (g["p"], g["price_cents"], g["ok"]) == (30, 3000, True)
    assert not g["broke"] and not g["decl"], g


def test_dos_watches_mismo_item_dos_grupos(db):
    """Membresias M y L simultaneas -> un grupo por talla pedida."""
    sm.record_history(
        {"M": variant("M", "M", 20), "L": variant("L", "L", 30)},
        "2026-11-10")
    both = [{"q": "shirt", "talla": "M"}, {"q": "shirt", "talla": "L"}]
    second = {"M": {**variant("M", "M", 10, watches=both), "list": 20},
              "L": variant("L", "L", 30, watches=both)}
    sm.record_history(second, "2026-11-11", watches=both)
    groups = {x["ta"]: x for x in payload(db)["items"]}
    assert set(groups) == {"M", "L"}
    assert groups["M"]["p"] == 10 and groups["M"]["broke"]
    assert groups["L"]["p"] == 30 and not groups["L"]["broke"]


def test_talla_pedida_sin_stock_no_es_accionable(db):
    """L agotada con M barata disponible: p=30, ok=False, sin flags."""
    sm.record_history(
        {"M": variant("M", "M", 20), "L": variant("L", "L", 30)},
        "2026-11-10")
    both = [{"q": "shirt", "talla": "M"}, {"q": "shirt", "talla": "L"}]
    second = {"M": {**variant("M", "M", 10, watches=both), "list": 20},
              "L": variant("L", "L", 30, watches=both, available=False)}
    sm.record_history(second, "2026-11-11", watches=both)
    g = next(x for x in payload(db)["items"] if x["ta"] == "L")
    assert g["p"] == 30, "L agotada nunca toma el precio de M"
    assert not g["ok"] and not g["broke"] and not g["decl"]


def test_talla_pedida_sin_precio_no_pide_prestado(db):
    """L con price None + M a 10: nada de precio ni ganga prestada."""
    sm.record_history(
        {"M": variant("M", "M", 20), "L": variant("L", "L", 30)},
        "2026-11-10")
    both = [{"q": "shirt", "talla": "M"}, {"q": "shirt", "talla": "L"}]
    second = {"M": {**variant("M", "M", 10, watches=both), "list": 20},
              "L": variant("L", "L", None, watches=both)}
    sm.record_history(second, "2026-11-11", watches=both)
    g = next(x for x in payload(db)["items"] if x["ta"] == "L")
    assert g["p"] is None and g["price_cents"] is None
    assert not g["broke"] and not g["decl"]


def test_rerun_mismo_dia_watch_vacia_limpia_payload(db):
    """Re-run del dia con watchlist vacia: watches/items/n_items 0 —
    mandan las membresias activas, no filas viejas del historial."""
    sm.record_history({"M": variant("M", "M", 20)}, "2026-11-10")
    sm.record_history({"M": variant("M", "M", 10)}, "2026-11-11")
    sm.record_history({}, "2026-11-11", watches=[])
    out = payload(db)
    assert out["watches"] == []
    assert out["items"] == [] and out["n_items"] == 0
    # historia retenida: las filas siguen en la base
    con = sqlite3.connect(db)
    assert con.execute("SELECT COUNT(*) FROM prices").fetchone()[0] == 2
    con.close()


def test_talla_ausente_no_muestra_precio_de_otra(db):
    """watch pide XL, el item es M: grupo XL sin variante -> p None."""
    sm.record_history(
        {"M": variant("M", "M", 20, watches=[
            {"q": "shirt", "talla": "M"}, {"q": "shirt", "talla": "XL"}]),
         "L": variant("L", "L", 30, watches=[{"q": "shirt", "talla": "L"}])},
        "2026-11-11",
        watches=[{"q": "shirt", "talla": "M"},
                 {"q": "shirt", "talla": "XL"},
                 {"q": "shirt", "talla": "L"}])
    groups = {x["ta"]: x for x in payload(db)["items"]}
    assert groups["XL"]["p"] is None
    assert groups["XL"]["price_cents"] is None


def test_observacion_vieja_no_es_current_si_el_run_es_nuevo(db):
    """Run 11-11 re-listo la membresia pero el precio quedo en 11-10:
    el item sigue en el grupo pero current=False y sin precio fresco."""
    sm.record_history({"M": variant("M", "M", 20)}, "2026-11-10")
    con = sqlite3.connect(db)
    con.execute("INSERT INTO sweep_runs VALUES (?,?,?)",
                ("2026-11-11", json.dumps([{"q": "shirt", "talla": "M"}]),
                 "[]"))
    con.execute("INSERT OR REPLACE INTO watch_memberships "
                "VALUES (?,?,?,?,?)",
                ("M", "shirt", "M", "", "2026-11-11"))
    con.commit()
    con.close()
    g = next(x for x in payload(db)["items"] if x["ta"] == "M")
    assert g["current"] is False
    assert g["last"] == "2026-11-10"


def test_membresias_de_dos_queries_se_conservan(db):
    """El mismo item listado por dos busquedas produce dos grupos."""
    both = [{"q": "camisa", "talla": "M"}, {"q": "shirt", "talla": "M"}]
    sm.record_history(
        {"M": variant("M", "M", 10, watches=both)},
        "2026-11-11", watches=both)
    ws = sorted(x["w"] for x in payload(db)["items"])
    assert ws == ["camisa", "shirt"]


# ---------------- watches_remote / load_watches ----------------

def test_remote_vacio_exitoso_no_cae_a_semilla_local(db, tmp_path,
                                                   monkeypatch):
    """[] remoto valido se respeta: no se usa el seed del archivo."""
    wf = tmp_path / "watchlist_siman.json"
    wf.write_text(json.dumps([{"q": "seed", "talla": "L"}]))
    monkeypatch.setattr(sm, "WATCH_FILE", str(wf))
    with patch.object(sm, "aw_env", return_value=("f", "p", "k")), \
            patch.object(sm, "aw_rows", return_value=[]):
        assert sm.load_watches() == []


def test_remote_error_propaga_sin_mutar_local(db, tmp_path, monkeypatch):
    """Error de lectura configurada -> RuntimeError, archivo intacto."""
    wf = tmp_path / "watchlist_siman.json"
    seed = json.dumps([{"q": "seed", "talla": "L"}])
    wf.write_text(seed)
    monkeypatch.setattr(sm, "WATCH_FILE", str(wf))
    def boom(*a, **kw):
        raise common.AppwriteReadError("caido")
    with patch.object(sm, "aw_env", return_value=("f", "p", "k")), \
            patch.object(sm, "aw_rows", side_effect=boom):
        with pytest.raises(RuntimeError):
            sm.load_watches()
    assert wf.read_text() == seed


def test_sin_config_usa_fallback_de_archivo(db, tmp_path, monkeypatch):
    wf = tmp_path / "watchlist_siman.json"
    wf.write_text(json.dumps([{"q": "local", "talla": "M"}]))
    monkeypatch.setattr(sm, "WATCH_FILE", str(wf))
    with patch.object(sm, "aw_env", return_value=(None, None, None)):
        assert sm.load_watches() == [{"q": "local", "talla": "M"}]


def test_sin_config_sin_archivo_lista_vacia(db, tmp_path, monkeypatch):
    monkeypatch.setattr(sm, "WATCH_FILE",
                        str(tmp_path / "nope.json"))
    with patch.object(sm, "aw_env", return_value=(None, None, None)):
        assert sm.load_watches() == []
