"""Tests de notify.py — sobre todo la dedup multi-club de load_events
(bug corregido: agotado en N clubes debe llegar N veces al digest)."""

import json

import notify


def _write(path, *events):
    path.write_text(
        "\n".join(json.dumps(e) for e in events) + "\n",
        encoding="utf-8")
    return str(path)


def test_money():
    assert notify.money(1999) == "$19.99"
    assert notify.money(None) == "—"


def test_tkey_espejo_del_frontend():
    assert notify.tkey("Camisa Azúl!!") == "camisa azul"


def test_load_events_multiclub_no_colapsa(tmp_path):
    """Mismo sku+type en clubes distintos: son eventos distintos."""
    log = _write(
        tmp_path / "ev.jsonl",
        {"date": notify.TODAY, "sku": "A", "type": "club_agotado",
         "club": "santa-ana"},
        {"date": notify.TODAY, "sku": "A", "type": "club_agotado",
         "club": "santa-elena"},
        # duplicado exacto (sweep + stock-check): colapsa
        {"date": notify.TODAY, "sku": "A", "type": "club_agotado",
         "club": "santa-ana"},
        # otro type en el mismo sku+club: evento aparte
        {"date": notify.TODAY, "sku": "A", "type": "bajo",
         "club": "santa-ana"},
        # evento sin club (siman, iid en vez de sku)
        {"date": notify.TODAY, "iid": "X1", "type": "recodificado"},
    )
    ev = notify.load_events(log)
    clubs = [e.get("club") for e in ev if e["type"] == "club_agotado"]
    assert sorted(clubs) == ["santa-ana", "santa-elena"]
    assert len(ev) == 4   # 2 club + 1 bajo + 1 recodificado


def test_load_events_solo_hoy(tmp_path):
    log = _write(
        tmp_path / "ev.jsonl",
        {"date": "2020-01-01", "sku": "A", "type": "bajo"},
        {"date": notify.TODAY, "sku": "B", "type": "bajo"},
    )
    assert [e["sku"] for e in notify.load_events(log)] == ["B"]
    assert len(notify.load_events(log, today=False)) == 2


def test_load_events_tolerante_a_corruptos(tmp_path):
    log = tmp_path / "ev.jsonl"
    log.write_text("{{{corrupta\n"
                   + json.dumps({"date": notify.TODAY, "sku": "A",
                                 "type": "bajo"}) + "\n",
                   encoding="utf-8")
    assert len(notify.load_events(str(log))) == 1


def test_load_events_archivo_inexistente(tmp_path):
    assert notify.load_events(str(tmp_path / "nada.jsonl")) == []
