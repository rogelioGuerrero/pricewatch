# PriceWatch SV — notas para agentes

Monitor de precios PriceSmart SV + Siman. Serverless: GitHub Actions +
SQLite en cache + GitHub Pages + Appwrite (solo datos de usuario).

## Comandos

```powershell
python scripts/build_site.py          # regenera docs/index.html + docs/data.json
python -m pytest tests                # tests (lógica de diff, logs, notify)
python -m ruff check scripts tests    # lint (config en ruff.toml)
python -m http.server -d docs 8080    # preview local del PWA
```

## Layout

- `scripts/` — sweeps, notify, build_site (todo stdlib excepto pywebpush/Pillow)
- `docs/` — PWA: `template.html` es la fuente de `index.html` (generado);
  `js/` es fuente directa. `data.json` se genera en el build.
- `data/` — runtime: dbs/snapshots/jsonl viven en Actions cache, no en git
- `tests/` — pytest; `conftest.py` pone `scripts/` en sys.path

## Convenciones

- Fechas siempre en GMT-6 (El Salvador), no UTC
- Estilo defensivo intencional: `except` amplio en parseo de datos
  externos, `open()` sin `with` — no "arreglar" por estilo
- `ruff.toml` restringe las reglas a E/F/W/I por lo anterior
- Nada se commitea desde CI: los workflows solo leen el repo
