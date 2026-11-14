"""Tests de data_health — inspect_data, backups con checksum y
recovery de GitHub.

Todo con SQLite temporales y HTTP mockeado: ningun test toca la red
ni GitHub/Appwrite reales. La logica financiera/config es del lead —
estos tests solo congelan comportamiento mecanico."""

import hashlib
import io
import json
import shutil
import sqlite3
import tarfile
import zipfile
from pathlib import Path

import data_health as dh
import pytest
import requests

DAY = "2026-11-10"
NEXT = "2026-11-11"


def make_ps_db(path, date=DAY, price=1000, in_stock=1):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE prices (sku TEXT, date TEXT, price INT,"
                " sign_price INT, saving REAL, in_stock INT,"
                " PRIMARY KEY (sku,date))")
    con.execute("CREATE TABLE products (sku TEXT PRIMARY KEY,"
                " title TEXT, brand TEXT, category TEXT, slug TEXT,"
                " image TEXT)")
    if price is not None:
        con.execute("INSERT INTO prices VALUES ('111',?,?,NULL,0,?)",
                    (date, price, in_stock))
        con.execute("INSERT INTO products VALUES ('111','T','B','C','s','')")
    con.commit()
    con.close()


def make_sm_db(path, date=DAY, watches=None, with_price=True,
               price_date=None):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE items (itemId TEXT PRIMARY KEY, pid TEXT,"
                " title TEXT, brand TEXT, link TEXT, image TEXT,"
                " vname TEXT, watch TEXT, talla TEXT, first_seen TEXT,"
                " last_seen TEXT, imghash TEXT)")
    con.execute("CREATE TABLE prices (itemId TEXT, date TEXT,"
                " price REAL, list REAL, qty INT, avail INT, card INT,"
                " PRIMARY KEY (itemId,date))")
    con.execute("CREATE TABLE sweep_runs (date TEXT PRIMARY KEY,"
                " watches TEXT NOT NULL, coverage TEXT NOT NULL)")
    con.execute("INSERT INTO items (itemId, vname) VALUES ('i1','M')")
    if with_price:
        con.execute("INSERT INTO prices VALUES ('i1',?,30,30,1,1,0)",
                    (price_date or date,))
    ws = [{"q": "shirt", "talla": "M"}] if watches is None else watches
    con.execute("INSERT INTO sweep_runs VALUES (?,?,?)",
                (date, json.dumps(ws), "[]"))
    con.commit()
    con.close()


def healthy_dir(root, date=DAY, sm_watches=None):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    make_ps_db(root / "prices.db", date)
    make_sm_db(root / "siman.db", date, sm_watches)
    return root


def _runtime_files(root, date=DAY):
    snap = root / "snapshots"
    snap.mkdir(exist_ok=True)
    (snap / f"{date}.json").write_text(json.dumps(
        {"date": date, "products": {"111": {"title": "T"}}}))
    ssnap = root / "siman_snapshots"
    ssnap.mkdir(exist_ok=True)
    (ssnap / f"{date}.json").write_text(json.dumps(
        {"date": date, "items": {}}))
    (root / "events.jsonl").write_text("")
    (root / "siman_events.jsonl").write_text("")


class _Resp:
    def __init__(self, status=200, payload=None, content=b""):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.content = content

    @property
    def ok(self):
        return self.status_code < 400

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


# ---------------- inspect_data ----------------

def test_missing_databases_fail(tmp_path):
    r = dh.inspect_data(tmp_path)
    assert not r["ok"]
    assert "database missing" in r["sources"]["pricesmart"]["problems"]
    assert "database missing" in r["sources"]["siman"]["problems"]


def test_corrupt_database_fails(tmp_path):
    (tmp_path / "prices.db").write_bytes(b"esto no es sqlite")
    make_sm_db(tmp_path / "siman.db")
    r = dh.inspect_data(tmp_path)
    assert not r["ok"]
    assert r["sources"]["pricesmart"]["problems"]
    assert r["sources"]["siman"]["ok"]


