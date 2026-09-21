# PriceWatch SV

Monitor del catálogo de PriceSmart El Salvador — detecta variaciones de
precio, ofertas y disponibilidad por club entre snapshots.

## Cómo funciona

```
sweep.py (cron mar/jue)          → catálogo completo SV vía API interna
  ├─ br_discovery/getProductsByKeyword  (25 categorías raíz, 200/página)
  ├─ ct/getProduct (batch)              (stock por club solo en eventos)
  ├─ data/snapshots/YYYY-MM-DD.json     (snapshot viaja en git)
  ├─ data/prices.db                     (historia SQLite longitudinal)
  └─ data/events.jsonl                  (bajo/subio/oferta/agotado/reaparecio/nuevo/salio)
build_site.py                    → docs/index.html (dashboard estático)
GitHub Pages                     → publicación
Appwrite Cloud                   → sync de Mi lista + compras entre
                                   dispositivos (botón "cuenta" en la app)
```

## Uso local

```powershell
python scripts/sweep.py        # sweep + diff + eventos + historia
python scripts/sweep.py --dry  # solo diff entre los 2 últimos snapshots
python scripts/build_site.py   # regenera el dashboard
```

Ver `API-NOTES.md` para los endpoints descubiertos (no documentados).
