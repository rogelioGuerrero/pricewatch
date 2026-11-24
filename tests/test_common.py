"""Tests de common.aw_rows — paginacion por cursor sobre Appwrite.

Todo con aw_env/aw_request stubeados: ningun test toca la red ni
necesita credenciales reales."""

import json
import urllib.parse
from unittest.mock import patch

import common
import pytest


def _pages(pages):
    """aw_request fake: cada llamada devuelve la pagina siguiente."""
    it = iter(pages)
    def fake(method, path, body=None, timeout=20):
        return next(it)
    return fake


def _env():
    return ("https://fixture.invalid/v1", "proj", "key")


def test_pagina_sobre_cursor_hasta_pagina_corta():
    rows = [{"$id": str(i)} for i in range(5)]
    pages = [({"rows": rows[:2]}, 200),
             ({"rows": rows[2:4]}, 200),
             ({"rows": rows[4:]}, 200)]
    with patch.object(common, "aw_env", _env), \
            patch.object(common, "aw_request", _pages(pages)):
        out = common.aw_rows("favs", limit=2, strict=True)
    assert [r["$id"] for r in out] == ["0", "1", "2", "3", "4"]


def test_mas_de_500_filas_paginadas_devuelve_todas():
    """>500 filas con el limit por defecto: cursor real, todo vuelve."""
    rows = [{"$id": f"{i:04d}"} for i in range(650)]
    pages = [({"rows": rows[:500]}, 200), ({"rows": rows[500:]}, 200)]
    with patch.object(common, "aw_env", _env), \
            patch.object(common, "aw_request", _pages(pages)):
        out = common.aw_rows("favs", strict=True)
    assert len(out) == 650
    assert out[0]["$id"] == "0000" and out[-1]["$id"] == "0649"


def test_pagina2_falla_strict_lanza_y_nunca_parcial():
    pages = [({"rows": [{"$id": "1"}, {"$id": "2"}]}, 200),
             ({}, 503)]
    with patch.object(common, "aw_env", _env), \
            patch.object(common, "aw_request", _pages(pages)):
        with pytest.raises(common.AppwriteReadError):
            common.aw_rows("favs", limit=2, strict=True)
    pages = [({"rows": [{"$id": "1"}, {"$id": "2"}]}, 200),
             ({}, 503)]
    with patch.object(common, "aw_env", _env), \
            patch.object(common, "aw_request", _pages(pages)):
        # no-strict: [] siempre — jamas devuelve la mitad de la tabla
        assert common.aw_rows("favs", limit=2) == []


def test_cursor_estancado_lanza():
    """cursorAfter que no avanza (API ignorandolo) es error, no loop."""
    page = {"rows": [{"$id": "1"}, {"$id": "2"}]}
    pages = [(page, 200), (page, 200)]
    with patch.object(common, "aw_env", _env), \
            patch.object(common, "aw_request", _pages(pages)):
        with pytest.raises(common.AppwriteReadError):
            common.aw_rows("favs", limit=2, strict=True)


def test_vacio_valido_devuelve_lista_vacia():
    pages = [({"rows": []}, 200)]
    with patch.object(common, "aw_env", _env), \
            patch.object(common, "aw_request", _pages(pages)):
        assert common.aw_rows("favs", strict=True) == []


def test_queries_orden_y_cursor_en_la_url():
    """limit+orderAsc siempre; cursorAfter solo desde la pagina 2."""
    seen = []
    it = iter([({"rows": [{"$id": "9"}]}, 200), ({"rows": []}, 200)])
    def fake2(method, path, body=None, timeout=20):
        seen.append(path)
        return next(it)
    with patch.object(common, "aw_env", _env), \
            patch.object(common, "aw_request", fake2):
        common.aw_rows("favs", limit=1, strict=True)
    assert len(seen) == 2
    decoded = [[json.loads(urllib.parse.unquote(p.split("=", 1)[1]))
                for p in path.split("?")[1].split("&")
                if p.startswith("queries%5B%5D=")]
               for path in seen]
    assert decoded[0][:2] == [
        {"method": "limit", "values": [1]},
        {"method": "orderAsc", "values": ["$id"]}]
    assert not any(q["method"] == "cursorAfter" for q in decoded[0])
    assert {"method": "cursorAfter", "values": ["9"]} in decoded[1]


def test_sin_config_non_strict_vacio_y_strict_lanza():
    with patch.object(common, "aw_env", return_value=(None, None, None)):
        assert common.aw_rows("favs") == []
        with pytest.raises(common.AppwriteReadError):
            common.aw_rows("favs", strict=True)


# ---------- gh_* annotations / step summary ----------

def test_gh_niveles_mismo_escape(capsys):
    """error/warning/notice comparten escape y recorte via _gh_cmd."""
    msg = "100%" + chr(10) + "x"
    common.gh_error("T", msg)
    common.gh_warning("T", msg)
    common.gh_notice("T", msg)
    esc = "100%25%0Ax"
    assert capsys.readouterr().out.splitlines() == [
        f"::error title=T::{esc}",
        f"::warning title=T::{esc}",
        f"::notice title=T::{esc}"]


def test_gh_error_trunca_a_300(capsys):
    common.gh_error("T", "x" * 400)
    assert capsys.readouterr().out.strip() == \
        "::error title=T::" + "x" * 300


def test_gh_summary_escribe_solo_con_env(monkeypatch, tmp_path):
    f = tmp_path / "summary.md"
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    common.gh_summary("no-op fuera de CI")  # sin env: no explota ni crea
    assert not f.exists()
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(f))
    common.gh_summary("### Titulo\n- linea")
    common.gh_summary("- otra")
    assert f.read_text(encoding="utf-8") == \
        "### Titulo\n- linea\n- otra\n"