def test_schema_invalid_databases_fail(tmp_path):
    # siman.db sin tabla items -> "required tables missing"
    con = sqlite3.connect(tmp_path / "siman.db")
    con.execute("CREATE TABLE prices (itemId TEXT)")
    con.commit()
    con.close()
    # prices.db sin la columna saving -> "required price columns missing"
    con = sqlite3.connect(tmp_path / "prices.db")
    con.execute("CREATE TABLE prices (sku TEXT, date TEXT, price INT,"
                " in_stock INT)")
    con.execute("CREATE TABLE products (sku TEXT PRIMARY KEY)")
    con.execute("INSERT INTO prices VALUES ('111',?,1000,1)", (DAY,))
    con.commit()
    con.close()
    r = dh.inspect_data(tmp_path)
    assert not r["ok"]
    assert any("tables missing" in p
               for p in r["sources"]["siman"]["problems"])
    assert any("price columns" in p
               for p in r["sources"]["pricesmart"]["problems"])


def test_fresh_pricesmart_and_valid_empty_siman_pass(tmp_path):
    healthy_dir(tmp_path)
    r = dh.inspect_data(tmp_path, DAY)
    assert r["ok"], r
    assert r["sources"]["pricesmart"]["observed_at"] == DAY


def test_siman_empty_watchlist_run_is_valid(tmp_path):
    # un sweep con watches=[] y cero filas de precios sigue siendo
    # una observacion valida del dia (watchlist vacia legitima)
    make_ps_db(tmp_path / "prices.db", DAY)
    make_sm_db(tmp_path / "siman.db", DAY, watches=[], with_price=False)
    r = dh.inspect_data(tmp_path, DAY)
    assert r["ok"], r
    assert r["sources"]["siman"]["observed_at"] == DAY


def test_expected_next_day_fails(tmp_path):
    healthy_dir(tmp_path)
    r = dh.inspect_data(tmp_path, NEXT)
    assert not r["ok"]
    assert any("not current" in p
               for p in r["sources"]["pricesmart"]["problems"])
    assert any("not current" in p
               for p in r["sources"]["siman"]["problems"])


def test_siman_run_newer_than_prices_fails(tmp_path):
    # un run con fecha nueva pero precios del dia anterior no es
    # "current": la metadata no refresca observaciones viejas
    make_ps_db(tmp_path / "prices.db", NEXT)
    make_sm_db(tmp_path / "siman.db", NEXT, price_date=DAY)
    r = dh.inspect_data(tmp_path, NEXT)
    assert not r["ok"]
    assert any("no observations for expected date" in p
               for p in r["sources"]["siman"]["problems"])


def test_require_runtime_matching_snapshots_empty_logs_pass(tmp_path):
    healthy_dir(tmp_path, sm_watches=[])
    _runtime_files(tmp_path)
    r = dh.inspect_data(tmp_path, DAY, require_runtime=True)
    assert r["ok"], r


def test_require_runtime_corrupt_log_fails(tmp_path):
    healthy_dir(tmp_path, sm_watches=[])
    _runtime_files(tmp_path)
    # linea truncada: un json cortado no se promueve como buen cache
    (tmp_path / "events.jsonl").write_text('{"type":"bajo","sku":"11')
    r = dh.inspect_data(tmp_path, DAY, require_runtime=True)
    assert not r["ok"]
    assert r["sources"]["pricesmart"]["problems"]


def test_require_runtime_bad_event_and_snapshot_date_fail(tmp_path):
    healthy_dir(tmp_path, sm_watches=[])
    _runtime_files(tmp_path)
    # evento bien formado pero con fecha invalida
    (tmp_path / "events.jsonl").write_text(
        json.dumps({"type": "bajo", "sku": "111",
                    "date": "no-es-fecha"}) + "\n")
    r = dh.inspect_data(tmp_path, DAY, require_runtime=True)
    assert not r["ok"]
    assert r["sources"]["pricesmart"]["problems"]
    # snapshot cuya fecha no es la observada
    _runtime_files(tmp_path)
    (tmp_path / "snapshots" / f"{DAY}.json").write_text(json.dumps(
        {"date": "2099-01-01", "products": {"111": {}}}))
    r = dh.inspect_data(tmp_path, DAY, require_runtime=True)
    assert not r["ok"]
    assert any("snapshot" in p
               for p in r["sources"]["pricesmart"]["problems"])


