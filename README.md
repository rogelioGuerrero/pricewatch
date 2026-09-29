# PriceWatch SV

Monitor del catálogo de PriceSmart El Salvador — detecta variaciones de
precio, ofertas y disponibilidad por club entre snapshots.

## Cómo funciona

```
sweep.py (cron diario 6am)       → catálogo completo SV vía API interna
  ├─ br_discovery/getProductsByKeyword  (25 categorías raíz, 200/página)
  ├─ ct/getProduct (batch)              (stock por club solo en eventos)
  ├─ data/snapshots/YYYY-MM-DD.json     (cache de Actions, no git)
  ├─ data/prices.db                     (historia SQLite, cache de Actions)
  └─ data/events.jsonl                  (bajo/subio/oferta/agotado/reaparecio/nuevo/salio)
sweep.py --stock-check (8am)     → stock por club de candidatos (se_agota)
sweep_siman.py (7am)             → radar Siman por búsquedas vigiladas
notify.py (8am)                  → digest email + push (solo si hay novedades)
build_site.py                    → docs/index.html (dashboard estático)
GitHub Pages                     → publicación
Appwrite Cloud                   → sync de Mi lista + compras + targets entre
                                   dispositivos (botón "cuenta" en la app)
```

Nota: `prices.db`, `siman.db` y los snapshots **no viajan en git** — se
restauran/guardan vía `actions/cache` (`pwdata-*`) en cada workflow. Si el
cache se pierde, el primer run arranca en frío sin generar eventos falsos.

## Uso local

```powershell
python scripts/sweep.py        # sweep + diff + eventos + historia
python scripts/sweep.py --dry  # solo diff entre los 2 últimos snapshots
python scripts/build_site.py   # regenera el dashboard
```

Ver `API-NOTES.md` para los endpoints descubiertos (no documentados).
