"""Genera tests/fixtures/verdicts_golden.json: volcado de las salidas
ACTUALES de build_site.compute_agg y notify.catalog_state (con TODAY
fijado) sobre las series sinteticas de cada caso.

Correr SOLO con el codigo cuyo comportamiento se quiere fijar:
    python tests/gen_verdicts_golden.py
Un diff en el fixture = cambio de comportamiento (revisar, no
regenerar a ciegas)."""
import json
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import build_site
import notify

TODAY = "2026-11-12"   # fecha SV fijada para catalog_state

# filas de serie: [date, price_cents, in_stock, saving] (3 o 4 cols —
# compute_agg rellena el ahorro faltante con 0)
CASES = [
    {"name": "una_sola_lectura",
     "series": {"A": [["2026-11-12", 500, 1, 0]]}},
    {"name": "historia_corta_2_lecturas",
     "series": {"A": [["2026-11-11", 1000, 1, 0],
                      ["2026-11-12", 900, 1, 0]]}},
    {"name": "tres_columnas_sin_ahorro",
     "series": {"A": [["2026-11-01", 1000, 1],
                      ["2026-11-12", 800, 1]]}},
    {"name": "sin_cambios_nunca",
     "series": {"A": [["2026-10-01", 1000, 1, 0],
                      ["2026-10-10", 1000, 1, 0],
                      ["2026-10-20", 1000, 1, 0],
                      ["2026-11-01", 1000, 1, 0],
                      ["2026-11-12", 1000, 1, 0]]}},
    {"name": "en_su_minimo",
     "series": {"A": [["2026-10-20", 1200, 1, 0],
                      ["2026-10-25", 1000, 1, 0],
                      ["2026-11-12", 900, 1, 0]]}},
    {"name": "vs_med_negativo",
     "series": {"A": [["2026-10-10", 900, 1, 0],
                      ["2026-10-20", 1200, 1, 0],
                      ["2026-11-01", 1000, 1, 0],
                      ["2026-11-12", 950, 1, 0]]}},
    {"name": "racha_agotado",
     "series": {"A": [["2026-11-01", 1000, 1, 0],
                      ["2026-11-05", 1000, 0, 0],
                      ["2026-11-08", 1000, 0, 0],
                      ["2026-11-12", 1000, 0, 0]]}},
    {"name": "agotado_hoy",
     "series": {"A": [["2026-11-05", 1000, 1, 0],
                      ["2026-11-12", 1000, 0, 0]]}},
    {"name": "precio_none_en_medio",
     # cambio a/desde None: n_ch del sitio lo excluye (requiere ambos
     # precios validos), n_ch de notify lo cuenta — divergencia fijada
     "series": {"A": [["2026-11-01", 1000, 1, 0],
                      ["2026-11-05", None, 1, 0],
                      ["2026-11-12", 900, 1, 0]]}},
    {"name": "precio_none_al_final",
     "series": {"A": [["2026-11-01", 1000, 1, 0],
                      ["2026-11-12", None, 0, 0]]}},
    {"name": "precio_cero",
     # 0 es falsy: el agg del sitio lo toma como min, notify lo filtra
     "series": {"A": [["2026-11-01", 1000, 1, 0],
                      ["2026-11-05", 0, 1, 0],
                      ["2026-11-12", 900, 1, 0]]}},
    {"name": "ofertas_3_episodios",
     "series": {"A": [["2026-08-01", 1000, 1, 0],
                      ["2026-08-10", 800, 1, 1.0],
                      ["2026-08-12", 1000, 1, 0],
                      ["2026-08-25", 800, 1, 1.0],
                      ["2026-08-27", 1000, 1, 0],
                      ["2026-09-10", 800, 1, 1.0],
                      ["2026-11-12", 1000, 1, 0]]}},
    {"name": "oferta_activa",
     "series": {"A": [["2026-11-01", 1000, 1, 0],
                      ["2026-11-10", 800, 1, 2.5],
                      ["2026-11-12", 800, 1, 2.5]]}},
    {"name": "oferta_mengua",
     "series": {"A": [["2026-11-01", 1000, 1, 0],
                      ["2026-11-05", 1000, 1, 2.0],
                      ["2026-11-10", 1000, 1, 0.5],
                      ["2026-11-12", 1000, 1, 0.5]]}},
    {"name": "temporada",
     # ausente de latest + vida corta = producto de temporada
     "series": {"T": [["2026-10-20", 700, 1, 0],
                      ["2026-11-05", 700, 1, 0]]},
     "latest": {}},
    {"name": "ausente_latest_viejo",
     # ausente de latest con vida larga: NO es temporada
     "series": {"V": [["2026-08-01", 700, 1, 0],
                      ["2026-09-01", 800, 1, 0],
                      ["2026-11-05", 800, 1, 0]]},
     "latest": {}},
    {"name": "ultimo_cambio_hace_40d",
     "series": {"A": [["2026-09-01", 1200, 1, 0],
                      ["2026-10-03", 1000, 1, 0],
                      ["2026-11-12", 1000, 1, 0]]}},
    {"name": "lectura_vieja_con_stock",
     # ultima fila != TODAY: notify declara in_stock False aunque la
     # lectura diga 1; el agg del sitio no lleva fecha propia
     "series": {"A": [["2026-11-01", 1000, 1, 0],
                      ["2026-11-10", 900, 1, 0]]}},
]


def _prices_db(path, case):
    con = sqlite3.connect(path)
    con.execute("create table products (sku text, title text,"
                " image text)")
    con.execute("""create table prices (sku text, date text,
                   price int, sign_price int, saving real,
                   in_stock int)""")
    for sku in case["series"]:
        con.execute("insert into products values (?,?,?)",
                    (sku, f"Prod {sku}", f"img-{sku}"))
    for sku, rows in case["series"].items():
        for r in rows:
            con.execute("insert into prices values (?,?,?,?,?,?)",
                        (sku, r[0], r[1], r[1],
                         r[3] if len(r) > 3 else 0, r[2]))
    con.commit()
    con.close()


def main():
    out = {"meta": {
        "today": TODAY,
        "note": ("volcado pre-extraccion (verdicts.py fase 1). "
                 "compute_agg con el signature actual; catalog_state "
                 "con notify.TODAY/monkeypatch fijado a meta.today"),
    }, "cases": []}
    for i, case in enumerate(CASES):
        series = case["series"]
        latest = case.get("latest",
                          {s: {"sku": s} for s in series})
        agg = build_site.compute_agg(series, latest)
        with tempfile.TemporaryDirectory() as td:
            db = os.path.join(td, "prices.db")
            _prices_db(db, case)
            notify.DB = db
            notify.TODAY = TODAY
            state, indice = notify.catalog_state()
        out["cases"].append({
            "name": case["name"],
            "series": series,
            "latest": latest,
            "products": {s: {"title": f"Prod {s}", "image": f"img-{s}"}
                         for s in series},
            "compute_agg": agg,
            "catalog_state": {"state": state, "indice": indice},
        })
        print(f"  {case['name']}")
    dst = os.path.join(os.path.dirname(__file__),
                       "fixtures", "verdicts_golden.json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"-> {dst} ({len(out['cases'])} casos)")


if __name__ == "__main__":
    main()
