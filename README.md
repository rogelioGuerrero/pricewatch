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
  └─ data/events.jsonl                  (bajo/subio/oferta/agotado/reaparecio/nuevo/salio;
                                          45 días, cache de Actions)
sweep.py --stock-check (8am)     → stock por club de candidatos (se_agota)
sweep_siman.py (7am)             → radar Siman por búsquedas vigiladas
notify.py (8am)                  → digest email + push (solo si hay novedades)
build_site.py                    → docs/ (index.html ~11 KB + data.json)
GitHub Pages                     → publicación como ARTEFACTO de Actions
                                   (upload-pages-artifact + deploy-pages;
                                   el bot ya no commitea nada al repo)
Appwrite Cloud                   → sync de Mi lista + compras + targets entre
                                   dispositivos (botón "cuenta" en la app)
```

Nota: `prices.db`, `siman.db`, los snapshots y los logs de eventos **no
viajan en git** — viven en `actions/cache` (`pwdata-*`). Si el cache se
pierde, el run arranca en frío: el bootstrap del workflow rescata los
logs del último commit y no se generan eventos falsos.

## Uso local

```powershell
python scripts/sweep.py        # sweep + diff + eventos + historia
python scripts/sweep.py --dry  # solo diff entre los 2 últimos snapshots
python scripts/build_site.py   # regenera el dashboard
```

Ver `API-NOTES.md` para los endpoints descubiertos (no documentados).
