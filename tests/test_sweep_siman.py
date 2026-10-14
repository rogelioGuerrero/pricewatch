"""Tests de normalizacion, tallas y diff de sweep_siman.py (Siman/VTEX)."""

import json
from datetime import datetime, timedelta, timezone

import sweep_siman as sm


def item(iid, title, price=100.0, lst=None, avail=True):
    return {"iid": iid, "title": title, "price": price,
            "list": lst, "avail": avail, "vname": "U"}


def types(events):
    return [e["type"] for e in events]


# ---------- norm / tkey ----------

def test_norm_quita_tildes_y_simbolos():
    assert sm.norm("Camisa Azúl XL!!") == "camisa azul xl"
    assert sm.tkey("TÊNIS NIKE — Air") == "tenis nike air"


# ---------- talla_hit ----------

def test_talla_hit_formatos():
    assert sm.talla_hit("36X32", "36")        # talla x largo
    assert sm.talla_hit("BLUE:38", "38")      # color:talla
    assert sm.talla_hit("NAVY:L", "L")
    assert sm.talla_hit("U", None)            # sin talla pedida: todo pasa


def test_talla_hit_token_exacto():
    assert sm.talla_hit("110", "11") is False   # 11 no vive dentro de 110
    assert sm.talla_hit("11", "11") is True


# ---------- diff ----------

def test_diff_bajo_y_subio_con_umbral():
    prev = {"1": item("1", "Zapato", price=100.0)}
    cur = {"1": item("1", "Zapato", price=80.0)}
    ev = sm.diff(prev, cur, "2026-10-14", set())
    assert ev[0]["type"] == "bajo" and ev[0]["pct"] == -20.0


def test_diff_jitter_menor_1pct_ignorado():
    prev = {"1": item("1", "Zapato", price=100.0)}
    cur = {"1": item("1", "Zapato", price=99.5)}
    assert sm.diff(prev, cur, "2026-10-14", set()) == []


def test_diff_recodificado_por_titulo():
    """Listing muere y aparece otro con titulo normalizado igual ->
    'recodificado' enlazado, no salio+nuevo."""
    prev = {"1": item("1", "Licuadora Oster 10V")}
    cur = {"2": item("2", "  LICUADORA oster 10v!!", price=90.0)}
    ev = sm.diff(prev, cur, "2026-10-14", set())
    assert types(ev) == ["recodificado"]
    assert ev[0]["old_iid"] == "1" and ev[0]["iid"] == "2"
    assert ev[0]["prev_price"] == 100.0


def test_diff_recodificado_por_foto():
    """Titulo cambio en el recode: lo rescata el aHash (<=8 bits)."""
    prev = {"1": {**item("1", "Licuadora X"), "imghash": "0000000000000000"}}
    cur = {"2": {**item("2", "Blender Oster"), "imghash": "0000000000000003"}}
    ev = sm.diff(prev, cur, "2026-10-14", set())
    assert types(ev) == ["recodificado"]


def test_diff_salio_y_nuevo_y_regreso():
    prev = {"1": item("1", "Zapato")}
    cur = {"2": item("2", "Camisa"), "3": item("3", "Pantalon")}
    ev = sm.diff(prev, cur, "2026-10-14", known={"3"})
    por_tipo = {e["type"]: e for e in ev}
    assert por_tipo["salio"]["iid"] == "1"
    assert por_tipo["nuevo"]["iid"] == "2"
    assert por_tipo["regreso"]["iid"] == "3"


def test_diff_agotado_reaparecio():
    prev = {"1": item("1", "Zapato", avail=False)}
    cur = {"1": item("1", "Zapato", avail=True)}
    assert types(sm.diff(prev, cur, "2026-10-14", set())) == ["reaparecio"]


def test_diff_oferta_por_list_price():
    prev = {"1": item("1", "Zapato", price=100.0, lst=None)}
    cur = {"1": item("1", "Zapato", price=100.0, lst=130.0)}
    assert types(sm.diff(prev, cur, "2026-10-14", set())) == ["oferta"]


# ---------- prune_log ----------

def _sv(days_ago=0):
    return (datetime.now(timezone(timedelta(hours=-6))).date()
            - timedelta(days=days_ago)).isoformat()


def test_prune_log_recorta(tmp_path, monkeypatch):
    log = tmp_path / "siman_events.jsonl"
    log.write_text(
        json.dumps({"date": _sv(1), "iid": "A", "type": "bajo"}) + "\n"
        + json.dumps({"date": _sv(100), "iid": "B", "type": "bajo"}) + "\n"
        + "corrupta\n",
        encoding="utf-8")
    monkeypatch.setattr(sm, "EVENTS_LOG", str(log))
    sm.prune_log()
    lines = log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["iid"] == "A"
