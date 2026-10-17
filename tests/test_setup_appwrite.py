"""Tests de setup_appwrite.py — todo mockeado, jamas toca la red.

Guardas del provisionador: una DB legacy NUNCA se borra sola (sus
datos requieren backup + migracion manual), un GET con error inesperado
aborta antes de cualquier escritura, y sin credenciales no se hace ni
un solo request.
"""

import pytest
import setup_appwrite
from common import APPWRITE_TABLES, AW_DB, AW_PERMS_PUSH, AW_PERMS_USERS

ENV = {"APPWRITE_ENDPOINT": "https://aw.test/v1",
       "APPWRITE_PROJECT_ID": "p1", "APPWRITE_API_KEY": "k1"}
WRITE = ("POST", "PATCH", "PUT", "DELETE")


class Rec:
    """aw_request falso: devuelve lo declarado en routes y recuerda."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, path, body=None, timeout=20):
        self.calls.append((method, path, body))
        v = self.routes.get((method, path), ({}, 500))
        if isinstance(v, list):   # respuestas en secuencia
            return v.pop(0) if v else ({}, 500)
        return v

    def writes(self):
        return [c for c in self.calls if c[0] in WRITE]


def run_main(monkeypatch, routes):
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    rec = Rec(routes)
    monkeypatch.setattr(setup_appwrite, "aw_request", rec)
    with pytest.raises(SystemExit) as exc:
        setup_appwrite.main()
    return rec, exc.value


def test_db_legacy_existente_jamas_se_borra(monkeypatch):
    rec, code = run_main(monkeypatch, {
        ("GET", f"/tablesdb/{AW_DB}"): ({}, 404),
        ("GET", f"/databases/{AW_DB}"): ({"type": "documentsdb"}, 200),
    })
    assert code.code == 1
    assert rec.writes() == [], "no DELETE/POST sobre la legacy"


def test_error_http_en_get_db_aborta_sin_escrituras(monkeypatch):
    for bad in (500, 401, 403, 0):
        rec, code = run_main(monkeypatch, {
            ("GET", f"/tablesdb/{AW_DB}"): ({}, bad)})
        assert code.code == 1
        assert rec.writes() == []
        assert not any(c[1] == f"/databases/{AW_DB}" for c in rec.calls), \
            "no consulta legacy cuando el GET primario no es 404"


def test_legacy_get_inesperado_aborta_sin_escrituras(monkeypatch):
    # primary 404 -> se consulta legacy; si ESE GET no es 200 ni 404
    # tampoco se toca nada
    for bad in (500, 0):
        rec, code = run_main(monkeypatch, {
            ("GET", f"/tablesdb/{AW_DB}"): ({}, 404),
            ("GET", f"/databases/{AW_DB}"): ({}, bad)})
        assert code.code == 1
        assert rec.writes() == []


def test_ambos_404_si_crea_database_sin_delete(monkeypatch):
    rec, _code = run_main(monkeypatch, {
        ("GET", f"/tablesdb/{AW_DB}"): ({}, 404),
        ("GET", f"/databases/{AW_DB}"): ({}, 404),
        ("POST", "/tablesdb"): ({}, 201),
        # la primera tabla GET no esta declarada -> Rec devuelve 500
        # y main aborta ahi; solo importa el POST de creacion
    })
    assert rec.writes() == [
        ("POST", "/tablesdb",
         {"databaseId": AW_DB, "name": "PriceWatch", "enabled": True})]
    assert not any(c[0] == "DELETE" for c in rec.calls)


def test_error_http_en_get_tabla_aborta_sin_mas_escrituras(monkeypatch):
    rec, code = run_main(monkeypatch, {
        ("GET", f"/tablesdb/{AW_DB}"): ({}, 200),
        ("GET", f"/tablesdb/{AW_DB}/tables/favs"): ({}, 500),
    })
    assert code.code == 1
    assert rec.writes() == []


def test_sin_credenciales_no_hay_llamadas(monkeypatch):
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    rec = Rec({})
    monkeypatch.setattr(setup_appwrite, "aw_request", rec)
    with pytest.raises(SystemExit):
        setup_appwrite.main()
    assert rec.calls == [], "sin env ni siquiera lee"


def test_tablas_nuevas_solo_permiso_create_y_rowsecurity(monkeypatch):
    routes = {("GET", f"/tablesdb/{AW_DB}"): ({}, 200),
              ("PATCH", f"/projects/{ENV['APPWRITE_PROJECT_ID']}"
                        "/auth/email-password"): ({}, 200),
              ("GET", f"/projects/{ENV['APPWRITE_PROJECT_ID']}/platforms"):
                  ({"platforms": [{"hostname": "localhost"},
                                  {"hostname": "rogelioguerrero.github.io"}]},
                   200)}
    for t, (_name, _perms, cols) in APPWRITE_TABLES.items():
        routes[("GET", f"/tablesdb/{AW_DB}/tables/{t}")] = ({}, 404)
        routes[("POST", f"/tablesdb/{AW_DB}/tables")] = ({}, 201)
        for kind, _kw in cols:
            routes[("POST", f"/tablesdb/{AW_DB}/tables/{t}"
                            f"/columns/{kind}")] = ({}, 202)
    # compras se consulta dos veces: en el loop de tablas (404, se crea)
    # y luego en el poll de columnas available (sale a la primera)
    routes[("GET", f"/tablesdb/{AW_DB}/tables/compras")] = [
        ({}, 404),
        ({"columns": [{"key": "x", "status": "available"}]}, 200)]
    monkeypatch.setattr("time.sleep", lambda *a: None)
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    rec = Rec(routes)
    monkeypatch.setattr(setup_appwrite, "aw_request", rec)
    setup_appwrite.main()   # recorrido feliz completo, sin exit
    posts = [b for m, p, b in rec.calls
             if m == "POST" and p == f"/tablesdb/{AW_DB}/tables"]
    assert len(posts) == len(APPWRITE_TABLES)
    for b in posts:
        assert b["rowSecurity"] is True
        if b["tableId"] == "push_subs":
            assert b["permissions"] == AW_PERMS_PUSH
        else:
            assert b["permissions"] == AW_PERMS_USERS
            # la guardia contra table-level r/w/d que bypassa rowSecurity
            assert b["permissions"] == ['create("users")']


def test_aw_perms_users_es_solo_create():
    assert AW_PERMS_USERS == ['create("users")']
