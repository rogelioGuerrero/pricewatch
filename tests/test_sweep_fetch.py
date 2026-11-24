"""Fetch/retry/shape guards de sweep.py (PriceSmart) — HTTP falso.

La respuesta de Bloomreach se valida antes de confiar: un 500 con JSON
bonito, una pagina vacia anticipada, un numFound raro o docs sin id no
deben convertirse en datos; cada categoria que cae queda en `failed`
sin resultado parcial.
"""

import sqlite3
from types import SimpleNamespace

import pytest
import requests
import sweep


class Resp:
    def __init__(self, payload=None, status=200):
        self.payload = payload
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


def page(num_found, docs):
    return {"response": {"numFound": num_found, "docs": docs}}


def doc(sku):
    return {"master_sku": sku, "title": f"Producto {sku}"}


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda *a: None)


@pytest.fixture
def http(monkeypatch):
    """SESSION falsa: post() saca la siguiente Resp de la cola."""
    calls = []

    class Fake:
        queue = []

        def post(self, url, json=None, headers=None, timeout=None):
            calls.append((url, json))
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

    monkeypatch.setattr(sweep, "SESSION", Fake())
    return sweep.SESSION, calls


def test_dos_paginas_completas_arrancan_en_cero(http):
    http[0].queue = [
        Resp(page(250, [doc(f"A{i:03}") for i in range(200)])),
        Resp(page(250, [doc(f"A{i:03}") for i in range(200, 250)])),
    ]
    docs, nf = sweep.fetch_category("G10D03")
    assert nf == 250 and len(docs) == 250
    starts = [c[1][0]["start"] for c in http[1]]
    assert starts == [0, 200]


def test_pagina_vacia_anticipada_reintenta_una_vez_y_falla(http):
    # numFound dice que hay 5 pero docs viene vacio en start=0:
    # respuesta incompleta — un reintento, no ciegamente vacio
    http[0].queue = [Resp(page(5, [])), Resp(page(5, []))]
    with pytest.raises(Exception):
        sweep.fetch_category("G10D03")
    assert len(http[1]) == 2, "exactamente un retry"


def test_http_500_luego_exito_reintenta(http):
    http[0].queue = [Resp(status=500), Resp(page(1, [doc("A1")]))]
    docs, nf = sweep.fetch_category("G10D03")
    assert nf == 1 and len(docs) == 1


def test_http_500_con_json_lista_no_es_exito_vacio(http):
    # el cuerpo puede parecer valido; raise_for_status manda
    http[0].queue = [Resp(page(0, []), status=500),
                     Resp(page(1, [doc("A1")]))]
    docs, _ = sweep.fetch_category("G10D03")
    assert len(docs) == 1


@pytest.mark.parametrize("payload", [
    {"response": {"numFound": -1, "docs": []}},          # negativo
    {"response": {"numFound": True, "docs": []}},       # bool != int
    {"response": {"numFound": "3", "docs": []}},        # str
    {"response": {"docs": []}},                          # sin numFound
    {"response": {"numFound": 1, "docs": [{}]}},         # doc sin id
    {"response": {"numFound": 1, "docs": "x"}},          # docs no lista
    {"respuesta": {}},                                   # shape ajeno
])
def test_forma_invalida_se_rechaza_tras_un_reintento(http, payload):
    http[0].queue = [Resp(payload), Resp(payload)]
    with pytest.raises(Exception):
        sweep.fetch_category("G10D03")
    assert len(http[1]) == 2


def test_numfound_cero_valido_devuelve_vacio(http):
    http[0].queue = [Resp(page(0, []))]
    docs, nf = sweep.fetch_category("G10D03")
    assert docs == [] and nf == 0
    assert len(http[1]) == 1


def test_pagina2_vacia_descarta_docs_parciales(http):
    # pagina 1 valida (200), pagina 2 vacia pese a numFound=250:
    # reintenta una vez a start=200 y falla — los 200 ya bajados NO
    # se devuelven
    http[0].queue = [
        Resp(page(250, [doc(f"A{i:03}") for i in range(200)])),
        Resp(page(250, [])),
        Resp(page(250, [])),
    ]
    with pytest.raises(Exception):
        sweep.fetch_category("G10D03")
    starts = [c[1][0]["start"] for c in http[1]]
    assert starts == [0, 200, 200], "el retry repite el mismo start"


def test_sweep_falla_a_mitad_de_paginacion_sin_parcial(monkeypatch):
    monkeypatch.setattr(sweep, "CATEGORIES",
                        {"G10D03": "Alimentos", "X1": "Otra"})
    llamadas = {"G10D03": 0}

    def post(url, json=None, headers=None, timeout=None):
        cat = json[0]["q"]
        if cat == "G10D03":
            llamadas["G10D03"] += 1
            if llamadas["G10D03"] == 1:
                return Resp(page(250, [doc(f"A{i:03}")
                                     for i in range(200)]))
            return Resp(page(250, []))   # pagina 2 vacia, siempre
        return Resp(page(1, [doc("OK1")]))

    monkeypatch.setattr(sweep, "SESSION",
                        SimpleNamespace(post=post))
    products, failed = sweep.sweep()
    assert failed == {"Alimentos"}
    assert list(products) == ["OK1"], \
        "los 200 docs de la pagina 1 tampoco sobreviven al fallo"


