"""
setup_appwrite.py - Provisiona Appwrite Cloud (API tablesdb) para el sync del PWA.

Crea (idempotente):
  - database "pricewatch" (tipo tablesdb)
  - las tablas declaradas en common.APPWRITE_TABLES (favs, compras,
    targets, siman_*, push_subs) con row-level security
  - platforms web para CORS: localhost + GitHub Pages
  - auth email/password habilitado

Uso:
    set APPWRITE_ENDPOINT=https://sfo.cloud.appwrite.io/v1
    set APPWRITE_PROJECT_ID=...
    set APPWRITE_API_KEY=...
    python scripts/setup_appwrite.py
"""

import os
import sys
import time

from common import APPWRITE_TABLES, AW_DB, aw_request

ENDPOINT = os.environ["APPWRITE_ENDPOINT"].rstrip("/")
PROJECT = os.environ["APPWRITE_PROJECT_ID"]
KEY = os.environ["APPWRITE_API_KEY"]


def ensure(method, path, body, what):
    res, code = aw_request(method, path, body)
    if code in (200, 201):
        print(f"  + {what}: creado")
    elif code == 409:
        print(f"  = {what}: ya existe")
    else:
        print(f"  ! {what}: HTTP {code} {res.get('message')}")
        sys.exit(1)


def main():
    print("Database:")
    _, code = aw_request("GET", f"/tablesdb/{AW_DB}")
    if code == 200:
        print("  = pricewatch (tablesdb): ya existe")
    else:
        # si existe una DB legacy (documentsdb) con el mismo id, hay que
        # liberar el slot: el plan free permite 1 sola database
        legacy, code = aw_request("GET", f"/databases/{AW_DB}")
        if code == 200 and legacy.get("type") != "tablesdb":
            aw_request("DELETE", f"/databases/{AW_DB}")
            print("  - documentsdb 'pricewatch' eliminada (vacia, legado)")
        ensure("POST", "/tablesdb",
               {"databaseId": AW_DB, "name": "PriceWatch", "enabled": True},
               "pricewatch (tablesdb)")

    print("Tablas:")
    for t, (name, perms, _cols) in APPWRITE_TABLES.items():
        _, code = aw_request("GET", f"/tablesdb/{AW_DB}/tables/{t}")
        if code == 200:
            print(f"  = {t}: ya existe")
        else:
            ensure("POST", f"/tablesdb/{AW_DB}/tables",
                   {"tableId": t, "name": name, "permissions": perms,
                    "rowSecurity": True, "enabled": True}, t)

    print("Columnas:")
    for t, (_name, _perms, cols) in APPWRITE_TABLES.items():
        for kind, kw in cols:
            path = f"/tablesdb/{AW_DB}/tables/{t}/columns/{kind}"
            res, code = aw_request("POST", path, kw)
            if code in (200, 201, 202):  # 202 = aceptada, se crea async
                print(f"  + {t}.{kw['key']}: creada")
            elif code == 409:
                print(f"  = {t}.{kw['key']}: ya existe")
            else:
                print(f"  ! {t}.{kw['key']}: HTTP {code} "
                      f"{res.get('message')}")
                sys.exit(1)

    # las columnas se crean async; esperar a que queden available
    st = {}
    for _ in range(30):
        time.sleep(1)
        r, _ = aw_request("GET", f"/tablesdb/{AW_DB}/tables/compras")
        st = {a["key"]: a["status"]
              for a in r.get("columns", r.get("attributes", []))}
        if st and all(v == "available" for v in st.values()):
            break
    print("  columnas:", st)

    print("Auth email/password:")
    res, code = aw_request("PATCH", f"/projects/{PROJECT}/auth/email-password",
                           {"enabled": True})
    print("  + habilitado" if code in (200, 201)
          else f"  ! HTTP {code} {res.get('message')} "
               "(habilitalo a mano en consola)")

    print("Platforms web (CORS):")
    res, _ = aw_request("GET", f"/projects/{PROJECT}/platforms")
    existing = {p.get("hostname") for p in res.get("platforms", [])}
    for host, name in [("localhost", "dev"),
                       ("rogelioguerrero.github.io", "GitHub Pages")]:
        if host in existing:
            print(f"  = {host}: ya existe")
        else:
            ensure("POST", f"/projects/{PROJECT}/platforms",
                   {"type": "web", "name": name, "key": host,
                    "hostname": host,
                    "platformId": f"pw-{host.split('.')[0]}"}, host)

    print("\nListo. Sync del PWA contra:", ENDPOINT)


if __name__ == "__main__":
    main()
