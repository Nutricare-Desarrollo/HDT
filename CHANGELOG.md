# Changelog — HDT · Hojas de Consumo

Registro de los cambios del proyecto, por parte/tanda.

## [Parte 13] — Crear la hoja desde una cirugía: prellenado y catálogos

### Prellenado (`cirEnc`)
El mapeo cambió. Antes: `Cirugía → Procedimiento` y `Observación → Diagnóstico`, y
**`Requerimiento` no se usaba**. Ahora:

| Campo de la hoja | Viene de |
|---|---|
| **Diagnóstico** | `Cirugía` (+ `Observación` pegada atrás con « — », para no perderla) |
| **Procedimiento** | `Requerimiento quirúrgico` |
| **Régimen** | `Régimen` |
| **Cirujano** | `Cirujano` |

Sigue trayendo paciente, identificación, fechas y N° de caso, como antes.

### El botón lleva DIRECTO al formulario, sin el paso de la foto
Antes caía en el paso 1 del wizard («Foto de la hoja»), con un botón «Ingresar sin foto» que había
que buscar. No tenía sentido: **cuando se programa la cirugía todavía no existe la hoja física que
fotografiar**, y el encabezado ya viene de la cirugía. Ahora abre el formulario de una, igual que
«Crear hoja manualmente». La carga con foto (OCR) sigue donde siempre, en «Subir hoja de consumo».

### El botón «＋ Crear hoja de consumo» al programar una cirugía
Vivía solo en la ficha de una cirugía ya guardada. Ahora, al **guardar una cirugía nueva**, se
abre su ficha automáticamente — que es donde está el botón. Un solo lugar donde vive, y de paso
confirma que quedó guardada. Al **editar** una existente no se abre nada (el modal ya se cerró
sobre la ficha que se estaba viendo).

### Régimen y Cirujano fuera del catálogo
Los dos catálogos se comportaban distinto, y ninguno de los dos como hacía falta:

- **Cirujano** (`conservar:true`) guardaba el valor desconocido como opción `«X» (sin registrar)`,
  pero **no lo marcaba de ninguna forma**.
- **Régimen** (`conservar:false`) **descartaba el valor**: el campo quedaba en «— Seleccione —» y
  solo salía un aviso en texto. Un régimen que venía de la cirugía o del OCR **se perdía**.

Se quitó la marca `conservar` y ahora los dos hacen lo mismo: **conservan el valor, pintan el
campo en rojo y muestran el aviso al lado**, con el botón **＋** para registrarlo sin salir de la
pantalla. Mostrarlo mal es mejor que perderlo.

- El aviso dejó de decir «La hoja decía…» (redacción del OCR) porque ahora el valor también puede
  venir de una cirugía: «*«X» no está en el catálogo de regímenes*».
- Aplica a **los dos flujos**, cirugía y foto, porque es el mismo `catField()`.

### Ahora también bloquea el guardado
Un Régimen o Cirujano fuera del catálogo **apaga Guardar y Enviar** y aparece en el aviso de la
Parte 11, junto a los problemas del detalle. Son campos obligatorios que se graban **como texto**
en la hoja: dejar pasar uno inventado ensucia el dato para siempre y después no hay cómo saber si
fue un error de dedo o un cirujano real. `catPicked()` y `catRefresh()` recalculan, así que en
cuanto se elige uno válido —o se agrega con ＋— el botón revive solo.

> ⚠️ **Efecto sobre hojas viejas:** una hoja `Pendiente reposición` creada antes de este cambio,
> cuyo cirujano nunca se registró, **no se va a poder guardar ni enviar** hasta que lo elijan de la
> lista o lo agreguen con ＋. El valor no se pierde y el arreglo son dos clics, pero conviene medir
> cuántas hay antes de desplegar:
>
> ```sql
> SELECT h.Id, h.NumeroHoja, h.Estado, h.Cirujano
>   FROM dbo.HojaConsumo h
>  WHERE COALESCE(btrim(h.Cirujano),'') <> ''
>    AND NOT EXISTS (SELECT 1 FROM cat.Cirujano c
>                     WHERE lower(btrim(c.Nombre)) = lower(btrim(h.Cirujano)))
>  ORDER BY h.Id DESC;
> ```