# ---------------- backup / restore ----------------

def test_backup_refuses_invalid_data(tmp_path):
    with pytest.raises(ValueError, match="invalid data"):
        dh.create_backup(tmp_path, tmp_path / "b.tar.gz")


def test_backup_existing_output_refused_and_bytes_unchanged(tmp_path):
    """Un backup jamas pisa un artefacto existente: fail closed."""
    src = healthy_dir(tmp_path / "data")
    out = tmp_path / "b.tar.gz"
    out.write_bytes(b"backup-previo-intocable")
    with pytest.raises(ValueError, match="already exists"):
        dh.create_backup(src, out)
    assert out.read_bytes() == b"backup-previo-intocable"


def test_catalog_schema_invalid_fails(tmp_path):
    """products sin columna image / items sin vname: catalogo
    malformed no pasa como sano aunque las fechas cuadren."""
    make_sm_db(tmp_path / "siman.db", DAY)
    con = sqlite3.connect(tmp_path / "prices.db")
    con.execute("CREATE TABLE prices (sku TEXT, date TEXT, price INT,"
                " sign_price INT, saving REAL, in_stock INT)")
    con.execute("CREATE TABLE products (sku TEXT PRIMARY KEY,"
                " title TEXT, brand TEXT, category TEXT, slug TEXT)")
    con.execute("INSERT INTO prices VALUES ('111',?,1000,NULL,0,1)", (DAY,))
    con.execute("INSERT INTO products VALUES ('111','T','B','C','s')")
    con.commit()
    con.close()
    r = dh.inspect_data(tmp_path, DAY)
    assert not r["ok"]
    assert any("catalog columns" in p
               for p in r["sources"]["pricesmart"]["problems"])
    # y lo mismo del lado siman: items sin vname
    (tmp_path / "prices.db").unlink()
    (tmp_path / "siman.db").unlink()
    make_ps_db(tmp_path / "prices.db", DAY)
    con = sqlite3.connect(tmp_path / "siman.db")
    con.execute("CREATE TABLE items (itemId TEXT PRIMARY KEY, pid TEXT,"
                " title TEXT)")
    con.execute("CREATE TABLE prices (itemId TEXT, date TEXT,"
                " price REAL, list REAL, qty INT, avail INT, card INT)")
    con.execute("INSERT INTO prices VALUES ('i1',?,30,30,1,1,0)", (DAY,))
    con.commit()
    con.close()
    r = dh.inspect_data(tmp_path, DAY)
    assert not r["ok"]
    assert any("catalog columns" in p
               for p in r["sources"]["siman"]["problems"])


def test_backup_and_restore_preserve_hashes_and_dbs(tmp_path):
    src = healthy_dir(tmp_path / "data")
    _runtime_files(src)
    before = (src / "prices.db").read_bytes()
    archive = dh.create_backup(src, tmp_path / "backup.tar.gz")
    assert (src / "prices.db").read_bytes() == before, \
        "la semilla original no se toco"
    dst = tmp_path / "restore"
    manifest = dh.restore_backup(archive, dst)
    assert manifest["schema_version"] == 1
    assert dh.inspect_data(dst)["ok"], "los DBs restaurados son validos"
    for name, digest in manifest["files"].items():
        blob = (dst / name).read_bytes()
        assert hashlib.sha256(blob).hexdigest() == digest


def test_backup_excludes_private_and_nonconforming_files(tmp_path):
    src = healthy_dir(tmp_path / "data")
    (src / "mis.json").write_text("PRIVADO-compras")
    snap = src / "snapshots"
    snap.mkdir(exist_ok=True)
    (snap / "mis.json").write_text("PRIVADO-snap")
    (snap / f"{DAY}.json").write_text(json.dumps(
        {"date": DAY, "products": {"111": {}}}))
    archive = dh.create_backup(src, tmp_path / "b.tar.gz")
    with tarfile.open(archive, "r:gz") as t:
        names = t.getnames()
        assert f"snapshots/{DAY}.json" in names
        assert not any("mis" in n for n in names), names
        blob = b"".join(t.extractfile(m).read()
                        for m in t.getmembers() if m.isfile())
        assert b"PRIVADO" not in blob


