# Changelog — HDT · Hojas de Consumo

Registro de los cambios del proyecto, por parte/tanda.

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