**Bodega no cambia de comportamiento**: sus campos también se marcan en rojo (usan el mismo
`catField`), pero `guardarVer()` no bloquea. Se dejó así a propósito: Bodega es quien tiene el
grueso de las hojas viejas y trabarle el guardado por un dato heredado sería peor que el problema.

## [Parte 12] — «Entro a Crear hoja de consumo y no puedo escribir»

Síntoma reportado: se entra a la pantalla, se intenta escribir en un campo del encabezado y no
se puede; refrescando la página funciona. Era una **carrera entre la pantalla y la red**.

`openManual()` hacía, en este orden:

```js
document.getElementById('wizStep2').classList.remove('hidden');  // la pantalla YA se ve
WIZ.numeroSugerido = await siguienteNumeroHoja();                // espera a la red
fillStep2({}, []);                                               // recién aquí se crean los campos
```

Entre la línea 1 y la 3 hay una llamada a `/api/consecutivo/siguiente`. Y `#encFields` **nadie lo
limpia al salir del wizard** (solo se limpia dentro de `fillStep2`, con `innerHTML=''`). Entonces:

- **Primera vez**: la pantalla se ve con **cero campos** todo lo que tarde la red. No hay dónde
  escribir.
- **De la segunda en adelante**: se ven **los campos del render anterior**. El usuario escribe en
  ellos, llega la respuesta, `fillStep2` rehace el encabezado y **le borra lo escrito y le quita el
  foco**. Se siente como un campo que no responde.

Refrescar lo "arreglaba" porque reiniciaba el ciclo.

### Frontend — sin cambios de API ni de base
- `openManual()` **dibuja primero** (`fillStep2`) y pide el consecutivo después, sin `await`.
- Nueva función **`ponerNumeroSugerido(n)`**: coloca el N° cuando llega **sin volver a dibujar**.
  Si el usuario ya escribió un número, **no se le pisa**. Y como el valor lo puso la app y no la
  persona, vuelve a tomar `WIZ.baseline` para que **Cancelar no avise de cambios inexistentes**.
- `openReemplazo()` tenía el mismo patrón y se corrigió igual. Ahí el N° arranca **vacío** a
  propósito, en vez de mostrar el de la hoja original, para no enseñar un número que un segundo
  después cambia por el del reemplazo (`HDT-3001` → `HDT-3001-R-1`).
- `openEditarPendiente()` ya estaba bien: ahí el `await` ocurre **antes** de mostrar la pantalla.

### Verificado (reproducido antes y después, con la red demorada a propósito)
| | Antes | Después |
|---|---|---|
| Campos a los 150 ms de abrir | 0 | 13 |
| Texto escrito mientras carga | se borraba | se conserva |
| Foco al llegar la respuesta | se perdía (`body`) | se mantiene en el campo |
| N° sugerido | `HDT-3042` | `HDT-3042` |
| N° escrito por el usuario | — | respetado |
| Cancelar sin tocar nada | — | no avisa |

## [Parte 11] — Por qué está apagado el botón Guardar

Mostrando la app en el HDT pasó que el detalle estaba lleno y **Guardar y Enviar aparecían
apagados, sin ninguna explicación**. Los apaga `updateEnviarState()` cuando alguna línea tiene un
problema, y hay tres:

1. un **código** que no existe en el catálogo de productos,
2. un **N° de equipo** que no existe en la lista de equipos,
3. código y equipo válidos por separado pero que **no cruzan** (`comboBad`).

El motivo se explicaba en el **`title` del botón**, o sea un tooltip. Hospital trabaja desde el
celular: ahí no hay mouse ni hover, así que ese texto **no se leía nunca**. Y encima decía siempre
*«Hay códigos que no existen en el catálogo de productos»*, que es falso en dos de los tres casos.

### Frontend — sin cambios de API ni de base
- Nuevo **aviso visible** (`#detAviso`) entre el detalle y los botones, que dice **qué pasa y en
  cuál línea**, con un texto por caso en vez de uno solo para los tres.
