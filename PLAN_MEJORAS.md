# Plan de Mejoras de Diseño, Arquitectura y Calidad — PriceWatch SV

Este documento contiene el diagnóstico técnico profundo de **PriceWatch SV** y una guía de ejecución paso a paso diseñada para que otro agente de ingeniería implemente las mejoras de forma segura, verificable y respetando las convenciones del repositorio.

---

## 0. Restricciones y Convenciones que el Agente Ejecutor DEBE Respetar

Antes de modificar cualquier archivo, ten en cuenta las reglas de `AGENTS.md` y `ruff.toml`:

1. **Zona horaria**: Todas las fechas de negocio deben calcularse en **GMT-6 (El Salvador)**, nunca en UTC puro.
2. **Estilo defensivo intencional**: No "limpiar" bloques `except Exception:` amplios en el parseo de JSONL/APIs externas ni reemplazar `open()` por `with` solo por estética.
3. **Linter y Tests**: Toda modificación debe pasar `python -m ruff check scripts tests` (reglas `E`, `F`, `W`, `I`) y `python -m pytest tests`.
4. **Artefactos fuera de Git**: `docs/index.html`, `docs/data.json`, `docs/version.json`, `data/*.db`, `data/*snapshots/` y `data/*events.jsonl` están en `.gitignore`. La fuente del HTML es `scripts/template.html` y el JS vive en `docs/js/`.
5. **Dependencias**: Mantener el backend en stdlib + `requests`, `pywebpush` y `Pillow` (`requirements.txt`). No introducir frameworks pesados.

---

## 1. Corrección de Bugs Críticos y de Integridad de Datos (Prioridad Alta)

### 1.1. Enlazar realmente el historial en recodificados de Siman y actualizar `watch`/`talla`
- **Problema actual**:
  1. El docstring de `scripts/sweep_siman.py` (líneas 6–8) indica que cuando un listing muere y aparece otro equivalente se emite `recodificado` y *"se enlaza la historia"*. Sin embargo, `diff()` (`sweep_siman.py:349-353`) solo emite el evento `{"iid": n["iid"], "type": "recodificado", "old_iid": d["iid"], ...}` pero `record_history()` (`sweep_siman.py:263-293`) nunca migra ni enlaza la historia en `siman.db`. Como resultado, en `scripts/build_site.py:219-250`, el nuevo `iid` arranca con 1 sola lectura (`s[:-1]` vacío, `prev_min = None`), por lo que `broke` da `False`, el contador de observaciones `n` se reinicia a `1`, y a los 14 días (`fcut` en `build_site.py:207`) el `old_iid` desaparece junto con todo su historial de precios.
  2. En `scripts/sweep_siman.py:279-283`, la sentencia `ON CONFLICT(itemId) DO UPDATE SET` de la tabla `items` actualiza `pid`, `title`, `link`, `image`, `vname`, `last_seen` e `imghash`, pero **omite `watch` y `talla`**. Si el usuario agrega o modifica la talla de un watch existente, `siman.db` conserva para siempre la talla vieja (o `NULL`) con la que se vio el `itemId` por primera vez.
- **Acción requerida**:
  1. En `scripts/sweep_siman.py:279-283`, agregar `watch=excluded.watch, talla=excluded.talla` al `ON CONFLICT(itemId) DO UPDATE SET`.
  2. En `scripts/sweep_siman.py`, crear una función `link_recoded_history(events)` (o ejecutarla dentro de `record_history(cur, today, events)`) que, para cada evento con `e["type"] == "recodificado"` y `e.get("old_iid")`:
     - Copie las filas históricas de `prices` del `old_iid` hacia el nuevo `e["iid"]` usando `INSERT OR IGNORE INTO prices (itemId, date, price, list, qty, avail, card) SELECT ?, date, price, list, qty, avail, card FROM prices WHERE itemId = ?` (pasando `(e["iid"], e["old_iid"])`).
     - Actualice `first_seen` del nuevo `itemId` en `items` al `MIN(first_seen)` entre el viejo y el nuevo.
  3. Añadir un test en `tests/test_sweep_siman.py` que verifique que tras un `recodificado`, `prices` conserva la serie histórica bajo el nuevo `itemId` y que cambios en `talla` se reflejan al actualizar `items`.

