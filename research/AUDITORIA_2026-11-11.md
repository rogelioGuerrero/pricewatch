# Auditoria PriceWatch SV - 2026-11-11

Estado: propuestas, no implementadas. Base auditada: `8c1f7bd0d7f5440ddd34f91f6f1e1462f0ec7262`.

## Alcance y evidencia

Revision de los sweeps PriceSmart/Siman, SQLite, build, notificaciones, provision de Appwrite, workflow diario/CI, los cinco archivos JS del frontend, template, CSS, service worker, manifest y cobertura de pruebas. El producto actual es de uso personal; no presupongo que necesite una plataforma multiusuario completa.

El CI remoto del commit auditado esta verde: https://github.com/rogelioGuerrero/pricewatch/actions/runs/43111940004 (Ruff, Python y frontend). Esto no equivale a validar el despliegue de Pages: el cambio del uploader sigue pendiente de la proxima ejecucion diaria, por decision del usuario. No se lanzo otra corrida ni se enviaron avisos durante esta auditoria.

Comprobaciones adicionales: seis casos reproducidos con mocks y SQLite temporal; navegador a 1440x1000, 390x844 y 320x740; busqueda, ficha, navegacion, teclado, fallo HTTP503 y recarga offline. El fixture visual es una captura del sitio publicado con datos al 2026-11-10, usando el template/JS actual en un servidor local aislado. Appwrite y escrituras externas estuvieron bloqueados. No son mediciones de rendimiento en un telefono real ni una auditoria de permisos de Appwrite en produccion.

Evidencia local (fuera de git):
- `C:/Users/guerr/AppData/Local/Temp/pricewatch-actions-evidence/audit_logic_repros.cjs` y `audit_logic_repros.txt`.
- `C:/Users/guerr/AppData/Local/Temp/pricewatch-actions-evidence/audit_siman_variant_repro.py` y `audit_siman_variant_repro.txt`.
- `C:/Users/guerr/AppData/Local/Temp/pricewatch-actions-evidence/pwa-audit-log.txt`.
- Capturas en `C:/Users/guerr/AppData/Local/Temp/pricewatch-audit/`.

## Hallazgos prioritarios

### 1. Alta - Una compra eliminada offline reaparece al sincronizar

Reproducido. `syncAll()` calcula las compras pendientes de borrar y ejecuta `compraDown`, pero despues vuelve a importar todas las filas de la lectura remota previa, sin excluir esas compras. Incluso un borrado exitoso se revierte localmente con esa lectura desactualizada.

Fuente: `docs/js/sync.js:96-116`. Caso: snapshot con una compra, lista local vacia, fila aun presente en la nube; se solicita el borrado remoto y la lista local termina nuevamente con una compra.

Propuesta: excluir del merge las claves pendientes de borrado y mantenerlas en una cola persistente hasta confirmar el resultado. Aceptacion: borrar offline, reconectar y repetir el sync no resucita la compra en ninguno de los dispositivos.

### 2. Alta - Los borrados fallidos pierden su reintento

Reproducido con favoritos. Los helpers de borrado ocultan errores y `syncAll()` retira las claves pendientes del snapshot aunque el borrado no se haya confirmado. En el siguiente sync, la fila remota se interpreta como nueva y vuelve al dispositivo. El patron tambien aparece en otras colecciones.

Fuente: `docs/js/sync.js:43-50,80-92,130-201`; `docs/js/siman.js:95-119`.

Propuesta: outbox local de operaciones con ID estable; confirmar solo resultados exitosos o borrados ya inexistentes. Mostrar pendientes y errores; no presentar una sesion abierta como prueba de sincronizacion completada. `paintAcct()` muestra actualmente 'sincronizado' por tener `AW.user`, no por verificar todas las operaciones (`sync.js:210-219`).

### 3. Alta - Siman puede mostrar el precio y la rebaja de otra talla

Reproducido con SQLite temporal. Una variante M disponible a $10 se procesa antes que una L disponible a $30. La vigilancia pide L. El fallback guarda primero $10 y la variante L no lo reemplaza por ser mas cara; `ok` termina true. Ademas, `broke` y `decl` se acumulan desde todas las variantes. Resultado: tarjeta talla L a $10 y marcada como minimo/oferta aunque L sigue a $30 sin rebaja.

