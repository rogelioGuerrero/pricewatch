"""Tests de build_site.py — compute_agg y el build end-to-end sobre
un root_dir temporal (modularizado: antes todo corria al importar)."""

import sqlite3

import build_site as bs

# ---------- compute_agg ----------

def test_compute_agg_metricas():
    series = {"A": [
        ["2026-09-01", 1000, 1, 0],
        ["2026-09-02", 1000, 1, 0],
        ["2026-09-03", 800, 1, 2.0],    # empieza oferta con letrero
        ["2026-09-04", 800, 1, 2.0],
        ["2026-09-05", 1000, 1, 0],     # termina
        ["2026-09-06", 1000, 0, 0],
        ["2026-09-07", 1000, 0, 0],
        ["2026-09-20", 900, 1, 0],      # vuelve con otro precio
    ]}
    latest = {"A": {"sku": "A", "price": 900, "in_stock": 1}}
    a = bs.compute_agg(series, latest)["A"]
    assert a["min"] == 800 and a["max"] == 1000 and a["med"] == 1000
    assert a["pct_min"] == 12.5 and a["vs_med"] == -10.0
    assert a["n_ch"] == 3 and a["last_ch"] == "2026-09-20"
    assert a["d_out"] == 0 and a["n_out"] == 1 and a["pct_stock"] == 75
    assert a["n_of"] == 1 and a["of_every"] is None
    assert a["of_end"] == ["2026-09-03", "2026-09-04"]
    assert a["of_cur"] is None and a["of_last"] == 16
    assert a["of_save"] == 2.0 and a["temp"] is None


def test_compute_agg_cadencia_de_ofertas():
    """3 episodios de letrero -> of_every es la mediana de los gaps."""
    series = {"A": [
        ["2026-08-01", 1000, 1, 0],
        ["2026-08-10", 800, 1, 1.0],   # oferta 1
        ["2026-08-12", 1000, 1, 0],
        ["2026-08-25", 800, 1, 1.0],   # oferta 2 (gap 15d)
        ["2026-08-27", 1000, 1, 0],
        ["2026-09-10", 800, 1, 1.0],   # oferta 3 (gap 16d)
        ["2026-09-12", 1000, 1, 0],
    ]}
    a = bs.compute_agg(series, {"A": {}})["A"]
    assert a["n_of"] == 3 and a["of_every"] == 16
    assert a["of_end"] == ["2026-09-10", "2026-09-10"]
    assert a["of_last"] == 2   # ultima oferta 09-10, hoy 09-12


def test_compute_agg_racha_agotado():
    series = {"A": [
        ["2026-10-01", 500, 1, 0],
        ["2026-10-02", 500, 0, 0],
        ["2026-10-03", 500, 0, 0],
    ]}
    a = bs.compute_agg(series, {})["A"]
    assert a["d_out"] == 2 and a["temp"] is True   # vida <60d y salio


def test_compute_agg_tolera_series_de_3_cols():
    """Las filas exportadas sin ahorro (3 cols) no revientan [3]."""
    series = {"A": [["2026-10-01", 500, 1], ["2026-10-02", 400, 1]]}
    a = bs.compute_agg(series, {"A": {}})["A"]
    assert a["n_ch"] == 1 and a["n_of"] == 0 and a["of_cur"] is None


def test_compute_agg_sin_precios_no_emite():
    series = {"A": [["2026-10-01", None, 0]]}
    assert bs.compute_agg(series, {}) == {}


# ---------- build_site end-to-end ----------

def _root(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "docs").mkdir()
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "template.html").write_text("<html>PW</html>")
    return tmp_path


def _mk_dbs(root):
    con = sqlite3.connect(root / "data" / "prices.db")
    con.execute("""create table products (sku text primary key,
                   title text, brand text, category text, slug text,
                   image text)""")
    con.execute("insert into products values ('A','Prod','B','Cat',"
                "'slug','img')")
    con.execute("insert into products values ('Z','Vacio',NULL,NULL,"
                "NULL,NULL)")
    con.execute("""create table prices (sku text, date text, price int,
                   sign_price int, saving real, in_stock int)""")
    con.executemany("insert into prices values (?,?,?,?,?,?)", [
        ("A", "2026-10-13", 1000, 1000, 0, 1),
        ("A", "2026-10-14", 800, 800, 2.0, 1),
        ("Z", "2026-10-14", 500, 500, 0, 1),
    ])
    con.commit()
    con.close()
    sc = sqlite3.connect(root / "data" / "siman.db")
    sc.execute("""create table items (itemId text primary key, pid text,
                  title text, brand text, link text, image text,
                  vname text, watch text, talla text, first_seen text,
                  last_seen text, imghash text)""")
    sc.execute("""insert into items values
                  ('1','P1','Zapato','N','l','i','U','zap','10',
                   '2026-10-01','2026-10-14','h')""")
    sc.execute("""create table prices (itemId text, date text,
                  price real, list real, qty int, avail int, card int)""")
    sc.executemany("insert into prices values (?,?,?,?,?,?,?)", [
        ("1", "2026-10-10", 100.0, None, 1, 1, 0),
        ("1", "2026-10-14", 80.0, 100.0, 1, 1, 0),
    ])
    sc.commit()
    sc.close()


def test_build_site_end_to_end(tmp_path):
    _mk_dbs(_root(tmp_path))
    d = bs.build_site(str(tmp_path))
    assert d["generated"] == "2026-10-14"
    # payload liviano: sin "sku" interno ni claves vacias
    assert d["products"]["A"] == {"title": "Prod", "brand": "B",
                                  "category": "Cat", "slug": "slug",
                                  "image": "img"}
    assert d["products"]["Z"] == {"title": "Vacio"}
    # series sin ahorro exportan 3 cols; con ahorro, 4
    assert d["series"]["A"][0] == ["2026-10-13", 1000, 1]
    assert d["series"]["A"][1] == ["2026-10-14", 800, 1, 2.0]
    assert d["agg"]["A"]["n_ch"] == 1
    assert d["ofertas"][0]["sku"] == "A" and d["ofertas"][0]["saving"] == 2.0
    # siman: item vivo con rompimiento de minimo historico
    assert d["siman"]["n_items"] == 1
    assert d["siman"]["items"][0]["broke"] is True
    assert d["siman"]["items"][0]["n"] == 2
    # artefactos escritos
    assert (tmp_path / "docs" / "data.json").exists()
    assert (tmp_path / "docs" / "index.html").read_text() == "<html>PW</html>"
    assert (tmp_path / "docs" / "version.json").exists()


def test_build_site_sin_dbs_no_explota(tmp_path):
    """Sin prices.db ni siman.db el build produce un payload vacio."""
    d = bs.build_site(str(_root(tmp_path)))
    assert d["generated"] == ""
    assert d["products"] == {} and d["series"] == {}
    assert d["siman"]["items"] == []


def test_build_site_db_sin_tablas_no_explota(tmp_path):
    """prices.db existe pero vacia (cache corrupto): no OperationalError."""
    root = _root(tmp_path)
    sqlite3.connect(root / "data" / "prices.db").close()
    d = bs.build_site(str(root))
    assert d["generated"] == "" and d["products"] == {}