### 1.2. Fechas en GMT-6 en el Frontend (eliminar desfase UTC después de las 6:00 PM SV)
- **Problema actual**:
  - `docs/js/state.js:115` (`comprar`), `docs/js/state.js:156` (`comprarAuto`) y `docs/js/siman.js:94` (`seenUp`) usan `new Date().toISOString().slice(0,10)`.
  - En El Salvador (GMT-6), cualquier acción realizada entre las 18:00 y las 23:59 hora local genera la fecha ISO del **día siguiente**, desalineando compras y vistos respecto a `D.generated`.
- **Acción requerida**:
  1. Definir en `docs/js/state.js` (junto a los helpers de fecha en líneas 7–10):
     ```javascript
     const todaySV = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
     ```
  2. Reemplazar `new Date().toISOString().slice(0,10)` por `todaySV()` en `docs/js/state.js:115`, `docs/js/state.js:156` y `docs/js/siman.js:94`.

### 1.3. Corregir `last_ch` en `scripts/notify.py` y proteger contra DB inexistente
- **Problema actual**:
  - En `scripts/notify.py:287`, dentro de `catalog_state()`, se asigna `"last_ch": last["date"] if ch else None`, donde `last = rows[-1]` (la fecha de la última lectura global del SKU) en lugar de `ch[-1]["date"]` (la fecha del último cambio de precio, como sí hace `scripts/build_site.py:132-136`).
  - Además, `catalog_state()` en `notify.py:263` abre `sqlite3.connect(DB)` y ejecuta `SELECT` sobre `products` y `prices` sin verificar si `DB` existe o si las tablas están creadas (a diferencia de `siman_items()` en la línea 302 que sí verifica `if not os.path.exists(SIMAN_DB): return {}`).
- **Acción requerida**:
  1. En `scripts/notify.py:260`, si `not os.path.exists(DB)`, retornar `{}, None`, y envolver la lectura SQL en `try ... except sqlite3.OperationalError: return {}, None`.
  2. En `scripts/notify.py:287`, cambiar `"last_ch": last["date"] if ch else None` por `"last_ch": ch[-1]["date"] if ch else None`.

### 1.4. Escapado HTML consistente en el Frontend (prevención de rotura de DOM / XSS)
- **Problema actual**:
  - En `docs/js/render.js:172`, la alerta de precio objetivo construye:
    ``alerts.push([`🎯 ${(D.products[s]||{}).title||s} a ${fmt(l[1])} (objetivo ${fmt(TARGETS[s])})`, "", "", "", s]);``
    y luego `render.js:194-195` y `app.js:69` insertan ese texto crudo en `innerHTML` sin pasar el título por `esc()`. Si un título de producto contiene `<` o `&`, rompe el marcado de `#alerts` y de `#dlg-nav`.
  - En `docs/js/app.js:423` y `docs/js/state.js:195`, el nombre del club `n` / `k` se inserta en `innerHTML` sin `esc()`.
  - En `docs/js/siman.js:171,173`, `yaLoVi` y `noMeGusta` interpolan `${p.pid}|${tk}|${(p.ihs||[]).join(",")}` dentro de un atributo `onclick="..."` con comillas simples.
- **Acción requerida**:
  1. Aplicar `esc()` al título del producto al construir las alertas en `docs/js/render.js:172` (o escapar `t` en `render.js:195` y `app.js:69`).
  2. Aplicar `esc()` a los nombres de club en `docs/js/app.js:423` y `docs/js/state.js:195`.
  3. En `docs/js/siman.js:159-175`, usar `data-rule="${esc(sKey(p))}"` y `data-price="${p.p || 0}"` con delegación de eventos en `#g-siman` (igual que ya se hace en `#siman-watches` y `#siman-muted`), eliminando los `onclick` inline con strings concatenados.

