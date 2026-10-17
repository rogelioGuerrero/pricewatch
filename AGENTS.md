# PriceWatch SV — notas para agentes

Monitor de precios PriceSmart SV + Siman. Serverless: GitHub Actions +
SQLite en cache + GitHub Pages + Appwrite (solo datos de usuario).

## Comandos

```powershell
python scripts/build_site.py          # regenera docs/index.html + docs/data.json
python -m pytest tests                # tests (lógica de diff, logs, notify)
node --test tests/frontend/*.test.js  # tests JS del front (arranque, sync)
python -m ruff check scripts tests    # lint (config en ruff.toml)
python -m http.server -d docs 8080    # preview local del PWA
```

## Layout

- `scripts/` — sweeps, notify, build_site (todo stdlib excepto pywebpush/Pillow)
- `docs/` — PWA: `scripts/template.html` es la fuente de `index.html`
  (generado); `js/` es fuente directa. `data.json` se genera en el build.
- `data/` — runtime: dbs/snapshots/jsonl viven en Actions cache, no en git
- `tests/` — pytest + `frontend/` (node:test); `conftest.py` pone
  `scripts/` en sys.path

## Convenciones

- Fechas siempre en GMT-6 (El Salvador), no UTC
- Estilo defensivo intencional: `except` amplio en parseo de datos
  externos, `open()` sin `with` — no "arreglar" por estilo
- `ruff.toml` restringe las reglas a E/F/W/I por lo anterior
- Nada se commitea desde CI: los workflows solo leen el repo

## Memoria MCP

Hay dos servidores de memoria (knowledge graph) disponibles:

- `memory` — global (user config), preferencias del usuario y hechos
  cross-proyecto
- `memory-project` — solo este repo (`.devin/mcp_config.local.json`),
  persiste en `.devin/memory.json` (gitignored)

Al iniciar una sesión: `search_nodes`/`read_graph` en `memory-project` para
recuperar contexto previo del proyecto. Al aprender algo durable (decisión de
arquitectura, gotcha, comando no documentado): guardarlo con
`create_entities`/`add_observations` en `memory-project`. Usar `memory` solo
para preferencias que aplican a todos los proyectos.