Fuente: `scripts/build_site.py:155-186`. Los items se agrupan solo por `pid`; `scripts/sweep_siman.py:194-200` conserva una sola vigilancia por `iid`, por lo que busquedas/tallas solapadas tambien pierden contexto.

Propuesta: seleccionar primero las variantes elegibles para la vigilancia y calcular precio, disponibilidad y senales sobre ese mismo conjunto. Representar por separado producto, variante y vigilancia. Aceptacion: la talla L no hereda precio ni minimo de M; probar orden inverso, variantes agotadas y dos vigilancias del mismo producto.

### 4. Alta - Una ultima lectura antigua sigue pareciendo disponibilidad actual

Reproducido: con build del 11 de noviembre y ultima observacion del producto el 3, el frontend todavia lo incluye en `DEALS` y lo presenta como minimo historico disponible. `lastOf()` significa ultima lectura existente, no estado observado hoy. La ventana de archivo conserva series de productos ausentes, pero los veredictos no distinguen esa ausencia.

Fuente: `docs/js/state.js:30,58-68,274-321`; `scripts/build_site.py:287-298`. El stock por club exporta la ultima observacion sin su fecha (`build_site.py:232-243`), de modo que la interfaz tampoco puede explicar su antiguedad.

Propuesta: exportar presencia actual y `observed_at` por fuente/producto/club; stock con tres estados: disponible, agotado y no verificado. No recomendar comprar basandose solo en una lectura antigua. Mostrar fecha y cobertura por tienda, no solo fecha global del build.

### 5. Alta - El cache es el unico almacenamiento operativo del historial

Confirmado por arquitectura. DBs y snapshots se excluyen de git; el workflow restaura `pwdata-*` y, en frio, rescata solamente JSONL de un commit antiguo. No hay un respaldo durable independiente del cache en el flujo actual. Si desaparece el cache, no se puede reconstruir toda la serie historica con esos logs.

Fuente: `.github/workflows/daily.yml:33-58,103-114`; `.gitignore:6-16`; `README.md:28-32`.

Propuesta: mantener SQLite y un solo escritor, pero guardar backups versionados fuera del cache, con checksum, fecha, esquema y prueba periodica de restauracion en un entorno temporal. El cache debe acelerar la corrida, no ser la garantia de permanencia de los datos.

### 6. Alta si son datos personales - Las compras semilla viajan al sitio publico

Confirmado por codigo: el build incorpora `data/mis-compras.json` al payload `mis`, y cualquier navegador nuevo lo incorpora a sus compras locales. Appwrite no vuelve privado ese JSON estatico. No afirmo una filtracion de credenciales ni que se haya alterado ningun permiso remoto.

Fuente: `scripts/build_site.py:270-281,346-356`; `docs/js/state.js:108-119`.

Propuesta: sacar compras reales del payload publico. Si se mantiene una demostracion, hacerla ficticia y opt-in, separada de los datos personales. Migrar/exportar y verificar los datos existentes antes de retirar la semilla; no borrar por defecto.

### 7. Media - Un valor corrupto de localStorage puede impedir el arranque

Reproducido: `pw-favs=broken-json` lanza SyntaxError durante la carga del primer archivo. Otros estados tambien se leen con `JSON.parse` sin validacion de forma/version.

Fuente: `docs/js/state.js:89,106-108,170`; `docs/js/siman.js:15-18`; `docs/js/sync.js:69`.

Propuesta: adaptador de persistencia con lectura defensiva, validacion de esquema y migraciones. Conservar el valor corrupto para recuperacion/exportacion y permitir restablecer solo la coleccion afectada; no limpiar todo localStorage.

### 8. Media - El servidor puede leer solo una parte de Appwrite y confundir fallo con vacio

Confirmado por codigo. El frontend pagina, pero `common.aw_rows()` hace una sola peticion limitada a 500 y devuelve [] tanto si no hay filas como si falla. Esto afecta compras, favoritos, vigilancias y reglas usadas por las notificaciones. Ademas `load_watches()` vuelve al archivo semilla si la lista remota es realmente vacia: eliminar la ultima vigilancia no significa dejar de vigilar.

Fuente: `scripts/common.py:198-203`; `scripts/sweep_siman.py:150-178`; `scripts/notify.py:664-680`.

