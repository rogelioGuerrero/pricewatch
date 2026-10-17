"""Integrity guards: common.read_events, build_site mis/hist_min y el
dedup multiclub de notify — todo con archivos temporales."""

import json
import os
import sqlite3

import build_site
import notify
from common import read_events


def w(path, *lines):
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


# ---------------- read_events ----------------

def test_read_events_acepta_sku_e_iid(tmp_path):
    p = str(tmp_path / "e.jsonl")
    w(p, json.dumps({"sku": "A", "type": "bajo", "date": "2026-10-16"}),
      json.dumps({"iid": "x1", "type": "nuevo", "date": "2026-10-16"}))
    ev = read_events(p)
    assert [e.get("sku") or e.get("iid") for e in ev] == ["A", "x1"]


def test_read_events_salta_linea_corrupta_y_truncada(tmp_path):
    p = str(tmp_path / "e.jsonl")
    w(p, '{"sku":"A","type":"bajo"',               # truncada
      "no json",
      json.dumps({"sku": "B", "type": "oferta", "date": "2026-10-16"}))
    assert [e["sku"] for e in read_events(p)] == ["B"]


def test_read_events_salta_null_array_escalar(tmp_path):
    p = str(tmp_path / "e.jsonl")
    w(p, "null", "[]", '[{"sku":"A","type":"t","date":"2026-10-16"}]',
      "42", '"texto"',
      json.dumps({"sku": "A", "type": "t", "date": "2026-10-16"}))
    assert len(read_events(p)) == 1


def test_read_events_requiere_id_type_y_fecha(tmp_path):
    p = str(tmp_path / "e.jsonl")
    w(p,
      json.dumps({"type": "bajo", "date": "2026-10-16"}),      # sin id
      json.dumps({"sku": "", "type": "bajo", "date": "2026-10-16"}),
      json.dumps({"sku": "A", "date": "2026-10-16"}),          # sin type
      json.dumps({"sku": "A", "type": "", "date": "2026-10-16"}),
      json.dumps({"sku": "A", "type": "bajo"}),                # sin date
      json.dumps({"sku": "A", "type": "bajo", "date": None}))
    assert read_events(p) == []


def test_read_events_fecha_iso_invalida_fuera(tmp_path):
    p = str(tmp_path / "e.jsonl")
    for bad in ("2026-13-40", "16/10/2026", "2026-10-16T10:00:00",
                "2026-1-5", "manana"):
        w(p, json.dumps({"sku": "A", "type": "t", "date": bad}))
        assert read_events(p) == [], f"{bad} debio saltarse"
    w(p, json.dumps({"sku": "A", "type": "t", "date": "2026-10-16"}))
    assert len(read_events(p)) == 1


def test_read_events_path_inexistente_devuelve_vacio(tmp_path):
    assert read_events(str(tmp_path / "no_existe.jsonl")) == []


def test_read_events_log_mixto_corrupto_solo_validos(tmp_path):
    p = str(tmp_path / "mixto.jsonl")
    lines = []
    for i in range(205):
        lines.append(json.dumps(
            {"sku": f"S{i:03}", "type": "bajo", "date": "2026-10-16"}))
        if i % 10 == 0:
            lines.append("{corrupto")
        if i % 15 == 0:
            lines.append("null")
    w(p, *lines)
    ev = read_events(p)
    assert len(ev) == 205
    assert all(isinstance(e, dict) and e.get("sku") for e in ev)


# ---------------- build_site: mis / hist_min ----------------

