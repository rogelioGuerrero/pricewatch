"""Tests de entrega de notify.py — recibos persistentes, retries
acotados, deduplicacion push y dry-run.

Providers 100% falsos (Session.post / modulo pywebpush en sys.modules):
ningun test toca la red, Resend ni Appwrite reales."""

import json
import sqlite3
import sys
import types
from datetime import date, timedelta
from pathlib import Path

import notify
import pytest


@pytest.fixture(autouse=True)
def _aislado(monkeypatch, tmp_path):
    """DATA a tmp + env de providers limpio + contadores en cero."""
    monkeypatch.setattr(notify, "DATA", str(tmp_path))
    monkeypatch.setattr(notify, "DB", str(tmp_path / "prices.db"))
    monkeypatch.setattr(notify, "SIMAN_DB", str(tmp_path / "siman.db"))
    monkeypatch.setattr(notify, "EVENTS_LOG", str(tmp_path / "e.jsonl"))
    monkeypatch.setattr(notify, "SIMAN_LOG",
                        str(tmp_path / "se.jsonl"))
    for k in ("RESEND_API_KEY", "RESEND_FROM", "RESEND_TO",
              "VAPID_PRIVATE", "VAPID_PUBLIC", "PW_NOTIFY_DRY_RUN",
              "APPWRITE_API_KEY", "APPWRITE_ENDPOINT",
              "APPWRITE_PROJECT_ID"):
        monkeypatch.delenv(k, raising=False)
    for c in ("email", "push"):
        notify.DELIVERY[c].update(sent=0, skipped=0, failed=0)
    monkeypatch.setattr(notify.time, "sleep", lambda s: None)
    return tmp_path


class _Resp:
    def __init__(self, status=200):
        self.status_code = status

    @property
    def ok(self):
        return self.status_code < 400


def _resend_env(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "rk")
    monkeypatch.setenv("RESEND_TO", "destino@x.sv")


def _ledger(data_dir):
    p = Path(data_dir) / "notifications.json"
    if not p.exists():
        return {"sent": {}}
    return json.loads(p.read_text(encoding="utf-8"))


# ---------------- email ----------------

def test_email_mismo_dos_veces_manda_una_y_guarda_recibo(
        monkeypatch, tmp_path):
    _resend_env(monkeypatch)
    posts = []

    def post(url, json=None, headers=None, timeout=None):
        posts.append(headers["Idempotency-Key"])
        return _Resp(200)

    monkeypatch.setattr(notify.SESSION, "post", post)
    notify.send_email("asunto", "<b>html</b>", "texto")
    notify.send_email("asunto", "<b>html</b>", "texto")
    assert len(posts) == 1, "el segundo envio ya tenia recibo"
    assert posts[0].startswith("pricewatch-"), posts
    # la key es estable: se deriva de canal+fecha+destino+contenido
    content = {"from": "PriceWatch <info@agtisa.com>",
               "to": "destino@x.sv", "subject": "asunto",
               "html": "<b>html</b>", "text": "texto"}
    esperada = "pricewatch-" + notify._delivery_key(
        "email", "destino@x.sv", content)
    assert posts[0] == esperada
    ledger = _ledger(tmp_path)
    assert len(ledger["sent"]) == 1
    assert ledger["sent"][posts[0][len("pricewatch-"):]]["channel"] == "email"
    assert notify.DELIVERY["email"]["sent"] == 1
    assert notify.DELIVERY["email"]["skipped"] == 1


def test_email_transitorio_503_reintenta_con_la_misma_key(
        monkeypatch, tmp_path):
    _resend_env(monkeypatch)
    keys = []

    def post(url, json=None, headers=None, timeout=None):
        keys.append(headers["Idempotency-Key"])
        return _Resp(503 if len(keys) == 1 else 200)

    monkeypatch.setattr(notify.SESSION, "post", post)
    notify.send_email("a", "h", "t")
    assert len(keys) == 2, "503 transitorio reintenta"
    assert keys[0] == keys[1], "misma Idempotency-Key en el retry"
    assert notify.DELIVERY["email"]["sent"] == 1
    assert len(_ledger(tmp_path)["sent"]) == 1


