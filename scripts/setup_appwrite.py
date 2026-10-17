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

import sys
import time

from common import APPWRITE_TABLES, AW_DB, aw_env, aw_request


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
    ep, project, key = aw_env()
    if not (ep and project and key):
        print("faltan credenciales: definir APPWRITE_ENDPOINT, "
              "APPWRITE_PROJECT_ID y APPWRITE_API_KEY")
        sys.exit(1)

    print("Database:")
    _, code = aw_request("GET", f"/tablesdb/{AW_DB}")
    if code == 200:
        print("  = pricewatch (tablesdb): ya existe")
    elif code == 404:
        # puede quedar una DB legacy (documentsdb) ocupando el slot —
        # NUNCA se borra sola: sus datos requieren backup + migracion
        # manual aprobada por el owner antes de recrear nada
        legacy, lcode = aw_request("GET", f"/databases/{AW_DB}")
        if lcode == 200:
            print(f"  ! existe database legacy '{AW_DB}' "
                  f"(type={legacy.get('type')})")
            print("    requiere backup + migracion manual aprobada; "
                  "este script no la borra ni crea la tablesdb encima")
            sys.exit(1)
        if lcode != 404:
            print(f"  ! GET /databases/{AW_DB}: HTTP {lcode} "
                  "— abortando antes de escribir")
            sys.exit(1)
        ensure("POST", "/tablesdb",
               {"databaseId": AW_DB, "name": "PriceWatch", "enabled": True},
               "pricewatch (tablesdb)")
    else:
        print(f"  ! GET /tablesdb/{AW_DB}: HTTP {code} "
              "— abortando antes de escribir")
        sys.exit(1)

    print("Tablas:")
    for t, (name, perms, _cols) in APPWRITE_TABLES.items():
        _, code = aw_request("GET", f"/tablesdb/{AW_DB}/tables/{t}")
        if code == 200:
            print(f"  = {t}: ya existe")
        elif code == 404:
            ensure("POST", f"/tablesdb/{AW_DB}/tables",
                   {"tableId": t, "name": name, "permissions": perms,
                    "rowSecurity": True, "enabled": True}, t)
        else:
            print(f"  ! GET tabla {t}: HTTP {code} "
                  "— abortando antes de escribir")
            sys.exit(1)

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
    res, code = aw_request("PATCH", f"/projects/{project}/auth/email-password",
                           {"enabled": True})
    print("  + habilitado" if code in (200, 201)
          else f"  ! HTTP {code} {res.get('message')} "
               "(habilitalo a mano en consola)")

    print("Platforms web (CORS):")
    res, _ = aw_request("GET", f"/projects/{project}/platforms")
    existing = {p.get("hostname") for p in res.get("platforms", [])}
    for host, name in [("localhost", "dev"),
                       ("rogelioguerrero.github.io", "GitHub Pages")]:
        if host in existing:
            print(f"  = {host}: ya existe")
        else:
            ensure("POST", f"/projects/{project}/platforms",
                   {"type": "web", "name": name, "key": host,
                    "hostname": host,
                    "platformId": f"pw-{host.split('.')[0]}"}, host)

    print("\nListo. Sync del PWA contra:", ep)


if __name__ == "__main__":
    main()