Propuesta: paginacion estable tambien en Python y resultado explicito de exito/error; lista vacia valida distinta de servicio no disponible. No usar automaticamente la semilla si el usuario decidio vaciar sus vigilancias. Comunicar que una vigilancia nueva necesita sesion/sync y la proxima corrida para traer resultados.

### 9. Media - La validacion del pipeline no demuestra integridad ni publicacion

Confirmado por codigo; el incidente de Pages ilustra el desacople. `datacheck` solo comprueba que `prices.db` no este vacia. No valida tablas, transacciones, fecha ni estado de Siman. Snapshots e historia se escriben en pasos distintos. Se guarda cache y se ejecuta notify incluso si etapas anteriores fallaron, por la condicion `always()`.

Fuente: `.github/workflows/daily.yml:90-114,127-144`; `scripts/sweep.py:581-592`; `scripts/sweep_siman.py:426-438`.

Propuesta: manifiesto de corrida con estado por fuente, fechas y cobertura; `PRAGMA quick_check`, comprobacion del esquema y de las observaciones esperadas antes de promover datos. Escribir snapshots temporalmente y promoverlos solo tras el commit de la historia. Separar recolectar, construir, desplegar y notificar para poder reintentar solo la publicacion sin volver a consultar tiendas ni enviar avisos.

Un digest puede seguir disponible cuando Pages falla, si esa es la politica elegida; un push que manda a consultar datos nuevos debe depender de la version publicada o avisar claramente del fallo. No convertir un resultado parcial en 'todo actualizado'.

### 10. Media - Hay acciones esenciales no operables con teclado

Confirmado por codigo y navegacion. Las tarjetas son `div onclick`, las estrellas son `span onclick`, y varias acciones Siman/Compartir son enlaces sin `href`. No entran al orden normal de foco. Los tabs si tienen botones, foco y teclas de navegacion: esa mejora debe conservarse.

Fuente: `docs/js/render.js:86-92,340-368`; `docs/js/state.js:193-194`; `docs/js/siman.js:181-197`; `scripts/template.html:149-155`.

Propuesta: enlaces reales para navegar y botones para actuar, con nombres que incluyan producto/accion, estado `aria-pressed` donde corresponda y controles tactiles amplios. El toggle 'lo compre' ya esta dentro de un label; necesita contexto del producto, no debe describirse como totalmente sin etiqueta. Revisar tambien el foco tras reconstruir tarjetas con `innerHTML`.

### 11. Media - Los limites y las referencias del precio necesitan explicacion

Confirmado por codigo. Gangas cuenta la lista completa pero renderiza solo 120 tarjetas sin paginacion; la busqueda corta a 60 sin informar mas resultados. Siman tiene un limite deliberado de 150 productos por busqueda que no se expone como cobertura. El ranking mezcla descuento declarado, diferencia contra maximo y diferencia contra mediana; la grafica lo rotula '% desc.', aunque no todas esas magnitudes son el mismo descuento.

Fuente: `docs/js/render.js:209-216,327-333`; `scripts/sweep_siman.py:41-43,95-99`; `docs/js/state.js:79-87`; `docs/js/app.js:344-355`.

Propuesta: 'mostrando X de Y' y cargar mas; explicar cobertura limitada sin prometer catalogo completo. Separar 'ahorro anunciado', 'vs precio habitual' y 'vs maximo registrado'. Mostrar historia insuficiente cuando corresponda. Las rachas y porcentajes calculados sobre observaciones no deben presentarse automaticamente como dias calendario completos (`scripts/build_site.py:61-95`).

### 12. Media - Offline funciona, pero no es una copia completa ni una version atomica

La recarga offline mantuvo la app y los datos; la ficha mostro correctamente un aviso sin graficas porque ECharts vive en CDN y no esta en el precache. No es un fallo total offline. Si la red devuelve HTTP500/503 en vez de desconectarse, el SW devuelve ese error y no usa el dato bueno cacheado. Los assets tienen nombres estables, se revalidan por separado y el install tolera fallos antes de retirar caches anteriores: hay riesgo de mezclar versiones o activar un shell incompleto.

Fuente: `docs/sw.js:5-18,37-89`; `scripts/template.html:16-17,183-222`.

