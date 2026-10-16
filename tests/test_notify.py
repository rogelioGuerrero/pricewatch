"""Tests de notify.py — sobre todo la dedup multi-club de load_events
(bug corregido: agotado en N clubes debe llegar N veces al digest)."""

import json
import sqlite3
from datetime import date

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


# ---------- catalog_state ----------

def _prices_db(tmp_path, rows, prods=None):
    db = tmp_path / "prices.db"
    con = sqlite3.connect(db)
    con.execute("create table products (sku text, title text, image text)")
    con.execute("""create table prices (sku text, date text, price int,
                   sign_price int, saving real, in_stock int)""")
    for p in prods or []:
        con.execute("insert into products values (?,?,?)", p)
    con.executemany("insert into prices values (?,?,?,?,?,?)", rows)
    con.commit()
    con.close()
    return str(db)


def test_catalog_state_last_ch_es_fecha_del_cambio(tmp_path, monkeypatch):
    """last_ch debe ser la fecha del ultimo CAMBIO de precio, no la de
    la ultima lectura (bug: usaba last['date'])."""
    db = _prices_db(tmp_path, [
        ("A", "2026-10-10", 900, 900, 0, 1),
        ("A", "2026-10-11", 500, 500, 0, 1),   # ultimo cambio real
        ("A", "2026-10-14", 500, 500, 0, 1),   # ultima lectura
    ], prods=[("A", "prod A", "")])
    monkeypatch.setattr(notify, "DB", db)
    cat, indice = notify.catalog_state()
    assert cat["A"]["last_ch"] == "2026-10-11"
    assert cat["A"]["n_ch"] == 1
    esperado = (date.fromisoformat(notify.TODAY)
                - date(2026, 10, 11)).days
    assert cat["A"]["d_ch"] == esperado
    assert indice == 0.0   # 500->500 entre las 2 ultimas


def test_catalog_state_sin_db_devuelve_vacio(tmp_path, monkeypatch):
    monkeypatch.setattr(notify, "DB", str(tmp_path / "nada.db"))
    assert notify.catalog_state() == ({}, None)


def test_catalog_state_db_sin_tablas_no_explota(tmp_path, monkeypatch):
    db = tmp_path / "vacia.db"
    sqlite3.connect(db).close()   # existe pero sin tablas
    monkeypatch.setattr(notify, "DB", str(db))
    assert notify.catalog_state() == ({}, None)


# ---------- build_alerts ----------

def test_build_alerts_completo():
    cat = {s: {"in_stock": True, "price": p, "title": "t" + s}
           for s, p in {"A": 900, "B": 800, "C": 500, "D": 900,
                        "E": 650, "F": 300}.items()}
    cat["G"] = {"in_stock": False, "price": 500, "title": "tG"}
    events = [
        {"sku": "A", "type": "bajo", "title": "tA", "from": 1000,
         "to": 900, "pct": -10.0},
        {"sku": "B", "type": "oferta", "title": "tB", "price": 800},
        {"sku": "D", "type": "bajo", "title": "tD", "from": 1000,
         "to": 900, "pct": -10.0},
        {"sku": "E", "type": "rebaja", "title": "tE", "from": 1000,
         "to": 650, "pct": -35.0},
        {"sku": "F", "type": "se_agota", "title": "tF", "price": 300,
         "club": "santa-ana", "qty_to": 3},
        # ajuste de catalogo sin stock: nunca fue comprable, no alerta
        {"sku": "G", "type": "bajo", "title": "tG", "from": 1000,
         "to": 500, "pct": -50.0},
    ]
    a = notify.build_alerts(events, cat, {"A", "B", "C", "F"},
                            {"C": 5.0}, {"D": 950})
    assert [e["sku"] for e in a["fav_drop"]] == ["A"]
    assert [e["sku"] for e in a["fav_oferta"]] == ["B"]
    assert [e["sku"] for e in a["fav_resurtir"]] == ["C"]
    assert [e["sku"] for e in a["tgt_hit"]] == ["D"]  # 1000 > 950 >= 900
    assert [e["sku"] for e in a["big_rebaja"]] == ["E"]
    assert [e["sku"] for e in a["fav_drain"]] == ["F"]
    assert a["drain"] == {"F": ["santa-ana"]}
    assert "G" not in [e["sku"] for e in a["drops"]]


# ---------- digest_html ----------

def _alertas_vacias():
    a = {k: [] for k in ("fav_drop", "fav_oferta", "fav_out",
                         "fav_resurtir", "tgt_hit", "big_rebaja",
                         "fav_drain", "fav_clubout", "fav_clubback",
                         "fav_back", "drops")}
    a["drain"] = {}
    return a


def test_digest_html_escapa_html_y_renderiza_secciones():
    cat = {"A": {"title": "prod A", "image": "", "price": 500,
                 "saving": 0, "in_stock": True, "min": 500, "max": 900,
                 "n_ch": 1, "last_ch": "2026-10-10", "d_ch": 4}}
    a = _alertas_vacias()
    a["drops"] = [{"sku": "A", "type": "bajo", "title": "<b>&</b><script>",
                   "from": 900, "to": 500, "pct": -44.4}]
    html = notify.digest_html(
        "2026-10-14", {"bajaron": 1}, a, a["drops"], [], [], cat, {},
        None, [], aw_down=True)
    assert "<b>&</b><script>" not in html
    assert "&lt;b&gt;&amp;&lt;/b&gt;&lt;script&gt;" in html
    assert "Appwrite" in html
    # dia quieto con todo vacio tambien renderiza sin error
    html2 = notify.digest_html(
        "2026-10-14", {}, _alertas_vacias(), [], [], [], cat, {},
        None, [])
    assert "PriceWatch" in html2
