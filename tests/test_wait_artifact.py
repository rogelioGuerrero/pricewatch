"""wait_artifact.py — el API de artifacts tarda en ver la subida.

upload-pages-artifact exitoso != deploy-pages lo ve (run #36: 0
artefactos 1s despues). El poll tolera errores transitorios pero un
401/403 es de token/permisos: falla al instante, no en el timeout.
"""

import urllib.error

import pytest
import wait_artifact as wa


def _arts(name, expired=False):
    return {"artifacts": [{"name": name, "expired": expired}]}


def test_encontrado_de_inmediato():
    got = wa.wait_for_artifact("github-pages", 180, 5,
                               lambda n: _arts("github-pages"),
                               lambda s: None)
    assert got == 0


def test_encontrado_al_tercer_poll():
    polls = []

    def fetch(name):
        polls.append(name)
        return {"artifacts": []} if len(polls) < 3 else _arts(name)
    slept = []
    assert wa.wait_for_artifact("github-pages", 180, 5, fetch,
                                slept.append) == 10
    assert slept == [5, 5]


def test_timeout_devuelve_none():
    polls = []

    def fetch(name):
        polls.append(name)
        return {"artifacts": []}
    assert wa.wait_for_artifact("github-pages", 12, 5, fetch,
                                lambda s: None) is None
    assert len(polls) == 3   # consultas en t=0, 5, 10


def test_403_falla_al_instante_sin_reintentar():
    err = urllib.error.HTTPError("url", 403, "Forbidden", {}, None)
    polls = []

    def fetch(name):
        polls.append(name)
        raise err
    with pytest.raises(urllib.error.HTTPError):
        wa.wait_for_artifact("github-pages", 180, 5, fetch, lambda s: None)
    assert len(polls) == 1


def test_error_de_red_se_tolera_y_sigue():
    polls = []

    def fetch(name):
        polls.append(name)
        if len(polls) == 1:
            raise OSError("conexion caida")
        return _arts(name)
    assert wa.wait_for_artifact("github-pages", 180, 5, fetch,
                                lambda s: None) == 5


def test_artefacto_expirado_no_cuenta():
    polls = []

    def fetch(name):
        polls.append(name)
        return (_arts(name, expired=True) if len(polls) == 1
                else _arts(name))
    assert wa.wait_for_artifact("github-pages", 180, 5, fetch,
                                lambda s: None) == 5