def test_email_400_permanente_cuenta_fallo_sin_retry(
        monkeypatch, tmp_path):
    _resend_env(monkeypatch)
    posts = []

    def post(url, json=None, headers=None, timeout=None):
        posts.append(url)
        return _Resp(400)

    monkeypatch.setattr(notify.SESSION, "post", post)
    notify.send_email("a", "h", "t")
    assert len(posts) == 1, "400 no reintenta"
    assert notify.DELIVERY["email"]["failed"] == 1
    assert _ledger(tmp_path)["sent"] == {}, "sin recibo falso"


def test_email_recibos_malformados_fallan_cerrado(
        monkeypatch, tmp_path):
    _resend_env(monkeypatch)
    (tmp_path / "notifications.json").write_text(
        json.dumps({"schema_version": 9, "sent": []}))
    posts = []
    monkeypatch.setattr(notify.SESSION, "post",
                        lambda *a, **kw: posts.append(a) or _Resp(200))
    with pytest.raises(ValueError, match="receipts"):
        notify.send_email("a", "h", "t")
    assert posts == [], "recibos corruptos = no mandar nada"


def test_email_dry_run_nunca_llama_al_provider(monkeypatch, tmp_path):
    _resend_env(monkeypatch)
    monkeypatch.setenv("PW_NOTIFY_DRY_RUN", "1")
    posts = []
    monkeypatch.setattr(notify.SESSION, "post",
                        lambda *a, **kw: posts.append(a) or _Resp(200))
    notify.send_email("a", "h", "t")
    assert posts == []
    assert notify.DELIVERY["email"]["skipped"] == 1


# ---------------- push ----------------

def _fake_pywebpush(monkeypatch, behavior):
    """Modulo pywebpush falso; behavior() corre dentro de webpush."""
    calls = []

    class WebPushException(Exception):
        def __init__(self, response=None):
            super().__init__("push fail")
            self.response = response

    def webpush(subscription_info, data, vapid_private_key,
                vapid_claims, ttl, timeout):
        calls.append(subscription_info["endpoint"])
        behavior()

    mod = types.ModuleType("pywebpush")
    mod.webpush = webpush
    mod.WebPushException = WebPushException
    monkeypatch.setitem(sys.modules, "pywebpush", mod)
    monkeypatch.setenv("VAPID_PRIVATE", "vp-fake")
    return calls, WebPushException


SUB = {"$id": "s1", "endpoint": "https://push.invalid/e1",
       "keys": "{}"}


def test_push_exito_y_duplicado_no_reenvia(monkeypatch, tmp_path):
    calls, _ = _fake_pywebpush(monkeypatch, lambda: None)
    notify.send_push([dict(SUB)], {"kind": "t"})
    notify.send_push([dict(SUB)], {"kind": "t"})
    assert len(calls) == 1, "el duplicado ya tenia recibo"
    assert len(_ledger(tmp_path)["sent"]) == 1
    assert notify.DELIVERY["push"]["sent"] == 1
    assert notify.DELIVERY["push"]["skipped"] == 1


def test_push_fallido_queda_sin_recibo_y_reintenta(
        monkeypatch, tmp_path):
    calls, _ = _fake_pywebpush(
        monkeypatch, lambda: (_ for _ in ()).throw(RuntimeError("x")))
    notify.send_push([dict(SUB)], {"kind": "t"})
    assert notify.DELIVERY["push"]["failed"] == 1
    assert _ledger(tmp_path)["sent"] == {}, "fallo sin recibo"
    notify.send_push([dict(SUB)], {"kind": "t"})
    assert calls == [SUB["endpoint"], SUB["endpoint"]], \
        "sin recibo el siguiente intento si manda"


