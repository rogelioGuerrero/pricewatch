"""
setup_appwrite.py - Provisiona Appwrite Cloud (API tablesdb) para el sync del PWA.

Crea (idempotente):
  - database "pricewatch" (tipo tablesdb)
  - tabla "favs"    {sku}              — row id = <userId>-<sku>
  - tabla "compras" {sku, paid, date}  — row id unico
  - seguridad a nivel fila (cada row solo la ve su dueno)
  - platforms web para CORS: localhost + GitHub Pages
  - auth email/password habilitado

Uso:
    set APPWRITE_ENDPOINT=https://sfo.cloud.appwrite.io/v1
    set APPWRITE_PROJECT_ID=...
    set APPWRITE_API_KEY=...
    python scripts/setup_appwrite.py
"""

import json
import os
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ENDPOINT = os.environ["APPWRITE_ENDPOINT"].rstrip("/")
PROJECT = os.environ["APPWRITE_PROJECT_ID"]
KEY = os.environ["APPWRITE_API_KEY"]

DB = "pricewatch"
PERMS_USERS = ['create("users")', 'read("users")',
               'update("users")', 'delete("users")']


def api(method, path, body=None):
    req = Request(f"{ENDPOINT}{path}", method=method,
                  data=json.dumps(body).encode() if body is not None else None,
                  headers={"content-type": "application/json",
                           "X-Appwrite-Project": PROJECT,
                           "X-Appwrite-Key": KEY})
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}"), r.status
    except HTTPError as e:
        raw = e.read() or b"{}"
        try:
            return json.loads(raw), e.code
        except json.JSONDecodeError:
            return {"message": raw[:300].decode("utf-8", "replace")}, e.code


def ensure(method, path, body, what):
    res, code = api(method, path, body)
    if code in (200, 201):
        print(f"  + {what}: creado")
    elif code == 409:
        print(f"  = {what}: ya existe")
    else:
        print(f"  ! {what}: HTTP {code} {res.get('message')}")
        sys.exit(1)


print("Database:")
_, code = api("GET", f"/tablesdb/{DB}")
if code == 200:
    print("  = pricewatch (tablesdb): ya existe")
else:
    # si existe una DB legacy (documentsdb) con el mismo id, hay que
    # liberar el slot: el plan free permite 1 sola database
    legacy, code = api("GET", f"/databases/{DB}")
    if code == 200 and legacy.get("type") != "tablesdb":
        api("DELETE", f"/databases/{DB}")
        print("  - documentsdb 'pricewatch' eliminada (vacia, legado)")
    ensure("POST", "/tablesdb",
           {"databaseId": DB, "name": "PriceWatch", "enabled": True},
           "pricewatch (tablesdb)")

print("Tablas:")
for t, name in [("favs", "Favoritos"), ("compras", "Compras"),
                ("siman_watch", "Siman busquedas vigiladas"),
                ("siman_muted", "Siman productos muteados"),
                ("siman_seen", "Siman alertas vistas")]:
    _, code = api("GET", f"/tablesdb/{DB}/tables/{t}")
    if code == 200:
        print(f"  = {t}: ya existe")
    else:
        ensure("POST", f"/tablesdb/{DB}/tables",
               {"tableId": t, "name": name, "permissions": PERMS_USERS,
                "rowSecurity": True, "enabled": True}, t)

print("Columnas:")
def col(table, kind, key, **kw):
    path = f"/tablesdb/{DB}/tables/{table}/columns/{kind}"
    res, code = api("POST", path, {"key": key, **kw})
    if code in (200, 201, 202):  # 202 = aceptada, se crea async
        print(f"  + {table}.{key}: creada")
    elif code == 409:
        print(f"  = {table}.{key}: ya existe")
    else:
        print(f"  ! {table}.{key}: HTTP {code} {res.get('message')}")
        sys.exit(1)

col("favs", "string", "sku", size=36, required=True)
col("compras", "string", "sku", size=36, required=True)
col("compras", "float", "paid", required=True)
col("compras", "string", "date", size=10, required=True)
col("siman_watch", "string", "q", size=120, required=True)
col("siman_watch", "string", "talla", size=12, required=False)
col("siman_watch", "string", "filtro", size=200, required=False)
col("siman_muted", "string", "tkey", size=250, required=True)
col("siman_seen", "string", "tkey", size=250, required=True)
col("siman_seen", "float", "price", required=True)
col("siman_seen", "string", "date", size=10, required=True)

# las columnas se crean async; esperar a que queden available
st = {}
for _ in range(30):
    time.sleep(1)
    r, _ = api("GET", f"/tablesdb/{DB}/tables/compras")
    st = {a["key"]: a["status"]
          for a in r.get("columns", r.get("attributes", []))}
    if st and all(v == "available" for v in st.values()):
        break
print("  columnas:", st)

print("Auth email/password:")
res, code = api("PATCH", f"/projects/{PROJECT}/auth/email-password",
                {"enabled": True})
print("  + habilitado" if code in (200, 201)
      else f"  ! HTTP {code} {res.get('message')} (habilitalo a mano en consola)")

print("Platforms web (CORS):")
res, _ = api("GET", f"/projects/{PROJECT}/platforms")
existing = {p.get("hostname") for p in res.get("platforms", [])}
for host, name in [("localhost", "dev"),
                   ("rogelioguerrero.github.io", "GitHub Pages")]:
    if host in existing:
        print(f"  = {host}: ya existe")
    else:
        ensure("POST", f"/projects/{PROJECT}/platforms",
               {"type": "web", "name": name, "key": host, "hostname": host,
                "platformId": f"pw-{host.split('.')[0]}"}, host)

print("\nListo. Sync del PWA contra:", ENDPOINT)