- El **número de línea es un chip tocable de 34×34 px** que salta a esa tarjeta y la resalta
  (reusa `irALineaDetalle` de la Parte 7). Se dimensionó para el dedo: un dígito subrayado de 10 px
  no se puede tocar en un celular. Las filas del wizard ganaron `id="wizDet_N"` para poder saltar.
- El aviso desaparece solo y los botones reviven en cuanto se corrige la última línea.

### El caso que más despistaba
Los catálogos se cargan **en segundo plano** al entrar (`loadCatalogo`, `loadEquipos`,
`loadEquipoProd`, sin `await`) y mientras no cargan la validación es **fail-open**: todo se da por
bueno. Pero `updateEnviarState()` solo corría desde `renderDet()` y `onDet()`. Entonces:

- se abría el wizard antes de que cargara el catálogo → todo válido, botón habilitado;
- terminaba de cargar → nadie recalculaba, el botón seguía habilitado;
- se tocaba cualquier código o equipo → recién ahí se evaluaba y **el botón se apagaba solo**.

Desde afuera se veía como si la app se hubiera dañado sola. Ahora los tres `load*` llaman a
**`revalidarDetalle()`** al terminar, que repinta las celdas y recalcula los botones. Repinta con
`markDetRow()` en vez de volver a renderizar, para no arrancarle el foco al usuario si está
escribiendo justo cuando cae el catálogo.

## [Parte 10] — Descripción adicional por línea de detalle

Hospital necesita anotar sobre el producto algo que la descripción del catálogo no dice (una
aclaración de la cirugía, una medida, un detalle del material). Texto libre, **opcional**, tope de
**150 caracteres**.

> ⚠️ **Orden de despliegue:** correr `database/20_DescripcionAdicional.sql` **ANTES** de subir el
> código. La API pasa a nombrar `DescripcionAdicional` en los `INSERT` del detalle; si la columna
> todavía no existe, **guardar cualquier hoja falla**.

### Base de datos — `database/20_DescripcionAdicional.sql` (idempotente)
- Nueva columna **`dbo.HojaConsumoDetalle.DescripcionAdicional VARCHAR(150) NULL`**.
- Es una columna nueva y no se reutiliza ninguna de las dos que ya existían, porque cada una tiene
  un dueño distinto: `Descripcion` es lo que leyó el OCR, `DescripcionNutricare` es la del catálogo
  (derivada del código) y `DescripcionAdicional` es lo que escribe el usuario. Mezclarlas haría
  imposible saber después quién escribió qué.

### API (Azure Functions)
- `POST /api/hojas` y `PUT /api/hojas/{id}`: guardan la nota. Nuevo helper **`descAdicional()`**, que
  la recorta a 150 y convierte el vacío en `NULL`. Se recorta en vez de dejar que reviente el
  `INSERT`: el formulario ya limita, pero la API no puede confiar en que todo lo que le llega pasó
  por el formulario.
- `GET /api/hojas/{id}` devuelve `descripcion_adicional` en cada línea. También se agregó al
  `SELECT` del *antes* de la auditoría y al de **Diferencias** (reemplazos).
- **Dynamics no cambia**: el payload sigue mandando solo la descripción del catálogo, así que no hay
  que coordinar nada con quien mantiene el flujo de Power Automate.
- Auditoría: `descripcion_adicional` entra en `CAMPOS_DET` y en `resumenLinea()`. Es texto libre
  escrito a mano, justo el tipo de campo por el que después se pregunta quién lo puso.

### Frontend
- **Hospital (wizard)**: campo nuevo **Descripción adicional**, debajo de la Descripción. Es un
  `textarea` y no un `input`: 150 caracteres en un campo de una línea dejan ver unos 30 en el
  celular, y la nota se relee después. **Crece solo** con lo que se escribe (`autoAlto()`).
- **Contador `n/150`** que aparece solo a partir de 120 caracteres y se pone ámbar en el tope. Uno
  debajo de cada una de las 15 líneas sería ruido, pero quedarse sin poder escribir sin saber por
  qué es peor.
- **Bodega la ve pero no la edita** (`ro:true` en `BODEGA_DET_COLS`): la escribe Hospital. Igual
  viaja de vuelta en el `PUT` de `guardarVer()` — el update reescribe todo el detalle, así que sin
  reenviarla Bodega la borraría al guardar.
