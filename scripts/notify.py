"""
notify.py - Digest por correo + alertas push. Corre como ultimo paso
del stock-check (~8am SV), cuando los 3 sweeps del dia ya cerraron.

Regla: molestar solo cuando sea necesario.

PUSH (interrumpe — algo que hacer hoy):
  * favorito bajo / rebaja / oferta nueva
  * producto a precio objetivo (targets del PWA)
  * favorito a precio de resurtir (<= lo que pagaste)
  * rebaja silenciosa grande (>=30%), aunque no sea favorito
  * ganga Siman nueva (bajo/oferta, no muteada ni ya vista)

EMAIL (digest consultable): solo si hubo eventos hoy o hits de lista.

Env:
  RESEND_API_KEY, RESEND_FROM, RESEND_TO      — email via Resend
  VAPID_PUBLIC, VAPID_PRIVATE                 — web push
  APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, APPWRITE_API_KEY
                                              — favs/compras/push_subs
  SITE_URL                                    — links del digest
"""

import json
import os
import sqlite3
import statistics
import sys
import time
import unicodedata
from html import escape as hesc

if hasattr(sys.stdout, "reconfigure"):   # consolas cp1252 (Windows)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
EVENTS_LOG = os.path.join(DATA, "events.jsonl")
SIMAN_LOG = os.path.join(DATA, "siman_events.jsonl")
DB = os.path.join(DATA, "prices.db")
SIMAN_DB = os.path.join(DATA, "siman.db")

AW_EP = os.environ.get("APPWRITE_ENDPOINT", "").rstrip("/")
AW_PID = os.environ.get("APPWRITE_PROJECT_ID", "")
AW_KEY = os.environ.get("APPWRITE_API_KEY", "")
AW_DB = "pricewatch"

SITE = os.environ.get("SITE_URL",
                      "https://rogelioguerrero.github.io/pricewatch/")
TODAY = datetime.now(timezone(timedelta(hours=-6))).date().isoformat()
FRESH_DAYS = 30          # ganga "al minimo" vence a los 30d sin moverse
BIG_DROP = -30.0         # rebaja silenciosa >=30% amerita push


def money(c):
    return "—" if c is None else f"${c / 100:.2f}"


