"""Fetch/fail-safe guards de sweep_siman.py — HTTP falso, tmp paths.

Una busqueda que cae NUNCA deja barrido parcial: sweep() envuelve el
error en RuntimeError y main() no toca snapshot, db ni log — mejor un
job rojo que un 'salio de catalogo' masivo falso.
"""

import json
import sqlite3
from types import SimpleNamespace

import pytest
import requests
import sweep_siman as sm
from common import AppwriteReadError


class Resp:
    def __init__(self, payload=None, status=200):
        self.payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda *a: None)


def fake_get(queue):
    calls = []

    def get(url, headers=None, timeout=None):
        calls.append(url)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
    return get, calls


def test_http_500_con_json_lista_no_es_exito_vacio(monkeypatch):
    # VTEX devolviendo una lista aparente con 500: raise_for_status
    # manda — no se acepta como "busqueda vacia"
    get, calls = fake_get([Resp([{"productId": "1"}], status=500)] * 4)
    monkeypatch.setattr(sm, "SESSION", SimpleNamespace(get=get))
    with pytest.raises(Exception):
        sm.fetch_search("zapato")
    assert len(calls) == 4


def test_payload_objeto_se_rechaza(monkeypatch):
    get, calls = fake_get([Resp({"error": "x"})] * 4)
    monkeypatch.setattr(sm, "SESSION", SimpleNamespace(get=get))
    with pytest.raises(Exception):
        sm.fetch_search("zapato")
    assert len(calls) == 4


def test_lista_vacia_normal_es_aceptada(monkeypatch):
    get, calls = fake_get([Resp([])])
    monkeypatch.setattr(sm, "SESSION", SimpleNamespace(get=get))
    assert sm.fetch_search("zapato") == []
    assert len(calls) == 1


def test_sweep_segunda_busqueda_caida_levanta_runtimeerror(monkeypatch):
    calls = []

    def get(url, headers=None, timeout=None):
        calls.append(url)
        if "ft=zapato" in url:
            # el primer watch SI acumula un item antes del fallo
            return Resp([{"productId": "p1", "productName": "Zapato",
                          "items": [{"itemId": "i1", "sellers": []}]}])
        return Resp(status=500)
    monkeypatch.setattr(sm, "SESSION", SimpleNamespace(get=get))
    with pytest.raises(RuntimeError, match="roto"):
        sm.sweep([{"q": "zapato"}, {"q": "roto"}])
    assert sum("ft=zapato" in u for u in calls) == 1
    assert sum("ft=roto" in u for u in calls) == 4, \
        "tres reintentos antes del RuntimeError"


def test_main_falla_no_toca_snapshot_db_ni_log(monkeypatch, tmp_path):
    snap_dir = tmp_path / "siman_snapshots"
    snap_dir.mkdir()
    snap = snap_dir / "2026-10-15.json"
    snap.write_text(json.dumps(
        {"date": "2026-10-15", "items": {"i1": {"iid": "i1"}}}),
        encoding="utf-8")
    before = snap.read_bytes()
    db = tmp_path / "siman.db"
    conn = sqlite3.connect(str(db))   # db preexistente: bytes intactos
    conn.execute("CREATE TABLE items (itemId TEXT)")
    conn.commit()
    conn.close()
    db_before = db.read_bytes()
    log = tmp_path / "siman_events.jsonl"
    log.write_text('{"iid":"i1","type":"nuevo","date":"2026-10-15"}\n',
                   encoding="utf-8")
    log_before = log.read_bytes()
    monkeypatch.setattr(sm, "SNAP_DIR", str(snap_dir))
    monkeypatch.setattr(sm, "DB_PATH", str(db))
    monkeypatch.setattr(sm, "EVENTS_LOG", str(log))
    monkeypatch.setattr(sm, "load_watches",
                        lambda: [{"q": "ok"}, {"q": "fail"}])
    monkeypatch.setattr(sm, "fetch_search",
                        lambda q: (_ for _ in ()).throw(ValueError("x"))
                        if q == "fail" else [])
    touched = []
    for fn in ("attach_hashes", "record_history", "append_events"):
        monkeypatch.setattr(sm, fn, lambda *a, _f=fn, **k:
                            touched.append(_f))
    with pytest.raises(RuntimeError):
        sm.main()
    assert snap.read_bytes() == before, "snapshot intacto"
    assert log.read_bytes() == log_before, "log intacto"
    assert db.read_bytes() == db_before, "db existente intacta"
    assert touched == [], "ni hashes ni historia ni eventos"


# ---------- watches_remote: reintento acotado + razon visible ----------


def test_watches_appwrite_falla_dos_veces_y_logra(monkeypatch):
    monkeypatch.setattr(sm, "aw_env", lambda: ("e", "p", "k"))
    calls = []

    def rows(table, *a, **k):
        calls.append(table)
        if len(calls) < 3:
            raise AppwriteReadError("siman_watch: HTTP 500/invalid rows")
        return [{"q": "zapato"}]
    monkeypatch.setattr(sm, "aw_rows", rows)
    assert sm.watches_remote() == [{"q": "zapato"}]
    assert len(calls) == 3


def test_watches_appwrite_muerto_confiesa_razon(monkeypatch):
    monkeypatch.setattr(sm, "aw_env", lambda: ("e", "p", "k"))
    calls = []

    def rows(table, *a, **k):
        calls.append(table)
        raise AppwriteReadError("siman_watch: HTTP 403/invalid rows")
    monkeypatch.setattr(sm, "aw_rows", rows)
    with pytest.raises(RuntimeError, match="HTTP 403"):
        sm.watches_remote()
    assert len(calls) == 3, "tres intentos antes del RuntimeError"


# ---------- gh_error / run_cli: la falla debe ser annotation publica ----------


def test_gh_error_escapa_comandos_workflow(capsys):
    msg = "100%" + chr(10) + "segunda" + chr(10) + "linea"
    sm.gh_error("T", msg)
    out = capsys.readouterr().out.strip()
    assert out == "::error title=T::100%25%0Asegunda%0Alinea"


def test_gh_error_trunca_a_300(capsys):
    sm.gh_error("T", "x" * 400)
    out = capsys.readouterr().out.strip()
    assert out == "::error title=T::" + "x" * 300


def test_run_cli_anota_error_y_devuelve_1(capsys):
    def boom():
        raise ValueError("estallo" + chr(10) + "con salto")
    assert sm.run_cli(boom) == 1
    out = capsys.readouterr().out
    line = next(x for x in out.splitlines()
                if x.startswith("::error title=Siman sweep::"))
    assert "ValueError" in line and "con salto" in line
    assert sm.run_cli(lambda: None) == 0