---

## 2. Arquitectura y Eliminación de Duplicación (DRY)

### 2.1. Crear módulo compartido `scripts/common.py`
- **Problema actual**:
  Existe duplicación directa de funciones críticas de dominio entre los scripts de Python, con divergencias sutiles:
  1. **`norm` y `tkey`**:
     - `scripts/sweep_siman.py:50-59` filtra con `unicodedata.category(c) != "Mn"` y `re.compile(r"[a-z0-9]+").findall(s)`.
     - `scripts/notify.py:80-85` filtra con `c.isalnum()`, lo cual en Python incluye caracteres Unicode como `²`, `³`, `º`, `½`, produciendo llaves distintas a `sweep_siman.py` y a `tkeyJS` (`docs/js/siman.js:13-14`, que usa `/[^a-z0-9]+/g`).
  2. **`talla_hit`**: Triplicada idéntica en `scripts/sweep_siman.py:115-124`, `scripts/notify.py:68-77` y `scripts/build_site.py:187-195`.
  3. **`hamming` (distancia aHash 64-bit)**: Duplicada en `scripts/sweep_siman.py:83-85` y `scripts/notify.py:399-403`.
  4. **`prune_log`**: Duplicada en `scripts/sweep.py:524-549` y `scripts/sweep_siman.py:398-423`.
  5. **Zona horaria `SV_TZ` (`GMT-6`)**: Repetida manualmente en `sweep.py`, `sweep_siman.py`, `notify.py` y `build_site.py`.
  6. **Cliente REST y esquemas de Appwrite**: Duplicados entre `scripts/setup_appwrite.py` (que aún usa `urllib.request.urlopen`), `scripts/notify.py` (`aw`, `aw_rows`, `ensure_*_table`), `scripts/sweep.py` (`favs_remote`) y `scripts/sweep_siman.py` (`watches_remote`).
- **Acción requerida**:
  1. Crear `scripts/common.py` con:
     - `SV_TZ = timezone(timedelta(hours=-6))` y `today_sv() -> str`.
     - `norm(s: str) -> str` y `tkey(s: str) -> str` unificados usando `TOKEN_RE = re.compile(r"[a-z0-9]+")` (paridad 100% con `tkeyJS` del frontend).
     - `talla_hit(vname: str, talla: str) -> bool`.
     - `hamming(a: str, b: str) -> int` (con manejo seguro de `ValueError`/`TypeError` retornando `99`).
     - `prune_jsonl(path: str, keep_days: int = 45) -> int`.
     - Definición declarativa única `APPWRITE_TABLES` y helpers `aw_request()`, `aw_rows()`, `ensure_tables()` compartidos por `setup_appwrite.py`, `notify.py`, `sweep.py` y `sweep_siman.py`.
  2. Refactorizar `sweep.py`, `sweep_siman.py`, `notify.py`, `build_site.py` y `setup_appwrite.py` para importar desde `common`, manteniendo intactos los nombres públicos que los tests existentes importan (`sweep.prune_log`, `sweep_siman.norm`, `sweep_siman.tkey`, `sweep_siman.talla_hit`, `notify.tkey`, etc.) como alias o wrappers delgados para no romper ningún test existente.

### 2.2. Modularizar `scripts/build_site.py` con punto de entrada `main()`
- **Problema actual**:
  - `scripts/build_site.py` ejecuta todas las consultas SQLite, cálculos de agregados (`agg`), lectura de archivos y escritura de `docs/data.json` y `docs/index.html` a nivel de módulo al ser importado (líneas 19–318).
  - Esto impide escribir tests unitarios para la lógica de agregación (`agg`, cálculo de `of_every`, `of_cur`, `of_end`, `d_out`, `temp`, consolidación de productos Siman) y hace que el script falle con `sqlite3.OperationalError` si se ejecuta sobre una base de datos vacía o recién creada.
