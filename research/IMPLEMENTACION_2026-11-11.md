# Fiabilidad de PriceWatch: implementacion y operacion

Esta rama conserva Python, SQLite, GitHub Actions/Pages y Appwrite. No migra el
catalogo a otro proveedor ni introduce un framework. Las validaciones locales no
equivalen a un despliegue en produccion ni a una auditoria de permisos remotos.

## Datos y observaciones

- El payload version 2 anade moneda, fecha de observacion, presencia en la ultima
  recoleccion y calidad por fuente. Conserva los campos anteriores para lectores
  antiguos. PriceSmart usa centavos; Siman mantiene `p` en dolares por
  compatibilidad y anade `price_cents`.
- Siman selecciona primero las variantes de la talla elegible. Precio, lista,
  disponibilidad, minimo anterior y condiciones pertenecen a la misma variante.
  Los precios nulos/cero no se convierten en una ganga gratuita.
- Las pertenencias a vigilancias y las corridas se guardan de forma aditiva en
  SQLite. Una vigilancia vacia confirmada no se sustituye por una semilla.
- El radar Siman sigue siendo un catalogo publico y acotado: hasta 150 productos
  por consulta. No representa todo Siman ni cobertura exhaustiva. Sus etiquetas
  de consulta asociadas a productos tambien son publicas; no usar datos sensibles
  como terminos de busqueda.
- Una observacion no actualizada no equivale a agotado. La politica del cliente
  distingue disponible, agotado, antiguo y desconocido. Exige fecha de la fuente,
  observacion propia y como maximo un dia de negocio de antiguedad; la tolerancia
  cubre las horas anteriores al barrido de las 06:00 en El Salvador.

## Estado privado

- Cada cuenta tiene un namespace local. El estado antiguo sin cuenta se conserva
  como invitado; la importacion a una cuenta requiere una accion explicita.
- Una respuesta tardia no debe confirmar operaciones ni mezclar lecturas en otra
  cuenta. La cola conserva identificadores y operaciones fallidas para reintento;
  los borrados pendientes no se vuelven a importar por una lectura antigua.
- Las compras tienen identidad por fila, no por producto/fecha/precio. Dos
  unidades iguales pueden ser compras distintas. La compatibilidad de la nube se
  conserva sin anadir columnas remotas.
- `mis` queda vacio en el JSON publico. El archivo original de compras se conserva
  y se genero una copia privada verificada fuera del repositorio, en
  `%USERPROFILE%\Documents\PriceWatch-Backups`.
- Esto NO borra el archivo fuente ni copias ya publicadas, caches ajenos o el
  historial Git. Retirar esos registros del repositorio/historial requiere una
  decision separada, respaldo y autorizacion; no se reescribe historia aqui.
- El aislamiento del cliente no convierte el digest existente en un servicio
  multiusuario: el emisor conserva el alcance personal configurado del proyecto.
  No incorporar usuarios ajenos sin definir destinatarios/propiedad de los avisos
  y revisar los permisos reales de Appwrite.

## Recoleccion y publicacion

El camino diario es: restaurar cache o respaldo, recolectar, validar, construir,
publicar, comprobar la version publicada y entonces notificar. Un fallo de una
fuente o de la validacion no promueve un cache nuevo como si estuviera sano.
Los snapshots se reemplazan atomicamente despues de grabar historia.

`PriceWatch Daily` admite dos modos manuales:

- `publish` (predeterminado): recupera datos, valida y publica sin consultar
  tiendas ni enviar avisos. Sirve para reintentar Pages sin repetir recoleccion.
- `full`: recolecta y publica; los avisos manuales requieren ademas
  `send_notifications=true`. La ejecucion programada conserva el horario diario.

No se lanzo el workflow manual durante esta implementacion. La compatibilidad
upload-pages-artifact v4 / deploy-pages v4 permanece pendiente de confirmacion en
una ejecucion diaria programada. CI no prueba la API de despliegue de Pages.

## Respaldos y recuperacion

El cache es una optimizacion. Cada corrida validada genera tambien un artefacto
`pricewatch-backup-<run>-<attempt>` con:

- Copias SQLite consistentes mediante su API de backup, snapshots y logs.
- Manifiesto versionado, fechas por fuente y SHA-256 por archivo.
- Recibos de notificacion para conservar los reintentos ya confirmados.
- Prueba de extraccion y validacion de la copia antes de publicarla.

El artefacto se conserva 90 dias, sujeto al limite del repositorio/proveedor.
Contiene la historia acumulada, pero NO es una garantia de conservacion ilimitada:
una inactividad mayor a la retencion puede dejar el proyecto sin punto de
recuperacion. Para archivo de largo plazo, descargar periodicamente una copia a
almacenamiento privado independiente de GitHub. No se configura otro proveedor
ni se realiza esa transferencia automaticamente.

La restauracion automatica acepta artefactos de Daily en `main`, verifica hashes,
miembros y bases de datos, y rechaza destinos que ya tengan runtime. Un respaldo
invalido no se extrae encima de datos existentes; se intenta uno anterior.

Comprobaciones locales, sin consultar tiendas ni enviar avisos:

```powershell
python scripts/data_health.py check --data-dir data
python scripts/data_health.py check --data-dir data --fresh
python scripts/data_health.py backup --data-dir data --output backup/catalogo-NUEVO.tar.gz
python scripts/data_health.py restore --archive backup/catalogo-NUEVO.tar.gz --data-dir recuperacion-NUEVA
```