- **Impresión**: el formato oficial Nutricare tiene 5 columnas fijas y mínimo 18 filas, así que no
  hay lugar para una sexta. La nota se **pega a la Descripción** en la misma celda
  (`conNota()`: `Broca, de 2.5mm — la nota`). Sin nota, la hoja sale exactamente igual que antes.
- En la tarjeta de celular ocupa una fila completa (área `nota` del grid).

### Detalles que costaron
- `DET_REQ` se arma con `DET_COLS.filter(c=>!c.derived)`, así que una columna nueva **se volvía
  obligatoria sola** y habría bloqueado el envío de toda hoja sin nota. Se agregó la marca `opt` y
  el filtro pasó a `!c.derived && !c.opt`.
- `esc('')` devuelve `—`, así que el `textarea` se llena con `attr()` y no con `esc()`; si no,
  arrancaba con un guion escrito adentro.
- `autoAlto()` sobre un elemento oculto lee `scrollHeight === 0`. `fillStep2()` corre **antes** de
  quitarle el `hidden` al paso 2 en dos de sus llamadas, así que fijar el alto ahí dejaba la nota
  en `height:0px` para siempre. Se deja el alto sin fijar cuando no está visible (manda el CSS) y
  se reintenta en un `setTimeout(0)`.
- Con `box-sizing:border-box` el alto incluye el borde pero `scrollHeight` no, así que hay que
  sumarlo: sin eso el campo quedaba 2 px corto y aparecía scroll interno.

## [Parte 9] — Detalle de la hoja en celular: una tarjeta por línea (rol Hospital)

Hospital captura las hojas desde el celular. En el paso 2 del wizard el detalle son 6 columnas
(`Código`, `N° equipo`, `Descripción`, `Und`, `Reposición`, la ✕) que con
`white-space:nowrap` no bajan de ~660 px, contra los ~390 px de un teléfono: había que arrastrar
de lado para llegar a **Und** y **Reposición**, y al hacerlo se perdían de vista **Código** y
**N° equipo** junto con el encabezado que dice qué columna es cada una.

### Frontend — sin cambios de API ni de base
- Bajo **640 px** cada fila de `#detTable` deja de ser fila de tabla y pasa a ser una **tarjeta**:
  se oculta el `thead` y la fila se vuelve un grid de dos columnas
  (`"hd hd" / "cod eq" / "desc desc" / "und rep"`). Los cinco campos caben a lo ancho y **se acaba
  el scroll horizontal**. Es el mismo recurso que ya usaba `.cat-list` (Parte 6).
- La **etiqueta viaja con el campo** (`td[data-label]::before`), así que ya no se pierde al bajar.
  `DET_COLS` gana la clave `a` (área del grid) y `renderDet()` emite `data-label` y `class="dc-…"`.
- El **número de línea** del encabezado de la tarjeta es un **contador CSS** (`counter(detline)`),
  así que se renumera solo al agregar o borrar y no agrega una columna en escritorio.
- Los inputs del detalle pasan a **16 px** en celular: por debajo de eso **Safari en iPhone hace
  zoom solo al enfocar el campo**, que era lo que terminaba de recortar la pantalla.
- **`inputmode="numeric"`** en Und y Reposición (teclado numérico) y se ocultan las flechitas del
  `type=number`, que en un campo angosto se comían el ancho útil.
- **N° equipo** gana el placeholder *«solo el número»*: `equipoBlur()` ya canonizaba a `NUT-xxxx`,
  pero nada se lo decía al usuario, que tecleaba el prefijo de más.
- La **Descripción** sin código deja de ser una franja gris con un `—` suelto y explica que
  aparece al escribir el código (clase `.sin-desc`, solo en celular; en escritorio se respeta el
  `—`, que es la convención del resto de la app). Ojo: no se puede usar `:empty`, porque
  `esc('')` devuelve `—` y la celda nunca queda vacía.

### Línea nueva: se agrega al final, pero la pantalla salta a ella
`＋ Agregar línea` dejaba la tarjeta nueva fuera de la vista y había que bajar a buscarla.
- Se evaluó insertarla **al inicio**, pero la posición en el grid **se persiste**:
  `dbo.HojaConsumoDetalle.Linea` es literalmente *«orden de la línea en la hoja»* y todo se lee con
  `ORDER BY Linea, Id`. Insertar arriba renumera el resto y el orden impreso deja de calzar con la
  hoja de papel que el OCR leyó de arriba hacia abajo.