def _make_root(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    db = sqlite3.connect(str(data / "prices.db"))
    db.execute("""CREATE TABLE products (
        sku TEXT PRIMARY KEY, title TEXT, brand TEXT, category TEXT,
        slug TEXT, image TEXT)""")
    db.execute("""CREATE TABLE prices (
        sku TEXT, date TEXT, price INT, sign_price INT, saving REAL,
        in_stock INT, PRIMARY KEY (sku, date))""")
    return data, db


def test_build_mis_hist_min_ignora_nones(tmp_path):
    data, db = _make_root(tmp_path)
    db.execute("INSERT INTO products VALUES ('A','Prod A','','','','')")
    for d, pr in (("2026-10-14", None), ("2026-10-15", 1200),
                  ("2026-10-16", 900)):
        db.execute("INSERT INTO prices VALUES (?,?,?,?,?,?)",
                   ("A", d, pr, None, 0, 1))
    db.commit()
    db.close()
    (data / "mis-compras.json").write_text(
        json.dumps([{"sku": "A", "paid": 11.0, "date": "2026-10-10"}]),
        encoding="utf-8")
    _copy_template(tmp_path)
    out = build_site.build_site(str(tmp_path))
    assert out["mis"][0]["hist_min"] == 900


def test_build_mis_hist_min_sin_precios_es_none(tmp_path):
    data, db = _make_root(tmp_path)
    db.execute("INSERT INTO products VALUES ('B','Prod B','','','','')")
    for d in ("2026-10-15", "2026-10-16"):
        db.execute("INSERT INTO prices VALUES (?,?,?,?,?,?)",
                   ("B", d, None, None, 0, 1))
    db.commit()
    db.close()
    (data / "mis-compras.json").write_text(
        json.dumps([{"sku": "B", "paid": 5.0}]), encoding="utf-8")
    _copy_template(tmp_path)
    out = build_site.build_site(str(tmp_path))
    assert out["mis"][0]["hist_min"] is None


def _copy_template(tmp_path):
    scripts = tmp_path / "scripts"
    scripts.mkdir(exist_ok=True)
    src = os.path.join(os.path.dirname(build_site.__file__),
                       "template.html")
    with open(src, encoding="utf-8") as f:
        (scripts / "template.html").write_text(f.read(), encoding="utf-8")


def test_build_log_corrupto_siguiendo_devolviendo_validos(tmp_path):
    data, db = _make_root(tmp_path)
    db.execute("INSERT INTO products VALUES ('A','Prod A','','','','')")
    db.execute("INSERT INTO prices VALUES (?,?,?,?,?,?)",
               ("A", "2026-10-16", 900, None, 0, 1))
    db.commit()
    db.close()
    w(str(data / "events.jsonl"),
      json.dumps({"sku": "A", "type": "bajo", "date": "2026-10-16"}),
      "{roto",
      "null",
      json.dumps({"iid": "x", "type": "nuevo", "date": "2026-10-16"}),
      json.dumps({"sku": "A", "type": "oferta", "date": "2026-10-16"}))
    _copy_template(tmp_path)
    out = build_site.build_site(str(tmp_path))
    # solo eventos con sku pasan al payload del sitio
    assert [e["type"] for e in out["events"]] == ["bajo", "oferta"]


def test_build_log_205_validos_y_corruptos_devuelve_ultimos_200(tmp_path):
    data, db = _make_root(tmp_path)
    db.execute("INSERT INTO products VALUES ('A','Prod A','','','','')")
    db.execute("INSERT INTO prices VALUES (?,?,?,?,?,?)",
               ("A", "2026-10-16", 900, None, 0, 1))
    db.commit()
    db.close()
    lines = [json.dumps({"sku": f"S{i:03}", "type": "bajo",
                         "date": "2026-10-16"}) for i in range(205)]
    lines.insert(0, "{corrupto")
    lines.insert(50, "null")
    w(str(data / "events.jsonl"), *lines)
    _copy_template(tmp_path)
    out = build_site.build_site(str(tmp_path))
    assert len(out["events"]) == 200
    assert all(e.get("sku") for e in out["events"])
    assert out["events"][0]["sku"] == "S005", "se queda con los ultimos"


def test_build_siman_payload_205_iid_y_corruptos_ultimos_200(tmp_path):
    # siman.db real con un item vivo y su historia de precios
    db_path = str(tmp_path / "siman.db")
    sc = sqlite3.connect(db_path)
    sc.execute("""CREATE TABLE items (
        itemId TEXT PRIMARY KEY, pid TEXT, title TEXT, brand TEXT,
        link TEXT, image TEXT, vname TEXT, watch TEXT, talla TEXT,
        first_seen TEXT, last_seen TEXT, imghash TEXT)""")
    sc.execute("""CREATE TABLE prices (
        itemId TEXT, date TEXT, price REAL, list REAL, qty INT,
        avail INT, card INT, PRIMARY KEY (itemId, date))""")
    sc.execute("CREATE TABLE imgcache (url TEXT PRIMARY KEY, h TEXT)")
    sc.execute("INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
               ("i1", "p1", "Zapato deportivo", "Sport",
                "https://sv.siman.com/x", "", "40", "zapato", None,
                "2026-10-14", "2026-10-16", None))
    for d, pr in (("2026-10-15", 90.0), ("2026-10-16", 80.0)):
        sc.execute("INSERT INTO prices VALUES (?,?,?,?,?,?,?)",
                   ("i1", d, pr, 100.0, 1, 1, 0))
    sc.commit()
    sc.close()
    ev = str(tmp_path / "siman_events.jsonl")
    lines = [json.dumps({"iid": f"i{i:03}", "type": "bajo",
                         "date": "2026-10-16"}) for i in range(205)]
    lines.insert(10, "{roto")
    lines.insert(30, json.dumps({"sku": "A", "type": "bajo",
                                 "date": "2026-10-16"}))   # sku: fuera
    w(ev, *lines)
    out = build_site.build_siman_payload(
        db_path, ev, str(tmp_path / "no_watch.json"), "2026-10-16")
    assert len(out["events"]) == 200
    assert all(e.get("iid") for e in out["events"])
    assert out["events"][0]["iid"] == "i005", "se queda con los ultimos"
    assert out["n_items"] == 1
    assert out["items"][0]["t"] == "Zapato deportivo"


# ---------------- notify.load_events dedup ----------------

def test_notify_dedup_multiclub_y_shapes(tmp_path, monkeypatch):
    monkeypatch.setattr(notify, "TODAY", "2026-10-16")
    p = str(tmp_path / "events.jsonl")
    w(p,
      json.dumps({"sku": "A", "type": "bajo", "date": "2026-10-16",
                  "from": 100, "to": 95}),
      json.dumps({"sku": "A", "type": "bajo", "date": "2026-10-16",
                  "from": 100, "to": 90}),   # dup: gana el ultimo
      json.dumps({"sku": "A", "type": "club_agotado", "club": "San Miguel",
                  "date": "2026-10-16"}),
      json.dumps({"sku": "A", "type": "club_agotado", "club": "Santa Elena",
                  "date": "2026-10-16"}),    # otro club: evento aparte
      json.dumps({"iid": "i9", "type": "nuevo", "date": "2026-10-16"}),
      "{corrupto",
      json.dumps({"sku": "A", "type": "bajo", "date": "2026-10-15"}))
    ev = notify.load_events(p)
    assert len(ev) == 4
    assert [e for e in ev if e["type"] == "bajo"][0]["to"] == 90
    assert sorted(e["club"] for e in ev if e["type"] == "club_agotado") == \
        ["San Miguel", "Santa Elena"]
    assert any(e.get("iid") == "i9" for e in ev)