def test_restore_refuses_existing_runtime(tmp_path):
    src = healthy_dir(tmp_path / "data")
    archive = dh.create_backup(src, tmp_path / "b.tar.gz")
    dst = tmp_path / "restore"
    dst.mkdir()
    (dst / "prices.db").write_bytes(b"ocupado")
    with pytest.raises(ValueError, match="not overwriting"):
        dh.restore_backup(archive, dst)
    assert (dst / "prices.db").read_bytes() == b"ocupado"


def _tamper_archive(archive, target_name, mutate):
    out = {}
    with tarfile.open(archive, "r:gz") as t:
        for m in t.getmembers():
            out[m.name] = t.extractfile(m).read()
    out[target_name] = mutate(out[target_name])
    with tarfile.open(archive, "w:gz") as t:
        for name, blob in out.items():
            info = tarfile.TarInfo(name)
            info.size = len(blob)
            t.addfile(info, io.BytesIO(blob))


def test_tampered_db_fails_checksum_before_touching_target(tmp_path):
    src = healthy_dir(tmp_path / "data")
    archive = dh.create_backup(src, tmp_path / "b.tar.gz")
    _tamper_archive(archive, "prices.db",
                    lambda b: b[:-1] + bytes([b[-1] ^ 0xFF]))
    dst = tmp_path / "restore"
    with pytest.raises(ValueError, match="checksum"):
        dh.restore_backup(archive, dst)
    assert not (dst / "prices.db").exists(), \
        "el checksum va antes de escribir nada en el target"


def test_archive_traversal_symlink_duplicates_rejected(tmp_path):
    # traversal ../
    bad = tmp_path / "trav.tar.gz"
    with tarfile.open(bad, "w:gz") as t:
        info = tarfile.TarInfo("../evil")
        blob = b"x"
        info.size = len(blob)
        t.addfile(info, io.BytesIO(blob))
    with pytest.raises(ValueError, match="invalid backup members"):
        dh.restore_backup(bad, tmp_path / "r1")
    assert not (tmp_path / "evil").exists()
    # symlink: no es regular file -> rechazado antes de extraer
    bad = tmp_path / "sym.tar.gz"
    with tarfile.open(bad, "w:gz") as t:
        link = tarfile.TarInfo("prices.db")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        t.addfile(link)
    with pytest.raises(ValueError, match="invalid backup members"):
        dh.restore_backup(bad, tmp_path / "r2")
    # entradas duplicadas
    bad = tmp_path / "dup.tar.gz"
    with tarfile.open(bad, "w:gz") as t:
        for _ in range(2):
            info = tarfile.TarInfo("quality.json")
            info.size = 1
            t.addfile(info, io.BytesIO(b"{"))
    with pytest.raises(ValueError, match="invalid backup members"):
        dh.restore_backup(bad, tmp_path / "r3")


# ---------------- recovery GitHub / verify-site ----------------

def _gh_env(monkeypatch):
    monkeypatch.setenv("GITHUB_REPOSITORY", "me/repo")
    monkeypatch.setenv("GH_TOKEN", "t")


def _artifact(n, run_id):
    return {"name": f"pricewatch-backup-{n}", "expired": False,
            "created_at": f"2026-11-{10 + n:02d}T00:00:00Z",
            "workflow_run": {"id": run_id},
            "archive_download_url": f"https://api.invalid/dl/{n}"}


def test_restore_github_accepts_only_daily_main_event(tmp_path,
                                                     monkeypatch):
    _gh_env(monkeypatch)
    src = healthy_dir(tmp_path / "seed")
    archive = dh.create_backup(src, tmp_path / "good.tar.gz")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("pricewatch-backup.tar.gz", Path(archive).read_bytes())
    blob = buf.getvalue()
    calls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append(url)
        if "artifacts" in url:
            return _Resp(payload={"artifacts": [
                _artifact(9, 99),   # mas nuevo: workflow ajeno, se salta
                _artifact(1, 11)]})
        if "/runs/99" in url:
            return _Resp(payload={"head_branch": "main",
                                  "event": "push",
                                  "path": ".github/workflows/ci.yml"})
        if "/runs/11" in url:
            return _Resp(payload={"head_branch": "main",
                                  "event": "schedule",
                                  "path": ".github/workflows/daily.yml"})
        if url.endswith("/dl/1"):
            return _Resp(content=blob)
        raise AssertionError("url inesperada " + url)

    monkeypatch.setattr(dh.requests, "get", fake_get)
    dst = tmp_path / "restore"
    assert dh.restore_github(dst) is True
    assert dh.inspect_data(dst)["ok"]
    assert not any(u.endswith("/dl/9") for u in calls), \
        "la corrida que no es Daily/main/event jamas se descargo"