- Se resolvió sin tocar el orden: `addDetRow()` sigue haciendo `push`, y la nueva función
  `irALineaNueva()` hace `scrollIntoView({block:'nearest'})` hasta la tarjeta y le deja el **cursor
  puesto en Código**. Además de no tener que buscarla, se ahorra un toque.
- `block:'nearest'` evita mover la pantalla cuando la línea ya se veía, y se respeta
  `prefers-reduced-motion`.

### El botón «＋ Agregar línea» se mueve al final de la lista (celular)
El botón vive en el título **Detalle**, o sea arriba del todo. Con las líneas en tarjetas eso queda
lejos: al terminar la última línea había que subir a buscarlo.
- En celular se **oculta el de arriba** (`.det-add-top`) y aparece uno **a todo el ancho al final
  de la lista** (`.det-add-bottom`, 47 px de alto para el pulgar). En escritorio es al revés: el de
  arriba se queda y el de abajo no existe.
- Los dos llaman al mismo `addDetRow()`, así que el ciclo se cierra solo: **agregar → el grid salta
  a la tarjeta nueva con el cursor puesto → llenarla → el botón quedó justo debajo**. Se acabó el
  scroll en los dos sentidos.

### Lo que NO cambia
- **Escritorio queda idéntico**: verificado que sobre 640 px la fila sigue siendo `table-row`, el
  `thead` visible y los inputs en 15 px / padding 8 px.
- **Bodega tampoco se toca.** Todo el bloque está scopeado a `#detTable` (el wizard). El grid de
  Bodega (`#verDetBody`, `BODEGA_DET_COLS`, que además lleva la columna `N° Lote`) sigue como
  estaba: ellos trabajan desde portátil.
- El **color de demarcación del Anexo #2** se mantiene pintando el fondo del campo `N° equipo`.
  En la tarjeta el campo mide ~165 px, así que `NUT-10129` ya se lee completo y el bloque de color
  sigue sirviendo para ubicar la bandeja.
- No se tocó `paintEquipoCell()`, `equipoBlur()` ni el autocompletado, que Bodega comparte.

## [Parte 8] — Grid de Hojas de consumo sin Cirujano ni Instrumentista

### Frontend — sin cambios de API ni de base
- Se quitan las columnas **Cirujano** e **Instrumentista** del grid de Hojas de consumo, ahora
  para **todos los roles**. Hospital ya no las veía; se igualan Bodega y Administrador.
- El grid queda en 8 columnas: Consecutivo, Fecha y hora, Usuario, N°, Régimen, Diagnóstico,
  Artículos y Estado.
- Los dos datos **se siguen capturando y guardando**: son campos obligatorios del encabezado y se
  ven al abrir la hoja, en la impresión y en la auditoría. Lo único que se pierde es poder
  filtrar el listado por ellos.
- Se elimina `GRID_OCULTAS_HOSPITAL` y el filtrado de columnas por rol, que quedó sin uso:
  `gridCols()` devuelve siempre las mismas columnas.
- Aplica también al grid de **Pendientes de reposición**, que reutiliza estas columnas.

## [Parte 7] — N° de línea en el detalle de la hoja

Los paneles **Diferencias con la hoja original** (reemplazos) e **Historial de cambios** describen
cada cambio como Sección `Detalle` / Línea `2`, pero el grid de detalle no mostraba ese número:
había que contar las filas a ojo para ubicar la línea.

### Frontend — sin cambios de API ni de base
- Nueva primera columna **`#`** en el grid de detalle de las tres vistas de una hoja: la de
  reemplazo (Bodega), la editable (Bodega/Admin) y la de solo lectura (Hospital).
- El número es la **posición 1-based de la línea**, que es exactamente lo que graba la auditoría
  (`api/src/auditoria.js`, `linea = i + 1`). En el grid editable se renumera solo al agregar o
  borrar líneas.