Usar nombres NUEVOS: backup/restauracion no deben sobrescribir copias o runtime
existentes. La validacion completa comprueba esquemas, SQLite, fechas, snapshots y
JSONL; la recuperacion verifica el contenido exacto contra el manifiesto.
No ejecutar un build real con bases ausentes esperando conservar el catalogo:
el build vacio es util para pruebas, no reemplaza una recuperacion.

## Avisos y limites

- El emisor registra aceptacion, omision y fallo; un fallo de entrega no termina
  silenciosamente en verde. La verificacion de publicacion debe pasar primero.
- Resend recibe una clave de idempotencia estable y reintentos acotados. Los
  recibos se guardan despues de la aceptacion del proveedor y se respaldan.
- Push omite recibos ya confirmados. No existe una transaccion atomica entre un
  proveedor push y el filesystem: un cierre abrupto despues del envio y antes de
  persistir el recibo aun puede producir un duplicado. No se promete exactamente
  una entrega, ni que aceptacion equivalga a entrega al dispositivo.
- `--dry-run` evita los envios; las pruebas usan dobles de proveedor. No se
  enviaron correos/push reales ni se cambiaron permisos o datos de Appwrite.

## Validacion de entrega

El cierre requiere regresiones Python/JS, Ruff, actionlint, un build aislado y
flujos de navegador de escritorio/movil, incluidos teclado, datos antiguos,
almacenamiento corrupto, offline y HTTP 503. El registro de evidencias local y el
informe de entrega indican que paso y que queda pendiente; esta guia no sustituye
esa evidencia ni confirma que los cambios esten publicados.

## Resultados verificados (cierre local 2026-11-13/14)

Pasados en local, sin despliegue publico ni Appwrite real:

- Frontend Node: **141/141** (`node --test tests/frontend/*.test.js`),
  incluidas 7 pruebas de propiedad de cuenta/namespace, 11 de frescura,
  20 de service worker y 6 de bootstrap.
- Python: **158/158** (`python -m pytest tests`); ruff limpio;
  actionlint limpio en `ci.yml`/`daily.yml` (binario cacheado 1.7.x).
- Build verificado en raiz temporal aislada con fixtures sinteticos
  (`Temp\pw-isobuild-*`): produce index/data/version coherentes. La
  reconstruccion del catalogo real NO se corrio: `data/prices.db` y
  `data/siman.db` viven en el cache de Actions. Un build accidental en
  raiz con bases ausentes escribio un `docs/data.json` vacio; se
  restauraron `docs/data.json`/`docs/version.json` desde la copia
  publica preservada (`Temp\pricewatch-preview\data.json`, generated
  2026-11-10, n_products 3071) aplicando `mis=[]` y
  `siman.watches=[]` por la receta aprobada. `docs/index.html`
  permanece del build nuevo (shell v28).
- Puerta headless real (Playwright, `chromium_headless_shell-1228`,
  dos contextos 1440x900 / 390x844, servidor local dual v27->v28, sin
  red externa): **26/26 aserciones** — marcadores v27 servidos desde
  cache, la app v28 arranca bajo el worker viejo SIN ejecutar assets
  viejos (cohorte mixta resuelta), `controllerchange` v27->v28 tras
  `reg.update()`, cache v28 presente con el snapshot validado, offline
  real sirve shell+data con `DATA_FROM_CACHE=true`, sin pageerror,
  dialogo nativo modal con fondo bloqueado y foco restaurado al
  cerrar, sin overflow horizontal y bnav correcta por viewport.
- Hallazgo real documentado: tras el borrado del cache v27 en
  `activate`, puts en vuelo del worker saliente recrearon el nombre
  (llaves bare, `?v=28` de la transicion y `data.json`). La prueba lo
  elimino manualmente y no reaparecio durante la observacion posterior
  bajo v28. Esto NO demuestra limpieza automatica completa. El SW v28
  usa su propio cache; el bootstrap puede recuperar JSON valido de
  caches anteriores si falta una copia actual. No se observo mezcla
  de assets, pero el cache residual puede ocupar espacio hasta otra
  activacion o limpieza.
- El SDK Appwrite intento `/v1/account` al arrancar y el guard lo
  rechazo; 25 imagenes publicas externas abortadas por route; **cero
  respuestas externas completadas**.

### Limites explicitos que quedan

- Los cambios siguen locales: no se hizo commit ni push, ni se lanzo
  Daily manualmente. No se verifico una ejecucion remota ni
  Appwrite/ACL en vivo; el emisor sigue siendo de un solo usuario.
- El catalogo restaurado es del 2026-11-10: las lecturas muestran
  honestamente "antiguo/sin verificar", comportamiento correcto para
  datos viejos, no un defecto.
- Los tests SW/bootstrap usan mocks de CacheStorage; la puerta
  headless es evidencia de browser real pero no de produccion publica.
- La resurreccion del cache viejo por puts en vuelo queda como
  limite conocido de limpieza; el borrado manual de la prueba no es
  una correccion implementada en la aplicacion.

## Compatibilidad del cache historico

La primera corrida del nuevo workflow, `43603596327`, publico datos del
14 de noviembre pero arranco sin el historial: anadir `notifications.json`
a las rutas cambio la version interna del cache de Actions, aunque la
clave conservaba el prefijo `pwdata-`. El cache del 13 seguia retenido.

El parche conserva las seis rutas originales del catalogo, en el mismo
orden, tanto al restaurar como al guardar. Los recibos usan un cache
independiente `pwnotify-`, ademas del respaldo validado. Se restauran
despues de recuperar el respaldo y solo si no existen; se guardan tambien
tras un fallo de entrega si hay recibos confirmados y datos validados.
No se eliminan caches anteriores. Las regresiones comprueban este
contrato de migracion, no solamente la sintaxis YAML.
