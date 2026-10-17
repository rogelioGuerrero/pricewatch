"""
common.py - utilidades de dominio compartidas por los scripts del pipeline.

Un solo lugar para: la fecha de negocio (GMT-6 El Salvador), la
normalizacion de titulos (paridad estricta con tkeyJS del PWA), el match
de talla de variante, la distancia aHash de imagenes, la poda de logs
JSONL y el cliente REST de Appwrite (tablas del proyecto 'pricewatch').
"""

import json
import os
import re
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# todas las fechas de negocio son GMT-6 (El Salvador): con UTC puro un
# run tardio (>6pm UTC) queda fechado "maniana" y el digest lo pierde
SV_TZ = timezone(timedelta(hours=-6))


def today_sv():
    """Fecha de negocio YYYY-MM-DD en GMT-6."""
    return datetime.now(SV_TZ).strftime("%Y-%m-%d")


TOKEN_RE = re.compile(r"[a-z0-9]+")


def norm(s):
    """minusculas, sin tildes, solo tokens [a-z0-9]; cualquier otro
    caracter (incluidos '²', 'º', '½', que Python considera
    alfanumericos) se vuelve separador. Paridad estricta con tkeyJS
    del PWA (/[^a-z0-9]+/g -> espacio)."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(TOKEN_RE.findall(s))


def tkey(title):
    """Identidad del producto que sobrevive recodificados."""
    return norm(title)


def talla_hit(vname, talla):
    """La variante corresponde a la talla pedida? '36X32'->36, 'BLUE:38'->38,
    'NAVY:L'->L. Solo matching de token exacto para no confundir 11 con 110."""
    if not talla:
        return True
    v = (vname or "").upper()
    v = re.sub(r"(?<=\d)[Xx](?=\d)", " ", v)   # 36X32 -> 36 32
    v = re.sub(r"[:/\-_,]", " ", v)
    t = str(talla).upper()
    return re.search(rf"(?<![0-9A-Z]){re.escape(t)}(?![0-9A-Z])", v) is not None


def hamming(a, b):
    """Distancia entre dos aHash hex de 64 bits; 99 si alguno es invalido."""
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except (ValueError, TypeError):
        return 99


def read_events(path):
    """Lee JSONL sin dejar que una linea truncada invalide todo el build."""
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
                if (not isinstance(e, dict)
                        or not isinstance(e.get("type"), str)
                        or not e["type"]
                        or not any(isinstance(e.get(k), str) and e[k]
                                   for k in ("sku", "iid"))
                        or not isinstance(e.get("date"), str)
                        or date.fromisoformat(e["date"]).isoformat()
                        != e["date"]):
                    continue
            except (ValueError, TypeError):
                continue
            out.append(e)
    return out


def prune_jsonl(path, keep_days=45):
    """Recorta un log JSONL a los ultimos `keep_days` dias (fecha SV):
    el sitio solo muestra los ultimos 200 eventos y el digest solo lee
    hoy; la historia longitudinal vive en las db. Sin esto el archivo
    crece sin tope. Devuelve cuantas lineas se eliminaron."""
    if not os.path.exists(path):
        return 0
    cutoff = (datetime.now(SV_TZ).date() - timedelta(days=keep_days)).isoformat()
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    keep = []
    for line in lines:
        try:
            if json.loads(line).get("date", "") >= cutoff:
                keep.append(line)
        except Exception:
            continue  # linea corrupta: fuera
    if len(keep) == len(lines):
        return 0
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.writelines(keep)
    os.replace(tmp, path)
    print(f"log podado: -{len(lines) - len(keep)} eventos "
          f"anteriores a {cutoff}")
    return len(lines) - len(keep)


# ---------------- Appwrite (REST server-side, API key) ----------------

AW_DB = "pricewatch"
# Solo create a nivel tabla: con rowSecurity las filas las protegen los
# docPerms por documento (el cliente da read/update/delete al creador).
# Dar read/update/delete("users") a nivel TABLA bypassa rowSecurity —
# cualquier usuario autenticado veria/editaria los datos de todos.
AW_PERMS_USERS = ['create("users")']
# suscribirse a push no requiere cuenta: la "identidad" es el endpoint;
# unsubscribe lo mata en origen y el sender poda filas que devuelven 404/410
AW_PERMS_PUSH = ['create("any")']

# esquema declarativo unico: lo usa setup_appwrite.py (provision
# completa) y notify.py (ensure lazy antes del digest)
APPWRITE_TABLES = {
    "favs": ("Favoritos", AW_PERMS_USERS,
             [("string", {"key": "sku", "size": 36, "required": True})]),
    "compras": ("Compras", AW_PERMS_USERS,
                [("string", {"key": "sku", "size": 36, "required": True}),
                 ("float", {"key": "paid", "required": True}),
                 ("string", {"key": "date", "size": 10, "required": True})]),
    "targets": ("Precios objetivo", AW_PERMS_USERS,
                [("string", {"key": "sku", "size": 36, "required": True}),
                 ("integer", {"key": "target", "required": True})]),
    "siman_watch": ("Siman busquedas vigiladas", AW_PERMS_USERS,
                    [("string", {"key": "q", "size": 120, "required": True}),
                     ("string", {"key": "talla", "size": 12,
                                 "required": False}),
                     ("string", {"key": "filtro", "size": 200,
                                 "required": False})]),
    "siman_muted": ("Siman productos muteados", AW_PERMS_USERS,
                    [("string", {"key": "tkey", "size": 250, "required": True})]),
    "siman_seen": ("Siman alertas vistas", AW_PERMS_USERS,
                   [("string", {"key": "tkey", "size": 250, "required": True}),
                    ("float", {"key": "price", "required": True}),
                    ("string", {"key": "date", "size": 10, "required": True})]),
    "push_subs": ("Suscripciones push", AW_PERMS_PUSH,
                  [("string", {"key": "endpoint", "size": 500,
                               "required": True}),
                   ("string", {"key": "keys", "size": 500,
                               "required": True}),
                   ("string", {"key": "ua", "size": 250,
                               "required": False})]),
}

# una sola sesion: keep-alive TLS + gzip automatico en todos los fetch
SESSION = requests.Session()
UA = {"User-Agent": "PriceWatch/1.0 (+github-actions)"}


def aw_env():
    """(endpoint, project_id, api_key) desde el env; "" si falta alguna."""
    return (os.environ.get("APPWRITE_ENDPOINT", "").rstrip("/"),
            os.environ.get("APPWRITE_PROJECT_ID", ""),
            os.environ.get("APPWRITE_API_KEY", ""))


def aw_request(method, path, body=None, timeout=20):
    """Un request al API de Appwrite -> (dict_json, status).
    ({}, 0) sin credenciales o ante falla de red."""
    ep, pid, key = aw_env()
    if not (ep and pid and key):
        return {}, 0
    try:
        r = SESSION.request(method, f"{ep}{path}", json=body,
                            headers={"X-Appwrite-Project": pid,
                                     "X-Appwrite-Key": key, **UA},
                            timeout=timeout)
    except Exception:
        return {}, 0
    try:
        return r.json() or {}, r.status_code
    except ValueError:
        return {}, r.status_code


def aw_rows(table, limit=500):
    """Filas de una tabla (hasta `limit`); [] si falla o no hay creds."""
    q = quote(json.dumps({"method": "limit", "values": [limit]}))
    res, code = aw_request("GET", f"/tablesdb/{AW_DB}/tables/{table}/rows"
                                  f"?queries%5B%5D={q}")
    return res.get("rows", []) if code == 200 else []


def aw_tables():
    """(caido, ids_de_tablas): el GET de tablas ya devuelve la lista —
    reusarla ahorra un GET por tabla en los ensure."""
    if not all(aw_env()):
        return False, set()
    res, code = aw_request("GET", f"/tablesdb/{AW_DB}/tables")
    ids = {t.get("$id") or t.get("tableId") or t.get("id")
           for t in res.get("tables", [])}
    return code != 200, {i for i in ids if i}


def ensure_table(table, known=None):
    """Crea `table` (declarada en APPWRITE_TABLES) con sus columnas si
    no existe y espera a que queden available. Idempotente."""
    name, perms, cols = APPWRITE_TABLES[table]
    if known is not None and table in known:
        return
    _, code = aw_request("GET", f"/tablesdb/{AW_DB}/tables/{table}")
    if code == 200:
        return
    res, code = aw_request("POST", f"/tablesdb/{AW_DB}/tables", {
        "tableId": table, "name": name,
        "permissions": perms, "rowSecurity": True, "enabled": True})
    if code not in (200, 201, 409):
        print(f"  ! {table}: HTTP {code} {res.get('message')}")
        return
    for kind, kw in cols:
        aw_request("POST",
                   f"/tablesdb/{AW_DB}/tables/{table}/columns/{kind}", kw)
    # las columnas se crean async; esperar a que queden available
    for _ in range(20):
        time.sleep(1)
        r, _ = aw_request("GET", f"/tablesdb/{AW_DB}/tables/{table}")
        st = {c["key"]: c["status"]
              for c in r.get("columns", r.get("attributes", []))}
        if st and all(v == "available" for v in st.values()):
            break
    print(f"  + {table} lista")
