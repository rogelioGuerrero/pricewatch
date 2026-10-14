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


# ---------- siman_gangas ----------

def _gangas(events, sitems=None, muted=(), seen=()):
    """siman_gangas sin Appwrite: aw_rows devuelve las tablas dadas."""
    tablas = {"siman_muted": [{"tkey": t} for t in muted],
              "siman_seen": [{"tkey": t, "price": p} for t, p in seen]}
    orig = notify.aw_rows
    notify.aw_rows = lambda t: tablas.get(t, [])
    try:
        return notify.siman_gangas(events, sitems or {})
    finally:
        notify.aw_rows = orig


def _sev(iid, tipo, **kw):
    e = {"iid": iid, "type": tipo, "title": "Zapato deportivo"}
    e.update(kw)
    return e


def test_gangas_bajo_sin_price_usa_to_para_seen():
    """'bajo' trae from/to, no 'price': el filtro de ya-visto debe
    comparar contra 'to' — antes re-alertaba lo ya visto cada dia."""
    ev = [_sev("1", "bajo", **{"from": 100.0, "to": 80.0}),
          _sev("2", "bajo", **{"from": 100.0, "to": 95.0})]
    sitems = {"1": {"avail": True}, "2": {"avail": True}}
    seen = [("zapato deportivo", 90.0)]   # visto a $90
    out = _gangas(ev, sitems, seen=seen)
    # iid 1: $80 < $90 visto -> alerta (bajo mas); iid 2: $95 >= $90 -> no
    assert [e["iid"] for e in out] == ["1"]


def test_gangas_list_se_escala_a_centavos():
    """'list' viajaba en dolares y el email lo leia como centavos
    ($1.00 +7900%). Debe escalar igual que price/from/to."""
    ev = [_sev("1", "oferta", price=80.0, list=100.0)]
    out = _gangas(ev, {"1": {"avail": True}})
    assert out[0]["price"] == 8000 and out[0]["list"] == 10000


def test_gangas_no_muta_el_evento_original():
    ev = [_sev("1", "oferta", price=80.0, list=100.0)]
    _gangas(ev, {"1": {"avail": True}})
    assert ev[0]["price"] == 80.0   # el dict de entrada intacto


def test_gangas_agotado_y_talla_ajena_se_filtran():
    ev = [_sev("1", "bajo", **{"from": 100.0, "to": 80.0}),
          _sev("2", "bajo", **{"from": 100.0, "to": 80.0}),
          _sev("3", "bajo", **{"from": 100.0, "to": 80.0})]
    sitems = {"1": {"avail": False},
              "2": {"avail": True, "vname": "42", "talla": "10"},
              "3": {"avail": True, "vname": "10", "talla": "10"}}
    assert [e["iid"] for e in _gangas(ev, sitems)] == ["3"]


def test_gangas_muted_se_filtra():
    ev = [_sev("1", "bajo", **{"from": 100.0, "to": 80.0})]
    out = _gangas(ev, {"1": {"avail": True}},
                  muted=("zapato deportivo",))
    assert out == []