- **Acción requerida**:
  1. Extraer en `scripts/build_site.py` funciones puras o parametrizables:
     - `compute_agg(series, latest) -> dict`
     - `build_siman_payload(siman_db_path, siman_events_path, watchlist_path, gen_date) -> dict`
     - `build_site(root_dir=ROOT) -> dict`
     - `main()` protegido por `if __name__ == "__main__": main()`.
  2. Manejar defensivamente tablas inexistentes en `prices.db` (igual que ya se hace para `club_stock` en las líneas 40–49).

---

## 3. Sincronización Multi-Dispositivo y Web Push (`docs/js/sync.js` y `docs/js/app.js`)

### 3.1. Evitar "resurrección" de elementos borrados durante `syncAll()`
- **Problema actual**:
  - En `docs/js/sync.js:45-110`, `syncAll()` hace una unión aditiva ciega entre `localStorage` y Appwrite:
    - Si el usuario borra un favorito, una compra, un precio objetivo (`TARGETS`), un watch de Siman (`SWATCH`) o restaura un producto silenciado (`SMUTE`) en el Dispositivo A (lo cual lo borra de Appwrite), cuando abre el Dispositivo B (que aún conserva el elemento en su `localStorage`), `syncAll()` ve que el elemento local no está en Appwrite y **lo vuelve a subir a la nube**.
    - En `COMPRAS` (`sync.js:58-62`), incluso si una compra local ya tenía `c.rid` (es decir, ya había sido sincronizada previamente con Appwrite y luego fue borrada en otro dispositivo), al no encontrarla en `rmap`, el código ejecuta `compraUp(c)` y la recrea con un nuevo `$id`.
    - Además, las compras semilla de `D.mis` (`data/mis-compras.json`) se vuelven a inyectar en `COMPRAS` en cada llamada a `syncAll()` (`sync.js:48-50`) y en `rebuildPaid()` (`state.js:98`), haciendo imposible eliminar una compra semilla.
- **Acción requerida**:
  1. **Compras (`COMPRAS`)**:
     - En `sync.js:58-62`, si un elemento local ya tiene `c.rid` pero `k` no está en `rmap` (ni su `c.rid` está en `rc`), fue borrado en otro dispositivo: debe filtrarse fuera de `COMPRAS`, no re-subirse. Solo los elementos con `!c.rid` son compras creadas offline pendientes de `compraUp`.
     - Migrar `D.mis` a `COMPRAS` una única vez usando un flag `localStorage.getItem("pw-mis-seeded")` en `state.js` y eliminar la re-inyección permanente de `D.mis` en `rebuildPaid()` y `syncAll()`.
  2. **Colecciones de estado (`FAV`, `SWATCH`, `SMUTE`, `TARGETS`)**:
     - Guardar en `localStorage` el snapshot de llaves sincronizadas en el último `syncAll()` exitoso (ej. `pw-sync-snap` con `{favs, watch, mute, targets}`).
     - En `syncAll()`, calcular para cada colección:
       - `addedLocally`: elementos presentes en local que **no** estaban en `pw-sync-snap` -> subirlos a Appwrite.
       - `deletedRemotely`: elementos que **sí** estaban en `pw-sync-snap` pero ya **no** vienen en la respuesta de Appwrite -> eliminarlos del estado local en lugar de re-subirlos.
       - Actualizar `pw-sync-snap` al finalizar `syncAll()`.
  3. **Limpieza de reglas Siman migradas**:
     - En `docs/js/siman.js:63-82`, cuando `upg(r)` actualiza una regla vieja (`tkey` plano o `pid|tkey`) a la versión completa `pid|tkey|ihs`, registrar las reglas viejas reemplazadas para que, si hay sesión en Appwrite, se eliminen las filas obsoletas de `siman_muted` / `siman_seen` y no acumulen basura hacia el límite de 500 filas.

