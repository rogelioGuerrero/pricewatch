# PriceSmart API — hallazgos (paso 1, es-sv)

## Endpoint principal

```
POST https://www.pricesmart.com/api/ct/getProduct
content-type: application/json
cookie: vsf-locale=es-sv; vsf-currency=USD; vsf-country=sv; vsf-store=SV; vsf-channel=1bad5650-9b56-4490-b3c5-2d50f86c6716

[{"skus":["500388","290993"]},{"products":"getProductBySKU","metadata":{"channelId":"1bad5650-9b56-4490-b3c5-2d50f86c6716"}}]
```

- Sin autenticación real: basta con las cookies `vsf-*` (valores fijos para SV).
- **Batch**: `skus` es array — devuelve solo los productos disponibles en el canal SV.
- Backend: commercetools (estructura masterData/allVariants/centPrecision).
- Respuesta ~220KB por producto (verbose, trae todos los países/clubes).

## Datos extraíbles por producto

- `price.value.centAmount` — precio actual USD (centavos). Ej: 1777 = $17.77
- `price.custom.customFieldsRaw`:
  - `sign_price`, `pos_sign_price`, `prior_sign_price` — precio de letrero actual y previo
  - `last_update_date` — fecha del último cambio de precio
  - `tax_percent`, `tax_included_in_price`
- `price.discounted` — descuento activo o null
- `availability.channels.results` — **stock real por club**:
  - `channel.key` = código de club (SV: 6701 Santa Elena, 6702 Los Héroes, 6703 San Miguel, 6704 Santa Ana, 67 = canal nacional/online)
  - `availability.isOnStock`, `availableQuantity`
- `attributesRaw`: `product_availability` (JSON por país/club), categorías, etc.

## Verificado en vivo (500388, lámpara)

- Precio: $17.77 (caso del usuario confirmado)
- Stock SV: Santa Elena 16 uds; Los Héroes 0; San Miguel 0; Santa Ana 0; canal 67: 16

## Catálogo

- Sitemap: 18 sitemaps, **16.559 URLs de producto es-sv**
- Otros endpoints vistos: `POST /api/ct/getCategory`, `/api/ct/isGuest`, `/api/ecomm_ct_helper/getAnonymousCart`
- `getCategory` con `limit:200` — probable vía de listado bulk por categoría (pendiente explorar)

## Endpoint bulk — catálogo completo (paso 2, verificado)

```
POST /api/br_discovery/getProductsByKeyword
cookie: vsf-* (mismas fijas)

[{"url":"https://www.pricesmart.com/es-sv/categoria/x","start":0,"q":"<CAT_KEY>",
  "fq":[],"search_type":"category","rows":200,
  "account_id":"7024","auth_key":"ev7libhybjg5h1d1","request_id":1,
  "domain_key":"pricesmart_bloomreach_io_es",
  "fl":"pid,title,brand,slug,master_sku,price_SV,sign_price_SV,saving_amount_SV,original_price_without_saving_SV,availability_SV,inventory_SV",
  "view_id":"SV"}]
```

- Bloomreach Discovery. `rows` máx probado: 200 (500 → 400). Paginación `start`.
- `numFound` da el total de la categoría. Categoría licores: 156 docs en 1 llamada.
- Campos por doc: `master_sku`, `title`, `brand`, `price_SV` (centavos),
  `original_price_without_saving_SV`, `saving_amount_SV`, `inventory_SV` ("in stock"),
  `availability_SV`, `promoid_SV`.
- `facet_counts.facet_fields.category` trae el árbol de subcategorías con conteos
  (permite descubrir el árbol sin sitemap).
- No hay query "todo" (q='*' vacío, q='' 400) → hay que iterar categorías.
- **Categorías es-sv en sitemap: 374** → ~374-500 llamadas/día para sweep completo.
- `inventory_SV` es flag global; stock por club requiere `getProduct` por SKU
  (usar solo en productos con eventos o bajo demanda — dos niveles).

## Arquitectura de dos niveles (decidida)

1. **Sweep diario**: iterar 374 categorías × `getProductsByKeyword` →
   {sku, titulo, precio, precio_original, ahorro, in_stock} → diff → eventos.
2. **Detalle on-demand**: `getProduct` batch solo para productos con eventos
   → desglose de stock por club (67xx).

## Implicaciones de escala

- Watchlist ~150 productos: 2-3 llamadas batch/día — trivial.
- Catálogo completo: ~330 llamadas batch de 50 SKUs o vía listados por categoría — viable pero genera ~200KB×16K de payload; almacenar difs, no raw.
- No requiere Playwright en producción: curl/requests puro.
- robots.txt: productos no prohibidos para crawlers generales; ser educados (rate bajo).