Propuesta: distribuir localmente dependencias imprescindibles versionadas, fallback a datos previos ante errores recuperables con aviso visible, y manifiesto de assets por build. Validar offline y actualizacion de version en navegador, no solo con el DOM simulado. No se midieron aqui Core Web Vitals ni tiempos reales de carga movil.

### 13. Media - Notificaciones sin confirmacion operativa e idempotencia

Confirmado por codigo. Los errores de Resend y web push se imprimen pero no producen un resultado estructurado que el workflow pueda distinguir. Una repeticion del run puede reenviar avisos del mismo dia. El exito del proceso no prueba entrega.

Fuente: `scripts/notify.py:332-378,708-790`.

Propuesta: registrar decision, intento y resultado por canal; clave idempotente por destinatario/contenido/evento usando soporte del proveedor cuando exista; reintentos acotados. Diferenciar 'sin novedades' de 'no se pudo enviar'. Incluir `send_notifications` explicito en ejecuciones manuales y un modo de despliegue sin avisos.

### 14. Condicional antes de mas cuentas - El cliente y el digest asumen un solo usuario

Reproducido: favoritos guardados localmente se suben al iniciar una cuenta diferente; los nombres de localStorage y el snapshot no estan aislados por cuenta. El digest lee con API key filas de todas las cuentas y envia un resumen global. El repo ya advierte que los permisos de tablas existentes no se migran automaticamente; no inspeccione esos permisos remotos.

Fuente: `docs/js/sync.js:17,69-92,226-253`; `docs/js/state.js:89-119`; `scripts/notify.py:664-680,721-728`; `README.md:36-48`.

Propuesta: para el uso personal, advertencia y control explicito sobre datos del dispositivo. Antes de admitir otras cuentas: namespace por usuario, decision explicita para importar datos anonimos, aislamiento de filas verificado y destinatarios/reglas por usuario. Auditar permisos remotos con backup y autorizacion separada, sin recrear tablas.

## Propuesta de arquitectura

No recomiendo una reescritura en React/Next ni microservicios por defecto. SQLite, Python, sitio estatico y Appwrite para datos privados son adecuados para este alcance. Reforzaria sus contratos y limites:

```text
Adaptadores PriceSmart / Siman
  -> observaciones normalizadas y validacion por fuente
  -> SQLite transaccional + manifiesto de corrida + respaldo durable
  -> build del catalogo publico / resumen / historiales bajo demanda
  -> artefacto versionado -> Pages -> comprobacion de version publicada
  -> decisiones de alerta + entrega idempotente

Navegador: UI -> casos de uso -> repositorio local + outbox -> Appwrite privado
```

Contrato comun propuesto: tienda, producto, variante, moneda, precio en centavos, fecha de observacion, stock conocido/desconocido y cobertura. Versionar el esquema del payload y del estado local. Siman actualmente usa dolares y PriceSmart centavos; normalizar internamente reduce conversiones dispersas sin perder la moneda de origen.

Extraer persistencia, sincronizacion y reglas de dominio del wiring DOM. Usar modulos ES con imports explicitos y JSDoc/chequeo de tipos gradual en vez de bindings globales dependientes del orden. Mantener pruebas de contrato/golden fixtures para reglas compartidas entre web y digest; no duplicar decisiones de negocio divergentes.

Conservar el sitio estatico: separar resumen inicial, datos por tienda e historiales por producto solo cuando los presupuestos de carga lo justifiquen. No mover todo el catalogo a Appwrite ni agregar un backend siempre encendido sin una necesidad demostrada.

## Propuesta UI / UX

### Movil: orientacion y tareas, no un dashboard comprimido

La navegacion principal hoy esta oculta detras del FAB. Propuesta: barra inferior persistente con Inicio, Mi lista, Gangas y Siman; movimientos/nuevos como filtros o vistas secundarias, y Catalogo como tarjetas buscables sin descargar Perspective. El explorador avanzado sigue disponible en escritorio. Mostrar siempre la seccion/tienda activa y hacer explicito el alcance del buscador.

Inicio debe responder tres preguntas: que conviene hoy de mi lista, que cambio y que fuente esta atrasada. En primer uso: elegir club, guardar un producto y opcionalmente iniciar sesion; explicar que sin cuenta no hay sincronizacion ni nuevas vigilancias remotas. No forzar registro para navegar.