### 3.2. Robustez en el registro de Web Push (`docs/js/app.js`)
- **Problema actual**:
  - En `docs/js/app.js:562-593`, `navigator.serviceWorker.ready` (línea 565) se invoca antes de `navigator.serviceWorker.register("sw.js")` (línea 592).
  - En `pushBtn.onclick` (`app.js:573-587`), cuando el usuario se suscribe, `AW.dbs.createRow(...)` tiene `.catch(() => {})`. Si la escritura en Appwrite falla por red (y no por `409 Conflict`), el navegador queda con la suscripción activa (`sub != null`), el icono cambia a `🔔`, pero el servidor jamás se entera del endpoint.
  - Cuando el usuario toca `🔔` para desactivar avisos (`if (sub) { await sub.unsubscribe(); return paint(); }`), no se intenta borrar el registro `sub-${h16(sub.endpoint)}` en Appwrite (aunque `push_subs` solo tiene `create("any")` por seguridad, lo cual es correcto y está documentado en `README.md:33-35`).
- **Acción requerida**:
  1. Mover `navigator.serviceWorker.register("sw.js", {scope: "./"})` antes del IIFE de Web Push.
  2. En `pushBtn.onclick`, esperar (`await`) a `AW.dbs.createRow(...)`; si lanza un error cuyo código **no** sea `409` (ya existe), ejecutar `await sub.unsubscribe()` antes de `paint()` para que el icono no mienta mostrando `🔔` cuando el backend no guardó la suscripción.

---

## 4. Base de Datos, Payload y Pipeline CI/CD

### 4.1. Poda de `siman.db` y optimización de consulta en `build_site.py`
- **Problema actual**:
  - En `scripts/build_site.py:211`, se ejecuta `SELECT * FROM prices ORDER BY date` sobre `siman.db`, cargando en memoria todas las lecturas históricas de todos los `itemId` muertos desde el origen de los tiempos, aunque en las líneas 207–209 `sitems` ya filtró solo los vistos en los últimos 14 días (`last_seen >= fcut`).
  - A diferencia de `club_stock` en `sweep.py` (que poda filas >90 días), `siman.db` nunca poda `items`, `prices` ni `imgcache`. Dado que Siman recodifica productos y URLs de imágenes constantemente, la base de datos en el cache de GitHub Actions crece sin tope.
- **Acción requerida**:
  1. En `scripts/build_site.py:211`, cargar de `prices` únicamente las filas cuyos `itemId` están en `sitems` (por ejemplo filtrando `if r["itemId"] in sitems:` antes de agregar a `sser`, o con `WHERE itemId IN (SELECT itemId FROM items WHERE last_seen >= ?)`).
  2. En `scripts/sweep_siman.py:record_history`, agregar una poda de mantenimiento (p.ej. retener 120 días de `last_seen`):
     - Borrar de `items` aquellos con `last_seen < cutoff_120d`.
     - Borrar de `prices` aquellos con `itemId NOT IN (SELECT itemId FROM items)`.
     - Borrar de `imgcache` aquellos con `url NOT IN (SELECT image FROM items WHERE image IS NOT NULL)`.

### 4.2. Optimización sin pérdida del payload `docs/data.json`
- **Problema actual**:
  - `docs/data.json` incluye redundancias fáciles de eliminar sin cambiar el contrato que consume el frontend:
    1. En `products` (`build_site.py:21`), cada valor es `dict(r)` de `SELECT * FROM products`, por lo que repite `"sku": "..."` tanto en la clave del objeto como dentro del diccionario de cada uno de los ~16,000 productos.
    2. En `series` (`build_site.py:28-29`), cada punto es `[date, price, in_stock, saving]`. En >90% de los puntos `saving` es `0` o `0.0`. Todo el frontend (`state.js`, `render.js`, `app.js`) ya accede al ahorro con `r[3] || 0` (o `pt[3] || 0`).