- La columna **Línea** de los dos paneles es ahora un enlace: al hacer clic **salta a esa fila del
  detalle y la resalta** un par de segundos.
- No es enlace cuando no hay a dónde ir: filas de `Encabezado` (sin línea) y de `Línea eliminada`,
  cuyo número es la posición en la hoja **anterior** y ya no existe en el grid actual.

## [Parte 6] — Catálogo de Cirujano / Régimen: pantalla de administración

El botón **＋** de las listas desplegables del encabezado abría una sola caja de texto, así que
la única forma de ver o corregir el catálogo era por SQL. Ahora abre una pantalla de
administración. El cambio es del modal genérico, así que **Cirujano y Régimen lo comparten**
(y cualquier catálogo que se agregue a `CATS` lo hereda).

### API (Azure Functions) — sin migración de base
- `GET /api/cirujanos` y `GET /api/regimenes`: nuevo parámetro **`?todos=1`** para traer también
  los desactivados (lo usa el listado del modal; el `<select>` sigue pidiendo solo los activos).
  Las dos respuestas incluyen ahora el campo **`activo`**.
- `PUT /api/cirujanos/{id}` y `PUT /api/regimenes/{id}`: aceptan **`{ nombre }`, `{ activo }` o
  los dos**. Se quitó el `AND Activo = TRUE` del `UPDATE` para poder **reactivar** una opción
  desactivada. Los campos que no vienen en el body no se tocan (`COALESCE`).
- No hay cambios de esquema: la columna `Activo` ya existía en `cat.Cirujano` y `cat.Regimen`.

### Frontend
- El **＋** abre el **catálogo completo** en un listado con **filtro por nombre**, botón
  **＋ Agregar** sobre el grid, y por cada fila **Editar** (corrige el nombre) y
  **Desactivar / Activar**.
- **Desactivar no borra**: saca la opción de la lista desplegable pero la fila queda en la base y
  es reversible con el check **Ver desactivados**. Las hojas ya creadas nunca se tocan — ahí el
  nombre se guardó como texto, no como Id.
- El valor que leyó el OCR ya **no se precarga en el filtro** (casi nunca calza exacto y el
  listado abría vacío): se muestra en un aviso arriba del grid y precarga el formulario de alta,
  con la advertencia de revisar la ortografía antes de agregar.
- La fila que corresponde al valor de la hoja abierta se marca con la etiqueta **«en esta hoja»**.
- Al agregar, la opción nueva queda seleccionada en la hoja y el modal se cierra (igual que antes).
  Al corregir un nombre, el `<select>` se actualiza solo si lo corregido era justamente lo que
  traía la hoja.
- En celular cada fila se apila (nombre arriba, estado y botones debajo).

### Pendiente
- Limpiar la basura que sembró `13_Cirujano.sql` desde las hojas y cirugías (ver
  `database/13b_LimpiarCirujanos.sql`), o desactivarla desde la pantalla nueva.

## [Parte 5] — Pedido Pendiente (Fase 2)

### Base de datos — `database/06_PedidoPendiente.sql` (idempotente)
- Nueva tabla **`dbo.PedidoPendiente`** (IdProducto, Lote, Descripcion, CantidadTotal, ReposicionAnaquel,
  Ubicacion, **CantidadEnviada** default 0, **Estado** default 'Por enviar').
- Nueva tabla **`dbo.PedidoPendienteEnvio`** (CantidadEnviada, Usuario, FechaHora) — histórico de envíos por pedido.

### API (Azure Functions)
- Al guardar el resultado de Dynamics, se extraen los `Productos` del proceso **"Pedido Pendiente"** y se
  insertan en `dbo.PedidoPendiente` (se reemplazan al recrear los trabajos de la hoja).
- `GET /api/pedidos`: listado para el grid. `GET /api/pedidos/{id}`: pedido + envíos.
- `POST /api/pedidos/{id}/envios`: registra un envío parcial. Valida que la cantidad sea **> 0** y **no
  supere el pendiente** (CantidadTotal − CantidadEnviada), con bloqueo de fila. Suma a CantidadEnviada;
  el estado se mantiene **'Por enviar'**. Todo restringido a **Bodega/Administrador**.