### Tarjetas: menos ruido, mas confianza

Mantener la identidad azul noche/verde, pero dar jerarquia real a nombre, precio, un solo veredicto principal y stock del club elegido con fecha. Dejar el resto de clubes, comparaciones y graficas para el detalle. Ofrecer acciones explicitas Guardar y Ver historial; 'lo compre' puede vivir en una accion secundaria o en modo compra para no competir con cada producto.

Tipografia legible, metadatos secundarios menos diminutos y areas tactiles generosas; no resolver densidad agregando mas chips. Mostrar 'no verificado' distinto de 'agotado'. Una ganga debe explicar contra que precio se compara y cuanta historia la respalda.

### Ficha y compra

En movil, ficha de pantalla completa con titulo compacto, precio, club y accion principal arriba; historial, calendario y otros clubes en secciones posteriores. La captura actual de un titulo largo ocupa muchas lineas antes de llegar al precio. En escritorio conservar master-detail. Reemplazar prompt/confirm por formularios pequenos, validacion y feedback recuperable.

En modo compra, separar lista de seguimiento y carrito; permitir cantidad, precio realmente pagado y resumen editable antes de registrar. El precio del catalogo es una estimacion, no un comprobante de pago. Compartir, objetivos y acciones Siman deben funcionar tambien con teclado/lector de pantalla.

### Estados claros

Indicador visible de offline, fecha por tienda/club, sync pendiente/error/confirmado y que ocurrira en la proxima corrida. Error de carga con Reintentar, conservar datos buenos previos y explicar la antiguedad. Cambiar 'ya lo vi' por una accion comprensible como 'Avisar solo si baja mas', y 'no me gusta' por 'Dejar de mostrar', con Deshacer.

## Plan recomendado

1. **Confianza en los datos - impacto alto, esfuerzo medio.** Corregir los merges de compras y borrados, outbox, seleccion de talla Siman, frescura/stock desconocido y lectura defensiva del estado local. Retirar datos personales del payload tras migracion aprobada. Criterio: las reproducciones de esta auditoria se convierten en regresiones que exigen el comportamiento correcto.
2. **Operacion recuperable - impacto alto, esfuerzo medio.** Backup durable/restauracion, manifiesto por fuente, validacion real de SQLite, publicacion reintentable sin recoleccion ni avisos, idempotencia y resultados por canal. Fijar versiones de Actions/dependencias y actualizar por PR; incorporar actionlint al CI. Criterio: simular fuente caida, cache perdido, deploy fallido y doble ejecucion sin perder historia ni duplicar avisos.
3. **UX y accesibilidad - impacto alto en uso diario, esfuerzo medio.** Navegacion movil visible, tarjetas simples, ficha orientada a decidir, formularios y estados claros, paginacion real. Criterio: guardar, buscar, consultar historia y registrar compra con mouse, tactil y teclado; validar a 320/390px con datos vacios, largos y desactualizados.
4. **Crecimiento medido - esfuerzo variable, solo cuando haga falta.** Modulos/tipos graduales, contratos versionados, payload por partes y perfiles multiusuario. Criterio: medir carga inicial en movil real y definir presupuesto antes de agregar librerias o cambiar de framework.

La cobertura existente de diff, parseo y arranque es valiosa. Falta cubrir el merge completo de `syncAll`, borrados fallidos y cambio de cuenta, variantes Siman, lecturas antiguas y ciclo de actualizacion/offline en navegador real. Agregar esas pruebas de riesgo aporta mas que aumentar el numero de tests que replican detalles de implementacion.

## Limites y decisiones pendientes

- No consulte ni modifique Appwrite remoto, credenciales, tablas ni permisos. La seguridad efectiva de las tablas existentes sigue requiriendo verificacion autorizada.
- No hice benchmark de rendimiento, auditoria externa de dependencias ni prueba en telefono fisico/iOS. No asigno puntuaciones Lighthouse ficticias.
- El error de Pages esta mitigado en el workflow, pero su confirmacion real espera la ejecucion diaria. Ningun cambio puede garantizar que GitHub no vuelva a fallar.
- Este informe no autoriza por si mismo migraciones, borrados, nuevos proveedores ni envios. Las fases propuestas necesitan aprobacion antes de implementarse.
