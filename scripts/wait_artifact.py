"""
wait_artifact.py - Espera a que un artefacto del run sea visible.

upload-pages-artifact devuelve exito apenas termina la subida, pero la
metadata del API de artifacts tarda en propagarse: deploy-pages@v4 en el
mismo run puede consultar y encontrar 0 artefactos (run #36). Este
script espera (poll acotado) a que el API liste el artefacto con ese
nombre antes de dejar correr el deploy.

Uso:
    GH_TOKEN=... python scripts/wait_artifact.py --name github-pages
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote


def gh_error(title, msg):
    """::error:: workflow command, escapado como en common.py — copia
    local para no arrastrar el import de requests en un script de
    espera que debe ser stdlib puro."""
    msg = (str(msg)[:300].replace("%", "%25")
           .replace(chr(13), "%0D").replace(chr(10), "%0A"))
    print(f"::error title={title}::{msg}")



def wait_for_artifact(name, timeout, interval, fetch, sleep):
    """Poll hasta que fetch() liste `name` no expirado -> seg esperados.
    None si se agota `timeout`. Errores transitorios (red, 5xx, 404) se
    toleran; 401/403 propagan de inmediato (token/permisos, no es race).
    """
    elapsed = 0
    while True:
        try:
            data = fetch(name)
            for a in data.get("artifacts") or []:
                if a.get("name") == name and not a.get("expired"):
                    return elapsed
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise
            # el listado del run aun no propaga: seguir esperando
        except Exception:
            pass
        if elapsed + interval > timeout:
            return None
        sleep(interval)
        elapsed += interval


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="github-pages")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--interval", type=int, default=5)
    args = parser.parse_args(argv)
    try:
        repo = os.environ["GITHUB_REPOSITORY"]
        run_id = os.environ["GITHUB_RUN_ID"]
        token = os.environ["GH_TOKEN"]
    except KeyError as e:
        print(f"falta variable de entorno {e}", file=sys.stderr)
        return 1

    def fetch(name):
        url = ("https://api.github.com/repos/" + repo
               + "/actions/runs/" + run_id
               + "/artifacts?name=" + quote(name))
        req = urllib.request.Request(url, headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "User-Agent": "pricewatch"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)

    try:
        waited = wait_for_artifact(args.name, args.timeout, args.interval,
                                   fetch, time.sleep)
    except urllib.error.HTTPError as e:
        gh_error("Artefacto no visible",
                 f"HTTP {e.code}: revisar GH_TOKEN / permiso actions:read")
        return 1
    if waited is None:
        gh_error("Artefacto no visible",
                 f"'{args.name}' no aparecio en el API tras "
                 f"{args.timeout}s de espera")
        return 1
    print(f"artefacto listo tras {waited}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
