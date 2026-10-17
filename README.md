# PriceWatch SV

Monitor del catálogo de PriceSmart El Salvador — detecta variaciones de
precio, ofertas y disponibilidad por club entre snapshots.

## Cómo funciona

```
daily.yml (cron diario 6am SV, un solo run secuencial)
  sweep.py                     → catálogo completo SV vía API interna
    ├─ br_discovery/getProductsByKeyword  (25 categorías raíz, 200/página)
    ├─ ct/getProduct (batch)              (stock por club solo en eventos)
    ├─ data/snapshots/YYYY-MM-DD.json     (cache de Actions, no git)
    ├─ data/prices.db                     (historia SQLite, cache de Actions)
    └─ data/events.jsonl                  (bajo/subio/oferta/agotado/reaparecio/nuevo/salio;
                                            45 días, cache de Actions)
  sweep.py --stock-check       → stock por club de candidatos (se_agota)
  sweep_siman.py               → radar Siman por búsquedas vigiladas
  notify.py                    → digest email + push (solo si hay novedades)
  build_site.py                → docs/ (index.html ~11 KB + data.json)
GitHub Pages                   → publicación como ARTEFACTO de Actions
                                   (upload-pages-artifact + deploy-pages;
                                   el bot ya no commitea nada al repo)
Appwrite Cloud                 → sync de Mi lista + compras + targets entre
                                   dispositivos (botón "cuenta" en la app)
```

Nota: `prices.db`, `siman.db`, los snapshots y los logs de eventos **no
viajan en git** — viven en `actions/cache` (`pwdata-*`). Si el cache se
pierde, el run arranca en frío: el bootstrap del workflow rescata los
logs del último commit y no se generan eventos falsos.

Riesgo aceptado: `push_subs` en Appwrite permite `create("any")` —
cualquiera con el endpoint puede registrar una suscripción basura; el
impacto es solo recibir mis pushes, no leer datos.

AVISO - Permisos de tablas existentes: las tablas de usuario en
Appwrite ahora se crean solo con `create("users")` a nivel tabla +
`rowSecurity` (los permisos por fila los da el cliente al creador del
documento). **Las tablas ya provisionadas conservan sus permisos de
tabla viejos**: el código nuevo no los remedia por sí solo y
`setup_appwrite.py` nunca actualiza los PERMISOS de una tabla que ya
existe (aunque sí puede agregarle columnas faltantes). Corregirlas
requiere una migración manual aprobada por separado: auditar
propiedad/permisos a nivel fila, hacer backup, y actualizar los
permisos de la tabla EN EL LUGAR (sin recrear ni borrar nada). Si
existe una database legacy (documentsdb) el script aborta con aviso en
vez de borrarla: nunca la elimina automáticamente.

## Uso local

```powershell
python scripts/sweep.py        # sweep + diff + eventos + historia
python scripts/sweep.py --dry  # solo diff entre los 2 últimos snapshots
python scripts/build_site.py   # regenera el dashboard
python -m pytest tests         # tests de la lógica de diff/eventos
node --test tests/frontend/*.test.js  # tests JS: arranque del front + sync
python -m ruff check scripts tests   # lint (misma config que CI)
```

CI corre ruff + pytest + tests JS en cada push (`ci.yml`). Dependencias fijadas en
`requirements.txt`; `requirements-dev.txt` agrega pytest y ruff.

Ver `API-NOTES.md` para los endpoints descubiertos (no documentados).