- **Acción requerida**:
  1. En `scripts/build_site.py`, al construir `products`, omitir la llave redundante `"sku"` del diccionario interno (y omitir claves con valor `None` o `""` si el frontend ya usa `p.brand || ""` y `p.image || ""`).
  2. En `series`, emitir `[r["date"], r["price"], r["in_stock"], r["saving"]]` cuando `r["saving"]` sea mayor a 0, y `[r["date"], r["price"], r["in_stock"]]` cuando no haya ahorro, ahorrando cientos de miles de `,0` en el JSON serializado.

### 4.3. Orden de despliegue y notificaciones en `.github/workflows/daily.yml`
- **Problema actual**:
  - En `.github/workflows/daily.yml:90-138`, `notify.py` corre **antes** de `upload-pages-artifact` y `deploy-pages`.
  - Cuando `notify.py` envía una alerta Web Push al teléfono, el usuario recibe la notificación inmediatamente, pero el despliegue a GitHub Pages tarda ~30–60 segundos más en completarse. Si el usuario toca la notificación al instante, abre la PWA con el `data.json` del día anterior.
- **Acción requerida**:
  1. Mover los pasos `Check data sana antes de guardar cache`, `Save data cache`, `Empaquetar sitio (artefacto)` y `Publicar a GitHub Pages` **antes** del paso `Digest email + push alerts (solo si hay novedades)`.
  2. Configurar el paso `Digest email + push alerts` con `if: always() && steps.datacheck.outputs.ok == '1'` para conservar la propiedad actual de que un eventual fallo en GitHub Pages nunca bloquee el envío del digest por correo/push, garantizando a la vez que cuando el push llega al dispositivo el sitio nuevo ya está publicado.

---

## 5. Rendimiento y UX del Frontend (`docs/`)

### 5.1. Evitar re-renderizado de paneles ocultos en `render()` (`docs/js/render.js`)
- **Problema actual**:
  - `render()` (`docs/js/render.js:94-310`) reconstruye el HTML de los 7 paneles (`#g-cambios`, `#g-ofertas`, `#g-stock`, `#g-nuevos`, `#g-favs`, `#g-siman`, `#g-buscar`) y recalcula `movChart` y `dealChart` en cada llamada, incluso al marcar/desmarcar un ítem del carrito (`cartToggle`), una estrella (`toggleFav`) o al teclear en el buscador (`#q`).
- **Acción requerida**:
  1. En `render()`, calcular siempre las alertas globales (`#alerts`, `RESUMEN`, `RESUMEN_N`, `#shopbar`, contador de `#tabs`), pero reconstruir el `.innerHTML` pesado únicamente del `.pane.on` activo.
  2. Al cambiar de tab (`.tab.onclick` en `docs/js/app.js:29-43`), invocar `render()` (o renderizar el pane entrante) antes de `sparks()`, asegurando que el tab recién activado esté siempre fresco sin penalizar las interacciones en los demás tabs.

### 5.2. Mejoras puntuales de UX en Ficha de Producto y Panel Siman
- **Problema actual**:
  1. En `docs/js/siman.js:180-192`, los campos `#sw-q` (búsqueda a vigilar) y `#sw-t` (talla) no responden a la tecla `Enter`; el usuario está obligado a hacer clic en `+ vigilar`.
  2. Cuando se abre laapp mediante un deep link `?sku=12345` (`docs/js/app.js:540-541`) y luego se cierra la ficha (`dlg.close()`), el query param `?sku=12345` permanece en la URL; si la página se recarga (p.ej. al tocar el banner `#upd` de "Hay datos nuevos — actualizar"), vuelve a abrir la ficha de un producto que ya se había cerrado.
- **Acción requerida**:
  1. En `docs/js/siman.js`, agregar listener `keydown` en `#sw-q` y `#sw-t` tal que si `e.key === "Enter"`, cierre `#sw-sug` y dispare `$("#sw-add").click()`.
  2. En `docs/js/app.js:532`, dentro del listener `dlg.addEventListener("close", ...)`, si `location.search.includes("sku=")`, limpiar el parámetro `sku` con `history.replaceState(null, "", location.pathname)` (preservando `?tab=` si existiera).

