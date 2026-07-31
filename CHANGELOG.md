# Changelog — HDT · Hojas de Consumo

Registro de los cambios del proyecto, por parte/tanda.

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