### Frontend
- Nueva pantalla **📦 Pedido Pendiente** (Bodega/Admin): grid con **Bandeja, Código, Descripción,
  Cantidad, Reposición, Cantidad Enviada** (+ filtros por columna) y botón **📤 Enviar al Anaquel**.
- Edición de un pedido: datos del producto + **pendiente por enviar**, grid de **envíos** (Fecha y hora,
  Usuario, Cantidad enviada) y botón **＋ Agregar envío de productos** con modal y validaciones
  (≤ pendiente, ≠ 0; muestra el pendiente antes y el que quedará).

### Pendiente
- Cablear el botón **Enviar al Anaquel** cuando se tenga su endpoint (hoy muestra un aviso).

## [Parte 4] — Crear Trabajos en Dynamics (Fase 1)

### Base de datos — `database/05_Dynamics.sql` (idempotente)
- `dbo.HojaConsumo`: nueva columna **`Consecutivo`** (secuencia `dbo.seq_consecutivo`, **inicia en 3000**,
  con backfill de las hojas existentes) que se envía como `Consecutivo` al flujo; y **`DynamicsLocation`**
  para el seguimiento cuando el flujo responde 202 (asíncrono).
- Nueva tabla **`dbo.DynamicsTrabajo`** (una fila por proceso devuelto: `IdProceso`, `IdHojaConsumo`,
  `Proceso`, `Estado`) que alimenta el Histórico. El resultado completo también se guarda en `ResultadoTR`.

### API (Azure Functions)
- Nuevo módulo `api/src/dynamics.js`: invoca el flujo de Power Automate (**App Setting `DYNAMICS_API_URL`**,
  nunca en el código) y maneja el patrón asíncrono (202 + `Location`) para procesos de varios minutos.
- `POST /api/dynamics/{id}`: arma el payload `{Consecutivo, Detalle, Configuracion}` y dispara la creación.
  `Detalle`: `IdProducto`=Código, `Lote`=N° Lote, `CantidadTotal`=Und, `Ubicacion`=**N° de equipo**,
  `Descripcion`=Descripción Nutricare.
- `GET /api/dynamics/{id}/estado`: consulta el avance (polling), guarda el resultado al terminar.
- `GET /api/trabajos`: listado para el Histórico. Todo restringido a **Bodega/Administrador**.

### Frontend
- Botón **🔗 Crear Trabajos en Dynamics** en la edición de la hoja, **habilitado solo tras un Guardar
  exitoso** (que dispara la validación de códigos). Modal con **barra de progreso** y tiempo transcurrido
  mientras el proceso corre (soporta +5 min sin cortar por el límite de Azure).
- Nueva pantalla **🧾 Histórico de trabajos en Dynamics** (Bodega/Admin): grid `IdHojaConsumo`,
  `IdProceso`, `Proceso`, `Estado` con filtros por columna; clic en `IdHojaConsumo` abre la hoja relacionada.

### Pendiente (Fase 2)
- Pantalla **Pedido Pendiente** (productos del proceso "Pedido Pendiente") con envíos al anaquel.

## [Parte 3] — Pantalla de Configuración (ubicaciones Origen/Destino)

### Base de datos
- Nueva tabla `dbo.Configuracion` (`Area`, `Origen`, `Destino` + auditoría), con las tres áreas
  sembradas (`anaquel`, `nutricare`, `facturacion`). Migración idempotente: `database/04_Configuracion.sql`.

### API (Azure Functions)
- Nuevo endpoint `GET /api/configuracion`: devuelve `{ anaquel:{origen,destino}, nutricare:{...}, facturacion:{...} }`.
- Nuevo endpoint `PUT /api/configuracion`: guarda las tres áreas (upsert transaccional).
- Ambos restringidos a rol **Bodega** y **Administrador**.

### Frontend
- Nueva pestaña **⚙️ Configuración**, junto a "Hojas de consumo", visible solo para Bodega/Administrador.
- Pantalla con 3 paneles (Anaquel, Nutricare, Facturación), cada uno con las cajas **Origen** y **Destino**.
- Carga los valores guardados al abrir y los persiste con el botón **Guardar**.

## [Parte 2] — Catálogo de productos Nutricare

