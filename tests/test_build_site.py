"""Tests de build_site.py — compute_agg, versionado de assets por
hash y el build end-to-end sobre un root_dir temporal."""

import re
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
    (tmp_path / "scripts" / "sw.template.js").write_text("// SW __ASSET_V__")
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
    # vname coincide con la talla pedida: la variante si es elegible
    sc.execute("""insert into items values
                  ('1','P1','Zapato','N','l','i','10','zap','10',
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
    # payload liviano: sin "sku" interno ni claves vacias, con
    # procedencia por producto (observed_at/current/currency)
    assert d["products"]["A"] == {"title": "Prod", "brand": "B",
                                  "category": "Cat", "slug": "slug",
                                  "image": "img",
                                  "observed_at": "2026-10-14",
                                  "current": True, "currency": "USD"}
    assert d["products"]["Z"] == {"title": "Vacio",
                                  "observed_at": "2026-10-14",
                                  "current": True, "currency": "USD"}
    # series sin ahorro exportan 3 cols; con ahorro, 4
    assert d["series"]["A"][0] == ["2026-10-13", 1000, 1]
    assert d["series"]["A"][1] == ["2026-10-14", 800, 1, 2.0]
    assert d["agg"]["A"]["n_ch"] == 1
    # schema 3: el veredicto estatico viaja en agg — sin serie >=3 no
    # hay at_min; el score si se publica (0.2 por ahorro 2.0/1000)
    assert d["schema_version"] == 3
    assert "at_min" not in d["agg"]["A"]
    assert d["agg"]["A"]["score"] == 0.2
    # Z: precio plano sin ahorro -> score 0 omitido, sin veredicto
    assert "at_min" not in d["agg"]["Z"]
    assert "score" not in d["agg"]["Z"]
    assert d["ofertas"][0]["sku"] == "A" and d["ofertas"][0]["saving"] == 2.0
    # siman: item vivo con rompimiento de minimo historico
    assert d["siman"]["n_items"] == 1
    assert d["siman"]["items"][0]["broke"] is True
    assert d["siman"]["items"][0]["n"] == 2
    # artefactos escritos
    assert (tmp_path / "docs" / "data.json").exists()
    assert (tmp_path / "docs" / "index.html").read_text() == "<html>PW</html>"
    assert (tmp_path / "docs" / "version.json").exists()


# ---------- versionado de assets por hash ----------

def _root_versionado(tmp_path):
    """Root con assets reales y templates con el placeholder."""
    root = _root(tmp_path)
    (root / "scripts" / "template.html").write_text(
        '<html><link href="styles.css?v=__ASSET_V__">'
        '<script src="js/app.js?v=__ASSET_V__"></html>')
    (root / "scripts" / "sw.template.js").write_text(
        'const CACHE = "pricewatch-__ASSET_V__";'
        'const VER = "__ASSET_V__";'
        'const CORE = ["./styles.css?v=__ASSET_V__"];')
    (root / "docs" / "js").mkdir()
    (root / "docs" / "vendor").mkdir()
    (root / "docs" / "styles.css").write_text("body{}")
    (root / "docs" / "js" / "app.js").write_text("// app")
    (root / "docs" / "vendor" / "v.js").write_text("// vendor")
    return root


def test_asset_version_determinista(tmp_path):
    root = _root_versionado(tmp_path)
    v1 = bs.asset_version(str(root))
    assert v1 == bs.asset_version(str(root))
    assert re.fullmatch(r"[0-9a-f]{10}", v1)


def test_asset_version_cambia_al_tocar_un_js(tmp_path):
    root = _root_versionado(tmp_path)
    v1 = bs.asset_version(str(root))
    (root / "docs" / "js" / "app.js").write_text("// app cambiado")
    assert bs.asset_version(str(root)) != v1


def test_asset_version_cambia_al_tocar_vendor(tmp_path):
    root = _root_versionado(tmp_path)
    v1 = bs.asset_version(str(root))
    (root / "docs" / "vendor" / "v.js").write_text("// vendor cambiado")
    assert bs.asset_version(str(root)) != v1


def test_build_sustituye_placeholder_en_index_y_sw(tmp_path):
    root = _root_versionado(tmp_path)
    bs.build_site(str(root))
    ver = bs.asset_version(str(root))
    html = (root / "docs" / "index.html").read_text()
    sw = (root / "docs" / "sw.js").read_text()
    assert "__ASSET_V__" not in html and "__ASSET_V__" not in sw
    # los ?v= de index.html y sw.js salen del MISMO hash
    vs_html = set(re.findall(r"\?v=([0-9a-f]{10})", html))
    vs_sw = set(re.findall(r"\?v=([0-9a-f]{10})", sw))
    assert vs_html == vs_sw == {ver}
    assert f'CACHE = "pricewatch-{ver}"' in sw
    assert f'VER = "{ver}"' in sw


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


# ---------- fav_skus: favoritos descatalogados conservan meta ----------

def _mk_fav_db(root):
    """prices.db con el producto fresco H (fija `gen` en 2026-10-14)
    y la tabla fav_skus vacia."""
    con = sqlite3.connect(root / "data" / "prices.db")
    con.execute("""create table products (sku text primary key,
        title text, brand text, category text, slug text, image text)""")
    con.execute("""create table prices (sku text, date text, price int,
                   sign_price int, saving real, in_stock int)""")
    con.execute("create table fav_skus "
                "(sku text primary key, last_seen text)")
    con.execute("insert into products values ('H','Fresco','B','C','h','i')")
    con.execute("insert into prices values ('H','2026-10-14',1000,1000,0,1)")
    con.commit()
    con.close()


def _ins(root, sql, rows):
    con = sqlite3.connect(root / "data" / "prices.db")
    con.executemany(sql, rows)
    con.commit()
    con.close()


def test_build_fav_descatalogado_conserva_meta_y_ultima_fila(tmp_path):
    """Fav chequeado por club hace <14d: su ultima lectura de precio
    (>100d) ya no lo saca del payload — viajan meta + ultima fila."""
    root = _root(tmp_path)
    _mk_fav_db(root)
    _ins(root, "insert into products values (?,?,?,?,?,?)", [
        ("F", "Fav Viejo", "Marca", "Cat", "f", None)])
    _ins(root, "insert into prices values (?,?,?,?,?,?)", [
        ("F", "2026-05-01", 800, 800, 0, 1),
        ("F", "2026-06-01", 700, 700, 0, 1)])
    _ins(root, "insert into fav_skus values (?,?)", [("F", "2026-10-13")])
    d = bs.build_site(str(root))
    assert d["generated"] == "2026-10-14"
    assert d["products"]["F"]["title"] == "Fav Viejo"
    assert d["products"]["F"]["current"] is False
    assert d["products"]["F"]["observed_at"] == "2026-06-01"
    assert d["series"]["F"] == [["2026-06-01", 700, 1]]


def test_build_fav_con_chequeo_viejo_no_aparece(tmp_path):
    """fav_skus.last_seen >14d: el favorito salio del radar — se
    comporta como cualquier muerto (fuera del payload)."""
    root = _root(tmp_path)
    _mk_fav_db(root)
    _ins(root, "insert into products values (?,?,?,?,?,?)", [
        ("F", "Fav Viejo", "M", "C", "f", None)])
    _ins(root, "insert into prices values (?,?,?,?,?,?)", [
        ("F", "2026-06-01", 700, 700, 0, 1)])
    _ins(root, "insert into fav_skus values (?,?)", [("F", "2026-09-01")])
    d = bs.build_site(str(root))
    assert "F" not in d["products"] and "F" not in d["series"]


def test_build_no_fav_viejo_sigue_fuera(tmp_path):
    """Sin entrada en fav_skus: >45d sin lectura = fuera del payload
    (comportamiento de siempre, intacto)."""
    root = _root(tmp_path)
    _mk_fav_db(root)
    _ins(root, "insert into products values (?,?,?,?,?,?)", [
        ("N", "No Fav", "M", "C", "n", None)])
    _ins(root, "insert into prices values (?,?,?,?,?,?)", [
        ("N", "2026-08-01", 500, 500, 0, 1)])
    d = bs.build_site(str(root))
    assert "N" not in d["products"] and "N" not in d["series"]


def test_build_fav_sin_precios_exporta_meta(tmp_path):
    """Fav con meta pero sin ninguna fila en prices: viaja en
    products sin romper el build (series simplemente no lo tiene)."""
    root = _root(tmp_path)
    _mk_fav_db(root)
    _ins(root, "insert into products values (?,?,?,?,?,?)", [
        ("M", "Sin Precios", "Marca", "Cat", "m", None)])
    _ins(root, "insert into fav_skus values (?,?)", [("M", "2026-10-13")])
    d = bs.build_site(str(root))
    assert d["products"]["M"]["title"] == "Sin Precios"
    assert d["products"]["M"]["current"] is False
    assert d["products"]["M"]["observed_at"] == ""
    assert "M" not in d["series"]