def tkey(s):
    """Espejo de tkeyJS del frontend: minúsculas, sin acentos,
    no-alfanumérico → un espacio, bordes recortados."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join("".join(c if c.isalnum() else " " for c in s).split())


# ---------------- Appwrite (server-side, API key) ----------------

UA = {"User-Agent": "PriceWatch-Notify/1.0 (+github-actions)"}


def aw(method, path, body=None):
    if not (AW_EP and AW_PID and AW_KEY):
        return {}, 0
    req = Request(f"{AW_EP}{path}", method=method,
                  data=json.dumps(body).encode() if body is not None else None,
                  headers={"content-type": "application/json",
                           "X-Appwrite-Project": AW_PID,
                           "X-Appwrite-Key": AW_KEY, **UA})
    try:
        with urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}"), r.status
    except HTTPError as e:
        try:
            return json.loads(e.read() or b"{}"), e.code
        except json.JSONDecodeError:
            return {}, e.code
    except Exception:
        return {}, 0


def aw_rows(table):
    q = quote('{"method":"limit","values":[500]}')
    res, code = aw("GET", f"/tablesdb/{AW_DB}/tables/{table}/rows"
                         f"?queries%5B%5D={q}")
    return res.get("rows", []) if code == 200 else []


def aw_health():
    """True si Appwrite no responde bien con creds (pausada por
    inactividad o caida). Sin creds es corrida local: no aplica."""
    if not (AW_EP and AW_PID and AW_KEY):
        return False
    _, code = aw("GET", f"/tablesdb/{AW_DB}/tables")
    return code != 200


# consola del proyecto (region va embebida en el endpoint: sfo.cloud...)
AW_CONSOLE = ("https://cloud.appwrite.io/console/project-"
              + AW_EP.split("//")[-1].split(".")[0] + "-" + AW_PID)


def ensure_push_table():
    """Crea push_subs si falta — el correo/digest no depende de ella."""
    _, code = aw("GET", f"/tablesdb/{AW_DB}/tables/push_subs")
    if code == 200:
        return
    res, code = aw("POST", f"/tablesdb/{AW_DB}/tables", {
        "tableId": "push_subs", "name": "Suscripciones push",
        # cualquiera puede suscribirse (no requiere cuenta); solo el
        # servidor lee/borra — unsubscribe mata el endpoint en origen
        # y el sender lo poda al recibir 404/410
        "permissions": ['create("any")'], "rowSecurity": True,
        "enabled": True})
    if code not in (200, 201, 409):
        print(f"  ! push_subs: HTTP {code} {res.get('message')}")
        return
    for kind, kw in [("string", {"key": "endpoint", "size": 500,
                                 "required": True}),
                     ("string", {"key": "keys", "size": 500,
                                 "required": True}),
                     ("string", {"key": "ua", "size": 250,
                                 "required": False})]:
        aw("POST", f"/tablesdb/{AW_DB}/tables/push_subs/columns/{kind}", kw)
    for _ in range(20):
        time.sleep(1)
        r, _ = aw("GET", f"/tablesdb/{AW_DB}/tables/push_subs")
        st = {c["key"]: c["status"]
              for c in r.get("columns", r.get("attributes", []))}
        if st and all(v == "available" for v in st.values()):
            break
    print("  + push_subs lista")


def ensure_targets_table():
    """Crea targets si falta — el sync del PWA escribe directo ahi."""
    _, code = aw("GET", f"/tablesdb/{AW_DB}/tables/targets")
    if code == 200:
        return
    res, code = aw("POST", f"/tablesdb/{AW_DB}/tables", {
        "tableId": "targets", "name": "Precios objetivo",
        "permissions": ['create("users")', 'read("users")',
                        'update("users")', 'delete("users")'],
        "rowSecurity": True, "enabled": True})
    if code not in (200, 201, 409):
        print(f"  ! targets: HTTP {code} {res.get('message')}")
        return
    for kind, kw in [("string", {"key": "sku", "size": 36,
                                 "required": True}),
                     ("integer", {"key": "target", "required": True})]:
        aw("POST", f"/tablesdb/{AW_DB}/tables/targets/columns/{kind}", kw)
    for _ in range(20):
        time.sleep(1)
        r, _ = aw("GET", f"/tablesdb/{AW_DB}/tables/targets")
        st = {c["key"]: c["status"]
              for c in r.get("columns", r.get("attributes", []))}
        if st and all(v == "available" for v in st.values()):
            break
    print("  + targets lista")


def ensure_siman_tables():
    """Crea siman_watch/muted/seen si faltan — el sync del PWA las usa
    directo desde el navegador; sin ellas el sync pegaba 404 en loop."""
    spec = [
        ("siman_watch", "Siman busquedas vigiladas",
         [("string", {"key": "q", "size": 120, "required": True}),
          ("string", {"key": "talla", "size": 12, "required": False}),
          ("string", {"key": "filtro", "size": 200, "required": False})]),
        ("siman_muted", "Siman productos muteados",
         [("string", {"key": "tkey", "size": 250, "required": True})]),
        ("siman_seen", "Siman alertas vistas",
         [("string", {"key": "tkey", "size": 250, "required": True}),
          ("float", {"key": "price", "required": True}),
          ("string", {"key": "date", "size": 10, "required": True})]),
    ]
    for t, name, cols in spec:
        _, code = aw("GET", f"/tablesdb/{AW_DB}/tables/{t}")
        if code == 200:
            continue
        res, code = aw("POST", f"/tablesdb/{AW_DB}/tables", {
            "tableId": t, "name": name,
            "permissions": ['create("users")', 'read("users")',
                            'update("users")', 'delete("users")'],
            "rowSecurity": True, "enabled": True})
        if code not in (200, 201, 409):
            print(f"  ! {t}: HTTP {code} {res.get('message')}")
            continue
        for kind, kw in cols:
            aw("POST", f"/tablesdb/{AW_DB}/tables/{t}/columns/{kind}", kw)
        for _ in range(20):
            time.sleep(1)
            r, _ = aw("GET", f"/tablesdb/{AW_DB}/tables/{t}")
            st = {c["key"]: c["status"]
                  for c in r.get("columns", r.get("attributes", []))}
            if st and all(v == "available" for v in st.values()):
                break
        print(f"  + {t} lista")


# ---------------- datos ----------------

def load_events(path, today=True):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not today or e.get("date") == TODAY:
                out.append(e)
    # un mismo (sku,type) puede repetirse entre sweep y stock-check:
    # quedarse con el ultimo
    dedup = {}
    for e in out:
        dedup[(e.get("sku") or e.get("iid"), e["type"])] = e
    return list(dedup.values())


def catalog_state():
    """{sku: {price, saving, in_stock, min, max, med, n_ch, last_ch,
    title}} desde prices.db — espejo del agg del frontend."""
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    prods = {r["sku"]: dict(r)
             for r in con.execute("select sku, title, image from products")}
    series = {}
    for r in con.execute("select sku, date, price, saving, in_stock "
                         "from prices order by sku, date"):
        series.setdefault(r["sku"], []).append(r)
    con.close()
    out = {}
    for sku, rows in series.items():
        prices = [r["price"] for r in rows if r["price"]]
        last = rows[-1]
        ch = [r for i, r in enumerate(rows[1:], 1)
              if r["price"] != rows[i - 1]["price"]]
        d_last = (datetime.strptime(ch[-1]["date"], "%Y-%m-%d").date()
                  if ch else None)
        pr = prods.get(sku) or {}
        out[sku] = {
            "title": pr.get("title", sku), "image": pr.get("image") or "",
            "price": last["price"],
            "saving": last["saving"] or 0, "in_stock": bool(last["in_stock"]),
            "min": min(prices) if prices else None,
            "max": max(prices) if prices else None,
            "n_ch": len(ch), "last_ch": last["date"] if ch else None,
            "d_ch": (datetime.now().date() - d_last).days if d_last else None,
        }
    # indice del dia: mediana del % de cambio entre las 2 ultimas
    # observaciones por sku — el mismo "indice" del sitio
    chg = [(rows[-1]["price"] - rows[-2]["price"]) / rows[-2]["price"] * 100
           for rows in series.values()
           if len(rows) >= 2 and rows[-1]["price"] and rows[-2]["price"]]
    indice = round(statistics.median(chg), 2) if chg else None
    return out, indice


def siman_items():
    """Ultimo estado por itemId: {itemId: {pid,title,price,avail,watch}}."""
    if not os.path.exists(SIMAN_DB):
        return {}
    con = sqlite3.connect(SIMAN_DB)
    con.row_factory = sqlite3.Row
    items = {r["itemId"]: dict(r) for r in con.execute("select * from items")}
    for r in con.execute(
            "select p.* from prices p join (select itemId, max(date) md "
            "from prices group by itemId) m "
            "on p.itemId=m.itemId and p.date=m.md"):
        if r["itemId"] in items:
            items[r["itemId"]].update(dict(r))
    con.close()
    return items


# ---------------- decision de ruido ----------------

def build_alerts(events, cat, favs, paid, tgts):
    fav_ids = set(favs)
    drops = sorted([e for e in events if e["type"] in ("bajo", "rebaja")
                    and e.get("pct")],
                   key=lambda e: e["pct"])
    # eventos por club agrupados por sku: un producto que se acaba en
    # 3 tiendas es UN hecho, no tres — igual que la web
    club_ev = {}
    for e in events:
        if e["type"] in ("club_agotado", "club_volvio", "se_agota"):
            club_ev.setdefault((e["type"], e["sku"]), []).append(e)
    def fav_clubs(tipo):
        return [{"sku": s, "title": es[0]["title"],
                 "price": es[0].get("price"),
                 "clubs": [(e.get("club"), e.get("qty_to")) for e in es]}
                for (t, s), es in club_ev.items()
                if t == tipo and s in fav_ids]
    out = {
        "drops": drops,
        "fav_drop": [e for e in drops if e["sku"] in fav_ids],
        "fav_oferta": [e for e in events if e["type"] == "oferta"
                       and e["sku"] in fav_ids],
        "fav_out": [e for e in events
                    if e["type"] in ("agotado", "salio_del_catalogo")
                    and e["sku"] in fav_ids],
        "fav_resurtir": [],
        "tgt_hit": [],
        "big_rebaja": [e for e in drops if e["type"] == "rebaja"
                       and e["pct"] <= BIG_DROP],
        # urgencia de disponibilidad en TU lista (call to action del dia)
        "fav_drain": fav_clubs("se_agota"),
        "fav_clubout": fav_clubs("club_agotado"),
        "fav_clubback": fav_clubs("club_volvio"),
        "fav_back": [e for e in events
                     if e["type"] in ("reaparecio", "regreso")
                     and e["sku"] in fav_ids],
        # sku -> clubes donde se agota: anota las bajadas/ofertas del dia
        "drain": {s: [e.get("club") for e in es]
                  for (t, s), es in club_ev.items() if t == "se_agota"},
    }
    for sku in fav_ids:
        c = cat.get(sku)
        if c and c["in_stock"] and c["price"] and sku in paid \
                and c["price"] <= round(paid[sku] * 100):
            out["fav_resurtir"].append(
                {"sku": sku, "title": c["title"], "to": c["price"],
                 "paid": paid[sku]})
    # precio objetivo: el evento de hoy cruza el target (de >t a <=t).
    # prev_price cubre 'reaparecio'; 'oferta' no trae origen -> si el
    # precio actual ya esta bajo el objetivo, avisa igual
    for e in events:
        t = tgts.get(str(e.get("sku") or ""))
        if not t:
            continue
        cur_p = e.get("to") if e.get("to") is not None else e.get("price")
        frm = e.get("from") if e.get("from") is not None else e.get("prev_price")
        if cur_p is not None and cur_p <= t and (frm is None or frm > t):
            out["tgt_hit"].append({"sku": e["sku"], "title": e.get("title"),
                                   "price": cur_p, "tgt": t})
    return out


def siman_gangas(events):
    """bajos/ofertas de Siman hoy, menos lo muteado/ya visto."""
    muted = {r["tkey"] for r in aw_rows("siman_muted")}
    seen = {r["tkey"]: r["price"] for r in aw_rows("siman_seen")}
    def hit(rule, tk):
        # reglas "pid|tkey|hash,...": el tkey es el 2do segmento
        # (split("|",1) dejaba los hashes pegados y nunca igualaba);
        # legacy "tkey" plano no tiene "|"
        pt = rule.split("|")
        return (pt[1] if len(pt) > 1 else rule) == tk
    out = []
    for e in events:
        if e["type"] not in ("bajo", "oferta"):
            continue
        tk = tkey(e.get("title"))
        if any(hit(r, tk) for r in muted):
            continue
        sp = next((p for r, p in seen.items() if hit(r, tk)), None)
        if sp is not None and e.get("price") and e["price"] >= sp:
            continue
        # normalizar a centavos (Siman reporta USD; PS reporta cents)
        for k in ("price", "from", "to"):
            if e.get(k) is not None:
                e[k] = round(e[k] * 100)
        out.append(e)
    # mismo producto puede emitir bajo + oferta: 'bajo' trae from→to
    by_iid = {}
    for e in out:
        if e["iid"] not in by_iid or e["type"] == "bajo":
            by_iid[e["iid"]] = e
    return list(by_iid.values())


# ---------------- envio ----------------

def send_push(subs, payload):
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        print("  ! pywebpush no instalado — push omitido")
        return
    vp = os.environ.get("VAPID_PRIVATE")
    if not vp:
        print("  ! sin VAPID_PRIVATE — push omitido")
        return
    for s in subs:
        try:
            webpush(
                subscription_info={"endpoint": s["endpoint"],
                                   "keys": json.loads(s["keys"])},
                data=json.dumps(payload),
                vapid_private_key=vp,
                vapid_claims={"sub": "mailto:notificaciones@agtisa.com"},
                ttl=86400)
        except WebPushException as e:
            code = getattr(e.response, "status_code", 0)
            if code in (404, 410):       # endpoint muerto: podar
                aw("DELETE", f"/tablesdb/{AW_DB}/tables/push_subs"
                             f"/rows/{s['$id']}")
            print(f"  ! push {s['$id']}: HTTP {code}")


def send_email(subject, html, text):
    key = os.environ.get("RESEND_API_KEY")
    frm = os.environ.get("RESEND_FROM", "PriceWatch <info@agtisa.com>")
    to = os.environ.get("RESEND_TO", "")
    if not (key and to):
        print("  ! sin RESEND_API_KEY/RESEND_TO — email omitido")
        return
    # Cloudflare (1010) banea el UA por defecto de urllib; mandar uno propio
    req = Request("https://api.resend.com/emails", method="POST",
                  data=json.dumps({"from": frm, "to": to,
                                   "subject": subject,
                                   "html": html, "text": text}).encode(),
                  headers={"Authorization": f"Bearer {key}",
                           "Content-Type": "application/json", **UA})
    try:
        with urlopen(req, timeout=30) as r:
            print(f"  email enviado: {json.loads(r.read()).get('id')}")
    except HTTPError as e:
        print(f"  ! Resend HTTP {e.code}: {e.read()[:300]}")


# ---------------- digest ----------------

def pill(txt, bg, fg):
    """chip inline: % de bajada en verde, 'mín histórico' en azul, etc."""
    return (f"<span style='font-size:11px;background:{bg};color:{fg};"
            f"border-radius:4px;padding:1px 5px;white-space:nowrap'>"
            f"{txt}</span>")


MIN_TAG = pill("mín histórico", "#dbeafe", "#1e40af")


def pct_pill(p):
    if p is None:
        return ""
    return pill(f"{p:+.0f}%", "#dcfce7" if p < 0 else "#fee2e2",
                "#15803d" if p < 0 else "#b91c1c")


def sec(title, inner, color="#0f1420"):
    return (f"<h3 style='margin:18px 0 6px;border-left:3px solid {color};"
            f"padding-left:8px'>{title}</h3>{inner}")


def table(rows):
    return ("<table style='width:100%;border-collapse:collapse;"
            "font-size:14px'>" + "".join(rows) + "</table>")


def row(img, title, meta, right, size=40):
    """tr: thumb | titulo+meta | celda derecha alineada. Layout por tabla:
    es lo unico que los clientes de correo renderan igual."""
    ic = (f"<td style='width:{size}px;padding:4px 8px 4px 0;"
          f"vertical-align:middle'><img src='{img}' width='{size}' "
          f"style='border-radius:6px;background:#f3f4f6;display:block'>"
          f"</td>") if img else ""
    return (f"<tr>{ic}<td style='vertical-align:middle'>{title}"
            + (f"<br>{meta}" if meta else "")
            + f"</td><td style='text-align:right;vertical-align:middle;"
              f"white-space:nowrap'>{right}</td></tr>")


def ptitle(sku, t, bold=True):
    """titulo linkeado a la ficha del producto (?sku abre el dialogo)."""
    t = hesc((t or "?").strip())
    if not sku:
        return f"<b>{t}</b>" if bold else t
    inner = f"<b>{t}</b>" if bold else t
    return (f"<a href='{SITE}?sku={sku}' style='color:#111;"
            f"text-decoration:none'>{inner}</a>")


def ev_price(e):
    """(de, a) en centavos segun lo que traiga el evento."""
    frm = e.get("from") if e.get("from") is not None else e.get("list")
    to = e.get("to") if e.get("to") is not None else e.get("price")
    return frm, to


def move_right(e):
    """celda derecha: <s>antes</s> ahora + pill del %."""
    frm, to = ev_price(e)
    pct = e.get("pct")
    if pct is None and frm and to:
        pct = round((to - frm) / frm * 100, 1)
    return ((f"<s style='color:#9ca3af;font-size:12px'>{money(frm)}</s> "
             if frm else "")
            + f"<b>{money(to)}</b> " + pct_pill(pct))


def at_min(e, c):
    """la bajada deja el precio en el minimo historico del sku."""
    _, to = ev_price(e)
    return (to is not None and c.get("min") is not None
            and to <= c["min"])


def drop_row(e, cat, drain=None, bold=False):
    """bajada/oferta/rebaja: titulo + tags + meta, precio a la derecha."""
    c = cat.get(str(e.get("sku") or "")) or {}
    frm, to = ev_price(e)
    title = ptitle(e.get("sku"), e.get("title") or c.get("title"), bold)
    if at_min(e, c):
        title += " " + MIN_TAG
    meta = []
    if frm and to and frm > to:
        meta.append(f"ahorras {money(frm - to)}")
    if e.get("type") == "rebaja":
        meta.append("sin letrero")
    if drain and drain.get(e.get("sku")):
        clubs = [x for x in drain[e["sku"]] if x]
        if clubs:
            meta.append(f"<span style='color:#c2410c'>se agota en "
                        f"{', '.join(hesc(x) for x in clubs)}</span>")
    m = (f"<span style='font-size:12px;color:#6b7280'>"
         f"{' · '.join(meta)}</span>" if meta else "")
    return row(c.get("image"), title, m, move_right(e))


def club_row(e, verbo, cat, color="#c2410c"):
    """'se agota/acabó/volvió en clubes': titulo + clubes con qty."""
    c = cat.get(str(e.get("sku") or "")) or {}
    clubs = []
    for club, qty in e.get("clubs", []):
        # "El Salvador" = canal nacional del API, no una tienda
        club = "nivel nacional" if club == "El Salvador" else club
        clubs.append(hesc(club)
                     + (f" (quedan {qty})" if qty is not None else ""))
    meta = (f"<span style='font-size:12px;color:{color}'>"
            f"{verbo} {', '.join(clubs)}</span>")
    right = f"<b>{money(e['price'])}</b>" if e.get("price") else ""
    return row(c.get("image"),
               ptitle(e.get("sku"), e.get("title")), meta, right)


def ganga_row(g, cat):
    """card destacada (thumb 52px): ahorro en $ y recencia del cambio."""
    c = cat.get(str(g.get("sku") or "")) or {}
    frm, to = ev_price(g)
    title = ptitle(g.get("sku"), g.get("title") or c.get("title"))
    if at_min(g, c):
        title += " " + MIN_TAG
    meta = []
    if frm and to and frm > to:
        meta.append(f"ahorras {money(frm - to)}")
    if c.get("d_ch"):
        meta.append(f"último cambio hace {c['d_ch']} días")
    if g.get("type") == "rebaja":
        meta.append("sin letrero, rebaja silenciosa")
    m = (f"<span style='font-size:12px;color:#6b7280'>"
         f"{' · '.join(meta)}</span>" if meta else "")
    return row(c.get("image"), title, m, move_right(g), size=52)


def fav_row(e, cat, meta, right=""):
    """fila de 'tu lista': thumb + titulo + meta de contexto."""
    c = cat.get(str(e.get("sku") or "")) or {}
    title = ptitle(e.get("sku"), e.get("title") or c.get("title"))
    if e.get("price") is not None and c.get("min") is not None \
            and e["price"] <= c["min"]:
        title += " " + MIN_TAG
    return row(c.get("image"), title,
               f"<span style='font-size:12px;color:#6b7280'>{meta}</span>",
               right)


def siman_row(e, items):
    """ganga Siman: thumb + link directo a siman.com + tag del watch."""
    it = items.get(str(e.get("iid"))) or {}
    t = hesc((e.get("title") or it.get("title") or "?").strip())
    link = it.get("link")
    title = (f"<a href='{link}' style='color:#111;text-decoration:none'>"
             f"<b>{t}</b> <span style='color:#6b7280'>↗</span></a>"
             if link else f"<b>{t}</b>")
    meta = (f"<span style='font-size:12px;color:#6b7280'>vigilado por "
            f"\"{hesc(it['watch'])}\"</span>" if it.get("watch") else "")
    return row(it.get("image"), title, meta, move_right(e))


def ver_todas(n, tab, txt):
    """'ver las N →' cuando la seccion se trunca."""
    return (f"<p style='margin:6px 0 0;font-size:13px'>"
            f"<a href='{SITE}?tab={tab}' style='color:#1e40af'>"
            f"ver {txt} ({n}) →</a></p>")


def digest_html(day, counts, a, gangas, silent, siman, cat, sitems,
                indice, near_tgt, aw_down=False):
    S = []
    # preheader: lo que la bandeja muestra junto al asunto
    pre = []
    n_urg = len(a["fav_drain"]) + len(a["fav_clubout"])
    if n_urg:
        pre.append(f"{n_urg} de tu lista se agotan")
    if a["tgt_hit"]:
        pre.append(f"{len(a['tgt_hit'])} a precio objetivo")
    if gangas:
        pre.append(f"{len(gangas)} bajadas")
    if siman:
        pre.append(f"{len(siman)} ganga Siman")
    S.append("<div style='display:none;max-height:0;overflow:hidden;"
             "mso-hide:all'>" + hesc(" · ".join(pre)) + "</div>")
    if aw_down:
        S.append(sec("⚠ Appwrite no respondió",
            "<p>La base puede estar pausada por inactividad (free tier): "
            "la sincronización de tu cuenta está inactiva hasta "
            f"reactivarla. <a href='{AW_CONSOLE}'>Abrir consola Appwrite "
            "→ reactivar proyecto</a></p>", "#b91c1c"))
    idx = (f" · la tienda hoy: <b>{indice:+.1f}%</b> mediano"
           if indice is not None else "")
    S.append(f"<p style='color:#666;margin-top:0;font-size:13px'>{day} — "
             + " · ".join(f"{n} {k}" for k, n in counts.items() if n)
             + idx + "</p>")
    # urgencia primero: de tu lista, se agota o se acabó — hay que actuar hoy
    if a["fav_drain"] or a["fav_clubout"]:
        urg = table([club_row(e, "se agota en", cat)
                     for e in a["fav_drain"]]
                    + [club_row(e, "se acabó en", cat)
                       for e in a["fav_clubout"]])
        S.append(sec("Urgente — tu lista se está agotando", urg,
                     "#c2410c"))
    if a["fav_clubback"] or a["fav_back"]:
        back = table([club_row(e, "volvió a", cat, "#15803d")
                      for e in a["fav_clubback"]]
                     + [fav_row(e, cat, "volvió stock",
                                f"<b>{money(e['price'])}</b>"
                                if e.get("price") else "")
                        for e in a["fav_back"][:5]])
        S.append(sec("Volvió stock", back, "#15803d"))
    if gangas:
        S.append(sec("Ganga del día", ganga_row(gangas[0], cat),
                     "#1e40af"))
    # tu lista: objetivos, bajadas, resurtir, casi-objetivo, sin stock
    rows = [fav_row(e, cat,
                    f"🎯 cruzó tu objetivo de {money(e['tgt'])}",
                    f"<b>{money(e['price'])}</b>")
            for e in a["tgt_hit"]]
    rows += [drop_row(e, cat, a["drain"], bold=True)
             for e in (a["fav_drop"] + a["fav_oferta"])[:4]]
    rows += [fav_row(e, cat,
                     "para resurtir — pagaste "
                     f"{money(round(e['paid'] * 100))}",
                     f"<b>{money(e['to'])}</b>")
             for e in a["fav_resurtir"]]
    rows += [fav_row(e, cat,
                     f"casi en tu objetivo — meta {money(e['tgt'])} "
                     f"(a {e['pct_away']}%)",
                     f"<b>{money(e['price'])}</b>")
             for e in near_tgt]
    rows += [fav_row(e, cat, "sin stock",
                     f"<b>{money(e['price'])}</b>" if e.get("price")
                     else "")
             for e in a["fav_out"][:5]]
    if rows:
        S.append(sec("Tu lista", table(rows)))
    if gangas:
        inner = table([drop_row(e, cat, a["drain"])
                       for e in gangas[:8]])
        if len(gangas) > 8:
            inner += ver_todas(len(gangas), "cambios", "las bajadas")
        S.append(sec("Bajadas de hoy", inner))
    if silent:
        inner = table([drop_row(e, cat) for e in silent[:5]])
        if len(silent) > 5:
            inner += ver_todas(len(silent), "ofertas",
                               "las silenciosas")
        S.append(sec("Silenciosas vigentes", inner))
    if siman:
        inner = table([siman_row(e, sitems) for e in siman[:5]])
        if len(siman) > 5:
            inner += ver_todas(len(siman), "siman", "las gangas")
        S.append(sec("Siman", inner, "#7c3aed"))
    # CTA contextual: si hay algo de tu lista, ahi es donde hay que ir
    cta_tab, cta_lbl = (("favs", "Ver tu lista →")
                        if (n_urg or a["tgt_hit"] or a["fav_resurtir"]
                            or a["fav_drop"] or a["fav_oferta"])
                        else ("ofertas", "Ver gangas →"))
    S.append(f"<p style='margin:22px 0 4px;text-align:center'>"
             f"<a href='{SITE}?tab={cta_tab}' style='background:#0f1420;"
             f"color:#fff;padding:10px 22px;border-radius:8px;"
             f"text-decoration:none;display:inline-block'>"
             f"{cta_lbl}</a></p>")
    S.append("<p style='text-align:center;font-size:12px;color:#9ca3af'>"
             + " · ".join(
                 f"<a href='{SITE}?tab={t}' style='color:#9ca3af'>{n}</a>"
                 for t, n in [("cambios", "movimientos"),
                              ("ofertas", "gangas"),
                              ("siman", "siman")]) + "</p>")
    body = "".join(S)
    return (f"<div style='font-family:sans-serif;max-width:560px'>"
            f"<h2 style='margin-bottom:2px'>PriceWatch</h2>{body}</div>")


def main():
    print(f"notify {TODAY}")
    events = load_events(EVENTS_LOG)
    sevents = load_events(SIMAN_LOG)
    cat, indice = catalog_state()
    aw_down = aw_health()
    if aw_down:
        print("  ! Appwrite no responde — DB posiblemente pausada "
              "por inactividad")
    favs = [r["sku"] for r in aw_rows("favs")] if AW_KEY else []
    tgts = {}
    if AW_KEY:
        ensure_targets_table()
        ensure_siman_tables()
        tgts = {str(r["sku"]): r["target"] for r in aw_rows("targets")
                if r.get("sku") and r.get("target")}
    paid, paid_d = {}, {}
    for r in aw_rows("compras") if AW_KEY else []:
        if r.get("paid") and r.get("date", "") >= paid_d.get(r["sku"], ""):
            paid[r["sku"]], paid_d[r["sku"]] = r["paid"], r.get("date", "")

    a = build_alerts(events, cat, favs, paid, tgts)
    siman = siman_gangas(sevents)   # aw_rows() devuelve [] sin creds
    sitems = siman_items()          # foto/link de cada itemId para el mail
    # "casi en objetivo": a <=5% de cruzar el target — anticipa el aviso
    # de mañana en vez de solo reportar los que ya cruzaron
    near_tgt = [{"sku": s, "title": cat[s]["title"], "price": cat[s]["price"],
                 "tgt": t,
                 "pct_away": round((cat[s]["price"] - t) / t * 100)}
                for s, t in tgts.items()
                if s in cat and cat[s]["price"]
                and t < cat[s]["price"] <= t * 1.05]

    # gangas silenciosas vigentes (espejo de atMin del frontend)
    silent = []
    for sku, c in cat.items():
        if (c["in_stock"] and not c["saving"] and c["price"]
                and c["price"] == c["min"] and c["n_ch"] >= 1
                and c["d_ch"] is not None and c["d_ch"] <= FRESH_DAYS):
            drop = (c["max"] - c["price"]) / c["max"] * 100
            silent.append({"sku": sku, "title": c["title"],
                           "from": c["max"], "to": c["price"],
                           "pct": round(-drop, 1)})
    silent.sort(key=lambda e: e["pct"])

    counts = {}
    for e in events:
        counts[e["type"]] = counts.get(e["type"], 0) + 1
    n_fav = len(a["fav_drop"]) + len(a["fav_oferta"])

    # ---- push: solo lo urgente ----
    push_items = []
    if a["tgt_hit"]:
        push_items.append(f"{len(a['tgt_hit'])} a precio objetivo")
    if a["fav_drop"] or a["fav_oferta"]:
        push_items.append(f"{n_fav} de tu lista en oferta/bajó")
    if a["fav_resurtir"]:
        push_items.append(f"{len(a['fav_resurtir'])} para resurtir")
    top = a["big_rebaja"][:1]
    for e in top:
        push_items.append(f"{e['title'][:30]} {e['pct']}% silenciosa")
    if siman:
        push_items.append(f"{len(siman)} ganga Siman")
    if push_items and AW_KEY:
        ensure_push_table()
        subs = aw_rows("push_subs")
        print(f"  push -> {len(subs)} subs: {' · '.join(push_items)}")
        send_push(subs, {"title": "PriceWatch",
                         "body": " · ".join(push_items)[:170],
                         "url": SITE + "?tab=favs" if a["fav_drop"]
                               else SITE + "?tab=ofertas"})
    elif push_items:
        print("  push: hay alertas pero sin credenciales Appwrite")
    else:
        print("  push: nada urgente — silencio")

    # ---- email: solo si pasó algo (o si Appwrite cayo: esa alerta
    # ES el evento — en un dia quieto nadie se enteraria) ----
    if not events and not siman and not aw_down:
        print("  email: día sin eventos — no se envía")
        return
    n_urg = len(a["fav_drain"]) + len(a["fav_clubout"])
    headline = []
    if aw_down:
        headline.append("⚠ Appwrite caído")
    if n_urg:
        headline.append(f"{n_urg} de tu lista se agotan")
    if a["drops"]:
        headline.append(f"{len(a['drops'])} bajadas")
    if a["tgt_hit"]:
        headline.append(f"{len(a['tgt_hit'])} objetivo")
    if n_fav:
        headline.append(f"{n_fav} de tu lista")
    if siman:
        headline.append(f"{len(siman)} Siman")
    subj = f"PriceWatch {TODAY}: " + (" · ".join(headline) or "resumen")
    # el encabezado solo cuenta transiciones nacionales y precios; el
    # ruido por club vive en la seccion Urgente si es de tu lista
    pretty = {"bajo": "bajaron", "rebaja": "rebajas silenciosas",
              "subio": "subieron", "oferta": "ofertas nuevas",
              "oferta_termino": "terminó oferta", "agotado": "agotados",
              "reaparecio": "volvieron", "nuevo": "nuevos",
              "salio_del_catalogo": "salieron", "regreso": "regresaron"}
    cnt = {pretty[k]: v for k, v in counts.items() if k in pretty}
    html = digest_html(TODAY, cnt, a, a["drops"], silent, siman, cat,
                       sitems, indice, near_tgt, aw_down)
    # fallback texto plano: mismas secciones para clientes sin HTML
    lines = [f"PriceWatch {TODAY}", ""]
    if aw_down:
        lines.insert(0, "!! Appwrite no responde — reactivala: "
                        + AW_CONSOLE + "\n")
    for e in a["fav_drain"]:
        lines.append(f"!! {e['title'][:50]} se agota en "
                     + ", ".join(c for c, _ in e["clubs"]))
    for e in a["fav_clubout"]:
        lines.append(f"!! {e['title'][:50]} se acabó en "
                     + ", ".join(c for c, _ in e["clubs"]))
    for e in a["tgt_hit"]:
        lines.append(f"🎯 {e['title'][:50]} a {money(e['price'])} "
                     f"(objetivo {money(e['tgt'])})")
    for e in a["fav_resurtir"]:
        lines.append(f"resurtir: {e['title'][:50]} a {money(e['to'])}")
    if a["drops"]:
        lines.append("")
        lines += [f"- {(e.get('title') or '')[:55]} {money(e['from'])} → "
                  f"{money(e['to'])} ({e['pct']}%)"
                  for e in a["drops"]
                  if e.get("from") is not None][:8]
    for e in siman[:5]:
        _, p = ev_price(e)
        lines.append(f"- Siman: {(e.get('title') or '')[:55]} {money(p)}")
    lines += ["", SITE]
    send_email(subj, html, "\n".join(lines))


if __name__ == "__main__":
    main()