---

## 6. Ampliación de la Suite de Tests (`tests/`)

Actualmente existen 44 tests que cubren `diff` de ambos sweeps, `prune_log`, `club_stock_diff` y `siman_gangas`. El agente ejecutor debe añadir tests unitarios para las siguientes funciones críticas que hoy tienen 0% de cobertura:

1. **`tests/test_notify.py`**:
   - `test_build_alerts_completo`: verificar `fav_drop`, `fav_oferta`, `fav_resurtir` (cuando precio actual `<= round(paid * 100)`), `tgt_hit` (cruce de umbral `from > tgt >= to`), `big_rebaja` (`<= -30%`), agrupación de clubes en `fav_drain`/`fav_clubout` y exclusión de eventos sin stock vía `live()`.
   - `test_digest_html_escapa_html_y_renderiza_secciones`: verificar que títulos y clubes con caracteres especiales (`<script>`, `&`) salgan escapados en el HTML generado y que el correo se construya sin errores tanto con `aw_down=True` como con listas vacías.
2. **`tests/test_sweep.py`**:
   - `test_stock_candidates_prioriza_ofertas_y_favs`: verificar que `_priority_watch` y `stock_candidates` nunca descarten ofertas activas ni favoritos aunque los eventos recientes superen el cap de 400.
   - `test_record_history_respeta_skip_inherited`: verificar que los SKUs en `skip` (categorías caídas heredadas del snapshot anterior) no fabriquen filas falsas en `prices.db`.
3. **`tests/test_build_site.py` (nuevo archivo)**:
   - Tras modularizar `scripts/build_site.py` (sección 2.2), testear `compute_agg` verificando el cálculo de `min`, `max`, `med`, `pct_min`, `vs_med`, `d_out` (racha agotado), `n_of` y `of_every` (cadencia mediana entre inicios de oferta), y el flag `temp` (productos de temporada con vida `< 60` días fuera del snapshot actual).

---

## 7. Orden de Ejecución Recomendado para el Agente

Para minimizar conflictos y mantener el repositorio verde en cada paso, ejecuta el plan en este orden:

1. **Paso 1**: Crear `scripts/common.py` y migrar las funciones duplicadas (`SV_TZ`, `today_sv`, `norm`, `tkey`, `talla_hit`, `hamming`, `prune_jsonl`, helpers de Appwrite). Correr `pytest` y `ruff`.
2. **Paso 2**: Aplicar las correcciones de backend en `scripts/sweep_siman.py` (enlace de historial en `recodificado`, update de `watch`/`talla`, poda de `siman.db`), `scripts/notify.py` (`last_ch` y guarda de DB) y modularizar `scripts/build_site.py` (funciones + `if __name__ == "__main__":` + optimización de payload y query de `siman.db`).
3. **Paso 3**: Añadir los nuevos tests en `tests/test_notify.py`, `tests/test_sweep.py`, `tests/test_sweep_siman.py` y `tests/test_build_site.py`. Verificar con `python -m pytest tests` y `python -m ruff check scripts tests`.
4. **Paso 4**: Aplicar las mejoras de frontend en `docs/js/state.js` (`todaySV`, migración única de `D.mis`), `docs/js/sync.js` (sincronización con detección de borrados remotos), `docs/js/siman.js` (delegación de eventos sin `onclick` inline, tecla `Enter`, limpieza de reglas migradas), `docs/js/render.js` (escapado HTML en alertas y render perezoso del pane activo) y `docs/js/app.js` (orden de registro del SW, validación de `createRow` en Web Push, limpieza de `?sku=` al cerrar ficha).
5. **Paso 5**: Actualizar el orden de pasos en `.github/workflows/daily.yml` para que `notify.py` se ejecute inmediatamente después del despliegue a GitHub Pages con `if: always() && steps.datacheck.outputs.ok == '1'`.
6. **Paso 6**: Ejecutar la verificación final completa (`python -m ruff check scripts tests` y `python -m pytest tests`).
