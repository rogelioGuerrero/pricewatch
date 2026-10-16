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
    assert sweep._move_type(800, 1000, 2.0) == "bajo"


def test_move_type_rebaja_sin_letrero():
    # rebaja silenciosa: precio cae sin letrero de ahorro (suele ser permanente)
    assert sweep._move_type(800, 1000, 0) == "rebaja"


def test_move_type_subio():
    assert sweep._move_type(1100, 1000, 0) == "subio"


# ---------- diff ----------

def test_diff_bajada_emite_bajo():
    # saving_usd viaja en DOLARES (la API lo reporta asi; se escala a
    # centavos solo al comparar contra precios)
    prev = {"A": prod(1000, saving=2.0)}
    cur = {"A": prod(800, saving=4.0)}
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
    prev = {"A": prod(800, saving=2.0)}   # regular 1000
    cur = {"A": prod(1000, saving=0)}
    ev = sweep.diff(prev, cur, "2026-10-14")
    assert types(ev) == ["oferta_termino"]


def test_diff_ahorro_mengua_no_es_termino():
    """El letrero baja de $2.00 a $0.50 con precio intacto: la oferta
    sigue activa, no 'termino' — antes se reportaba oferta_termino."""
    prev = {"A": prod(1000, saving=2.0)}
    cur = {"A": prod(1000, saving=0.5)}
    assert types(sweep.diff(prev, cur, "2026-10-14")) == []


def test_diff_letrero_desaparece_precio_igual():
    """Sin letrero y sin cambio de precio: la oferta termino igual."""
    prev = {"A": prod(800, saving=2.0)}
    cur = {"A": prod(800, saving=0)}
    ev = sweep.diff(prev, cur, "2026-10-14")
    assert types(ev) == ["oferta_termino"]


def test_diff_subida_parcial_no_es_reversion():
    """El precio sube pero NO llega al regular y el letrero cae: dos
    hechos ciertos — 'subio' + 'oferta_termino' (no es reversion)."""
    prev = {"A": prod(800, saving=2.0)}   # regular 1000
    cur = {"A": prod(950, saving=0)}
    ev = sweep.diff(prev, cur, "2026-10-14")
    assert types(ev) == ["subio", "oferta_termino"]


def test_diff_oferta_nueva_mismo_precio():
    prev = {"A": prod(1000, saving=0)}
    cur = {"A": prod(1000, saving=1.5)}
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


# ---------- club_stock_diff ----------

def _club_db(tmp_path, rows):
    """club_stock con rows = (sku, date, club, name, in_stock, qty)."""
    import sqlite3
    db = tmp_path / "prices.db"
    conn = sqlite3.connect(db)
    conn.execute("""CREATE TABLE club_stock (
        sku TEXT, date TEXT, club TEXT, club_name TEXT,
        in_stock INT, qty INT, PRIMARY KEY (sku, date, club))""")
    conn.executemany("INSERT INTO club_stock VALUES (?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()
    return str(db)


def test_club_stock_diff_transiciones(tmp_path, monkeypatch):
    monkeypatch.setattr(sweep, "DB_PATH", _club_db(tmp_path, [
        ("A", "2026-10-13", "sa", "Santa Ana", 1, 10),
        ("A", "2026-10-14", "sa", "Santa Ana", 0, 0),   # club_agotado
        ("B", "2026-10-13", "sa", "Santa Ana", 0, 0),
        ("B", "2026-10-14", "sa", "Santa Ana", 1, 4),   # club_volvio
        ("C", "2026-10-13", "sa", "Santa Ana", 1, 10),
        ("C", "2026-10-14", "sa", "Santa Ana", 1, 5),   # se_agota (-50%)
        ("D", "2026-10-13", "sa", "Santa Ana", 1, 10),
        ("D", "2026-10-14", "sa", "Santa Ana", 1, 9),   # -10%: nada
    ]))
    products = {s: {"title": s, "price_SV": 100} for s in "ABCD"}
    ev = sweep.club_stock_diff("2026-10-14", {"A", "B", "C", "D"},
                               products)
    por_sku = {e["sku"]: e["type"] for e in ev}
    assert por_sku == {"A": "club_agotado", "B": "club_volvio",
                       "C": "se_agota"}
    assert ev[2]["qty_from"] == 10 and ev[2]["qty_to"] == 5


def test_club_stock_diff_solo_candidatos(tmp_path, monkeypatch):
    monkeypatch.setattr(sweep, "DB_PATH", _club_db(tmp_path, [
        ("A", "2026-10-13", "sa", "Santa Ana", 1, 10),
        ("A", "2026-10-14", "sa", "Santa Ana", 0, 0),
        ("Z", "2026-10-13", "sa", "Santa Ana", 1, 10),
        ("Z", "2026-10-14", "sa", "Santa Ana", 0, 0),
    ]))
    ev = sweep.club_stock_diff("2026-10-14", {"A"}, {})
    assert [e["sku"] for e in ev] == ["A"]   # Z no es candidato


def test_club_stock_diff_sin_dia_previo(tmp_path, monkeypatch):
    monkeypatch.setattr(sweep, "DB_PATH", _club_db(tmp_path, [
        ("A", "2026-10-14", "sa", "Santa Ana", 0, 0)]))
    assert sweep.club_stock_diff("2026-10-14", {"A"}, {}) == []


def test_club_stock_diff_sin_db(tmp_path, monkeypatch):
    monkeypatch.setattr(sweep, "DB_PATH", str(tmp_path / "nada.db"))
    assert sweep.club_stock_diff("2026-10-14", {"A"}, {}) == []


# ---------- stock_candidates ----------

def test_stock_candidates_prioriza_ofertas_y_favs(tmp_path, monkeypatch):
    """Con >400 eventos recientes, ofertas activas y favoritos nunca
    quedan fuera del cap."""
    log = tmp_path / "events.jsonl"
    log.write_text(
        "\n".join(json.dumps({"date": "2026-10-10", "sku": f"E{i:04d}",
                              "type": "bajo"})
                  for i in range(500)),
        encoding="utf-8")
    monkeypatch.setattr(sweep, "EVENTS_LOG", str(log))
    products = {"OF1": prod(1000, saving=2.0), "X1": prod(500)}
    cands = sweep.stock_candidates("2026-10-14", products, favs={"FV1"})
    assert "OF1" in cands and "FV1" in cands
    assert len(cands - {"OF1", "FV1"}) <= 400


def test_stock_candidates_ignora_eventos_viejos(tmp_path, monkeypatch):
    log = tmp_path / "events.jsonl"
    log.write_text(json.dumps({"date": "2026-01-01", "sku": "OLD",
                               "type": "bajo"}),
                   encoding="utf-8")
    monkeypatch.setattr(sweep, "EVENTS_LOG", str(log))
    cands = sweep.stock_candidates("2026-10-14", {}, favs=set())
    assert "OLD" not in cands


# ---------- record_history: skip de categorias heredadas ----------

def test_record_history_respeta_skip_inherited(tmp_path, monkeypatch):
    """SKUs en 'skip' (categorias caidas heredadas del snapshot
    anterior) no fabrican filas falsas en prices.db."""
    db = tmp_path / "prices.db"
    monkeypatch.setattr(sweep, "DB_PATH", str(db))
    sweep.record_history({"A": prod(1000), "B": prod(500)},
                         "2026-10-14", skip={"B"})
    import sqlite3
    con = sqlite3.connect(str(db))
    skus = {r[0] for r in con.execute("select sku from prices")}
    prods = {r[0] for r in con.execute("select sku from products")}
    con.close()
    assert skus == {"A"} and prods == {"A"}
