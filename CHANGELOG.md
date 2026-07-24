# Changelog — HDT · Hojas de Consumo

Registro de los cambios del proyecto, por parte/tanda.

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