def test_sweep_marca_categoria_caida_sin_resultado_parcial(http,
                                                           monkeypatch):
    monkeypatch.setattr(sweep, "CATEGORIES",
                        {"G10D03": "Alimentos", "X1": "Otra"})

    def post(url, json=None, headers=None, timeout=None):
        cat = json[0]["q"]
        if cat == "G10D03":
            return Resp(page(5, []))          # vacia anticipada, siempre
        return Resp(page(1, [doc("OK1")]))

    monkeypatch.setattr(sweep, "SESSION",
                        SimpleNamespace(post=post))
    products, failed = sweep.sweep()
    assert failed == {"Alimentos"}
    assert list(products) == ["OK1"], "la categoria caida no retiene docs"


# ---------- fetch_club_stock: meta de favoritos (fav_skus) ----------

def _getproduct(*prods):
    return Resp({"data": {"products": {"results": list(prods)}}})


def _prod(sku, name="Fav Prod", brand="Marca", cat="Cat", slug="p-fav",
          stock=True, qty=5):
    """Respuesta ct/getProduct minima: una variante con un canal SV."""
    return {"masterData": {"current": {
        "name": name, "slug": slug,
        "categories": [{"name": cat}] if cat else [],
        "allVariants": [{
            "sku": sku,
            "attributesRaw": [{"name": "brand", "value": brand}],
            "availability": {"channels": {"results": [{
                "channel": {"key": "6701",
                            "nameAllLocales": [{"value": "Santa Ana"}]},
                "availability": {"isOnStock": stock,
                                 "availableQuantity": qty}}]}}}]}}}


def _leer(db, sql):
    con = sqlite3.connect(str(db))
    rows = con.execute(sql).fetchall()
    con.close()
    return rows


def test_club_stock_siembra_meta_del_fav(http, tmp_path, monkeypatch):
    """Favorito con fila en products: se siembra la meta del
    getProduct (imagen NULL) y fav_skus anota la fecha."""
    db = tmp_path / "prices.db"
    monkeypatch.setattr(sweep, "DB_PATH", str(db))
    http[0].queue = [_getproduct(_prod("A"))]
    sweep.fetch_club_stock({"A"}, "2026-10-14", favs={"A"})
    assert _leer(db, "select sku, last_seen from fav_skus") == [
        ("A", "2026-10-14")]
    assert _leer(db, "select sku, title, brand, category, slug, image "
                     "from products") == [
        ("A", "Fav Prod", "Marca", "Cat", "p-fav", None)]
    # el stock por club se escribe igual que siempre
    assert _leer(db, "select sku, in_stock, qty from club_stock") == [
        ("A", 1, 5)]


def test_club_stock_no_pisa_meta_del_listado(http, tmp_path, monkeypatch):
    """La fila del listado Bloomreach manda: INSERT OR IGNORE jamas
    sobrescribe title/imagen ya grabados."""
    db = tmp_path / "prices.db"
    con = sqlite3.connect(str(db))
    con.execute("""create table products (sku text primary key,
        title text, brand text, category text, slug text, image text)""")
    con.execute("insert into products values "
                "('A','Del Listado','B','C','s','img')")
    con.commit()
    con.close()
    monkeypatch.setattr(sweep, "DB_PATH", str(db))
    http[0].queue = [_getproduct(_prod("A", name="Otro"))]
    sweep.fetch_club_stock({"A"}, "2026-10-14", favs={"A"})
    assert _leer(db, "select title, image from products") == [
        ("Del Listado", "img")]
    # el visto-bueno del fav si se anota aunque la meta no haga falta
    assert _leer(db, "select last_seen from fav_skus") == [("2026-10-14",)]


def test_club_stock_no_fav_no_toca_products(http, tmp_path, monkeypatch):
    """Sku fuera de la lista del usuario: ni meta ni fav_skus."""
    db = tmp_path / "prices.db"
    monkeypatch.setattr(sweep, "DB_PATH", str(db))
    http[0].queue = [_getproduct(_prod("B"))]
    sweep.fetch_club_stock({"B"}, "2026-10-14", favs={"Z"})
    assert _leer(db, "select * from products") == []
    assert _leer(db, "select * from fav_skus") == []
    assert _leer(db, "select sku from club_stock") == [("B",)]


def test_club_stock_sin_favs_como_antes(http, tmp_path, monkeypatch):
    """favs=None: comportamiento identico al anterior — solo
    club_stock, sin meta ni fav_skus."""
    db = tmp_path / "prices.db"
    monkeypatch.setattr(sweep, "DB_PATH", str(db))
    http[0].queue = [_getproduct(_prod("B"))]
    sweep.fetch_club_stock({"B"}, "2026-10-14")
    assert _leer(db, "select sku, in_stock, qty from club_stock") == [
        ("B", 1, 5)]
    assert _leer(db, "select * from products") == []
    assert _leer(db, "select * from fav_skus") == []