def test_push_dry_run_nunca_invoca_provider(monkeypatch, tmp_path):
    """Dry-run con provider y llave presentes: es el dry-run el que
    corta, no la falta de dependencias."""
    monkeypatch.setenv("PW_NOTIFY_DRY_RUN", "1")
    calls, _ = _fake_pywebpush(monkeypatch, lambda: None)
    notify.send_push([dict(SUB)], {"kind": "t"})
    assert calls == [], "dry-run: provider jamas invocado"
    assert notify.DELIVERY["push"]["skipped"] == 1


# ---------------- catalog_state / siman_items ----------------

def test_catalog_state_fecha_vieja_no_es_in_stock(tmp_path, monkeypatch):
    db = tmp_path / "prices.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE products (sku TEXT PRIMARY KEY,"
                " title TEXT, image TEXT)")
    con.execute("CREATE TABLE prices (sku TEXT, date TEXT, price INT,"
                " saving REAL, in_stock INT)")
    con.execute("INSERT INTO products VALUES ('111','T','')")
    con.execute("INSERT INTO prices VALUES ('111','2020-01-01',1000,0,1)")
    con.commit()
    con.close()
    monkeypatch.setattr(notify, "DB", str(db))
    cat, _ = notify.catalog_state()
    assert cat["111"]["observed_at"] == "2020-01-01"
    assert cat["111"]["in_stock"] is False, \
        "stock de una fecha vieja no puede contar como hoy"


def _siman_db(path, items, prices, members):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE items (itemId TEXT PRIMARY KEY, pid TEXT,"
                " title TEXT, brand TEXT, link TEXT, image TEXT,"
                " vname TEXT, watch TEXT, talla TEXT, first_seen TEXT,"
                " last_seen TEXT, imghash TEXT)")
    con.execute("CREATE TABLE prices (itemId TEXT, date TEXT,"
                " price REAL, list REAL, qty INT, avail INT, card INT,"
                " PRIMARY KEY (itemId,date))")
    con.execute("CREATE TABLE watch_memberships (itemId TEXT, q TEXT,"
                " talla TEXT, filtro TEXT, observed_at TEXT,"
                " PRIMARY KEY (itemId,q,talla))")
    for it in items:
        con.execute("INSERT INTO items (itemId, vname) VALUES (?,?)", it)
    for p in prices:
        con.execute("INSERT INTO prices VALUES (?,?,?,?,?,?,?)", p)
    for m in members:
        con.execute("INSERT INTO watch_memberships VALUES (?,?,?,?,?)", m)
    con.commit()
    con.close()


def test_siman_membresias_viejas_y_talla_ajena_se_excluyen(
        tmp_path, monkeypatch):
    today = notify.TODAY
    ayer = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    db = tmp_path / "siman.db"
    _siman_db(
        db,
        items=[("i_ok", "M"), ("i_stale", "M"), ("i_wrong", "10")],
        prices=[("i_ok", today, 30, 30, 1, 1, 0),
                ("i_stale", today, 30, 30, 1, 1, 0),
                ("i_wrong", today, 30, 30, 1, 1, 0)],
        members=[("i_ok", "shirt", "M", "", today),
                 ("i_stale", "shirt", "M", "", ayer),
                 ("i_wrong", "shirt", "L", "", today)])
    monkeypatch.setattr(notify, "SIMAN_DB", str(db))
    items = notify.siman_items()
    assert items["i_ok"]["avail"] is True and items["i_ok"]["eligible"]
    assert items["i_stale"]["avail"] is False, \
        "membresia de ayer no habilita el item hoy"
    assert items["i_wrong"]["avail"] is False, \
        "talla L no corresponde a la variante 10"
    # y de ahi ninguno entra a las gangas del correo
    ev = [{"type": "bajo", "iid": iid, "title": "X",
           "from": 40, "to": 30}
          for iid in ("i_ok", "i_stale", "i_wrong")]
    out = notify.siman_gangas(ev, items)
    assert [e["iid"] for e in out] == ["i_ok"]
