# Changelog — HDT · Hojas de Consumo

Registro de los cambios del proyecto, por parte/tanda.

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