def test_restore_github_corrupt_latest_falls_back_to_older(
        tmp_path, monkeypatch):
    """El artefacto mas nuevo corrupto se rechaza tras validar y se
    intenta el retenido anterior — jamas un cold overwrite."""
    _gh_env(monkeypatch)
    src = healthy_dir(tmp_path / "seed")
    good = dh.create_backup(src, tmp_path / "good.tar.gz")
    corrupt = tmp_path / "bad.tar.gz"
    shutil.copyfile(good, corrupt)
    _tamper_archive(corrupt, "prices.db",
                    lambda b: b[:-1] + bytes([b[-1] ^ 0xFF]))

    def wrap(archive_path):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("pricewatch-backup.tar.gz",
                       Path(archive_path).read_bytes())
        return buf.getvalue()

    blobs = {9: wrap(corrupt), 1: wrap(good)}
    run_meta = {"head_branch": "main", "event": "schedule",
                "path": ".github/workflows/daily.yml"}
    calls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append(url)
        if "artifacts" in url:
            # created_at ordena: el 9 es el mas nuevo
            return _Resp(payload={"artifacts": [
                _artifact(9, 2), _artifact(1, 1)]})
        if "/runs/" in url:
            return _Resp(payload=run_meta)   # ambos Daily/main/schedule
        for n, blob in blobs.items():
            if url.endswith(f"/dl/{n}"):
                return _Resp(content=blob)
        raise AssertionError("url inesperada " + url)

    monkeypatch.setattr(dh.requests, "get", fake_get)
    dst = tmp_path / "restore"
    assert dh.restore_github(dst) is True
    assert dh.inspect_data(dst)["ok"], "el backup viejo valido restaura"
    assert any(u.endswith("/dl/9") for u in calls)
    assert any(u.endswith("/dl/1") for u in calls)


def test_restore_github_no_daily_candidate_raises(tmp_path, monkeypatch):
    _gh_env(monkeypatch)

    def fake_get(url, headers=None, params=None, timeout=None):
        if "artifacts" in url:
            return _Resp(payload={"artifacts": [_artifact(1, 7)]})
        if "/runs/7" in url:
            return _Resp(payload={"head_branch": "main",
                                  "event": "schedule",
                                  "path": ".github/workflows/ci.yml"})
        raise AssertionError("descarga no permitida")

    monkeypatch.setattr(dh.requests, "get", fake_get)
    with pytest.raises(ValueError, match="could not be restored"):
        dh.restore_github(tmp_path / "restore")


def test_verify_site_503_then_matching_version(tmp_path, monkeypatch):
    ver = tmp_path / "version.json"
    ver.write_text(json.dumps({"built": "b-ok"}))
    monkeypatch.setattr(dh.time, "sleep", lambda s: None)
    calls = []

    def fake_get(url, **kw):
        calls.append(url)
        if len(calls) == 1:
            return _Resp(status=503)
        return _Resp(payload={"built": "b-ok"})

    monkeypatch.setattr(dh.requests, "get", fake_get)
    assert dh.verify_site("https://site.invalid", ver) is True
    assert len(calls) == 2


def test_verify_site_wrong_version_repeated_raises(tmp_path, monkeypatch):
    ver = tmp_path / "version.json"
    ver.write_text(json.dumps({"built": "b-ok"}))
    monkeypatch.setattr(dh.time, "sleep", lambda s: None)
    monkeypatch.setattr(
        dh.requests, "get",
        lambda url, **kw: _Resp(payload={"built": "b-otra"}))
    with pytest.raises(ValueError, match="does not match"):
        dh.verify_site("https://site.invalid", ver)