### Base de datos
- Nueva columna `DescripcionNutricare` en `dbo.HojaConsumoDetalle` (descripción oficial del
  catálogo, además de la que lee el OCR en `Descripcion`). Migración: `database/03_DescripcionNutricare.sql`.

### API (Azure Functions)
- Nuevo módulo `api/src/productos.js`: obtiene el catálogo desde un API externo
  (flujo de Power Automate, `PRODUCTOS_API_URL`) y lo cachea en memoria (`PRODUCTOS_CACHE_MS`).
  Normaliza `{Codigo, Descripcion, Bandeja}` → `{codigo, descripcion, bandeja}`.
- Nuevo endpoint `GET /api/productos` (proxy con caché) para que el frontend consuma el catálogo.
- `POST/PUT /api/hojas`: validan que cada `codigo` exista en el catálogo (best-effort: si el
  catálogo no responde, no bloquea) y persisten `DescripcionNutricare` (descripción oficial por código).
- `GET /api/hojas/{id}`: devuelve `descripcion_nutricare` en cada línea de detalle.
- Variables de entorno nuevas: `PRODUCTOS_API_URL`, `PRODUCTOS_API_METHOD`, `PRODUCTOS_API_BODY`,
  `PRODUCTOS_API_KEY`, `PRODUCTOS_CACHE_MS` (ver `api/local.settings.json.example`).

### Frontend
- Carga del catálogo al iniciar sesión (en segundo plano, vía `/api/productos`).
- **Hospital (wizard, paso 2):** validación de código contra el catálogo — si el código no existe,
  la celda se marca con borde rojo y no se permite enviar hasta corregirlo. Nueva columna
  **Descripción Nutricare** (autocompletada por código, solo lectura); se guardan ambas descripciones
  (la del OCR y la de Nutricare).
- **Bodega (ver/editar):** la columna **Descripción** muestra la descripción Nutricare (derivada del
  código); misma validación de códigos; se conserva la descripción del OCR al guardar.

## [Parte 1] — Rol Hospital completo + Bodega (listado y ver)

### Base de datos
- Esquema inicial (`database/01_Esquema_HojaConsumo.sql`): tablas `dbo.HojaConsumo`
  (encabezado + imagen base64 + estado + fechas), `dbo.HojaConsumoDetalle` (líneas + número de
  lote), roles (`cat.Rol`: Hospital/Bodega/Administrador), `dbo.UsuarioRol` y la vista
  `dbo.vHojaConsumo` para los listados. Estados: Enviado → En revisión → Creando TR → Finalizada / Error.

### API (Azure Functions + PostgreSQL)
- SSO (Entra ID vía Static Web Apps), registro de usuario y roles (nuevo usuario = Hospital).
- `POST /api/extraer`: recibe la imagen en base64, la lee con Azure AI Document Intelligence
  (Layout, v4.0) y devuelve `{encabezado, detalle}`; el detalle se mapea por columnas y limpia
  los espacios que mete el OCR en los códigos.
- CRUD de hojas: crear (transaccional, estado inicial *Enviado*), listar (hoy/historial),
  obtener una hoja completa; conteos para los dashboards (hoy/ayer Hospital, por estado Bodega).

### Frontend (web responsive, mobile-first)
- Login con Microsoft, navegación por rol.
- **Hospital:** inicio con conteo de hoy/ayer; grid de todas las hojas con filtros por columna
  y Hoy/Historial; **Ver** (solo lectura); **wizard de subida** (paso 1 foto/cámara o archivo →
  paso 2 revisar/editar encabezado y detalle + ver imagen → **Enviar**, con pantallas de éxito y error).
- **Bodega (parcial):** inicio con gráfico por estado; grid del listado y **Ver**.
- **Administrador:** acceso a ambos.

### Documentación
- `README.md` (arquitectura) y `GUIA_DESPLIEGUE_HDT.md` (despliegue paso a paso).

### Pendiente (próximas partes)
- Bodega: editar detalle, número de lote, botón **Crear TR** (endpoint por definir) y estados
  avanzados (En revisión → Creando TR → Finalizada / Error / reenvío).
- Pantalla de gestión de usuarios y roles (hoy se asigna por SQL).
- Pantalla de envío pendiente (Bodega).
