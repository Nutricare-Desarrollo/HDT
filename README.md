# HDT · Hojas de Consumo

Aplicación web para digitalizar las **hojas de consumo** del Hospital del Trauma (INS): el usuario
toma una foto de la hoja, el sistema extrae el encabezado y el detalle con **Azure AI Document
Intelligence** (Layout), el usuario revisa/corrige y envía. Bodega procesa las hojas y crea la TR.

## Arquitectura

- **Frontend:** una sola página HTML responsive (mobile-first para Hospital), desplegada como
  Azure Static Web App.
- **API:** Azure Functions (Node v4) en `api/`, con PostgreSQL (`pg`).
- **Base de datos:** Azure Database for PostgreSQL. Scripts en `database/`.
- **Extracción:** Azure AI Document Intelligence (recurso `nutricare-docintel`, modelo `prebuilt-layout`).
- **Autenticación:** SSO con Microsoft Entra ID (vía Static Web Apps).
- **Catálogo de productos:** **externo**, no vive en esta base. Ver abajo.

## Catálogo de productos

**No hay tabla de productos.** El catálogo lo sirve el flujo de Power Automate
**`HTTPGetObtieneProducto`**, cuya URL vive en la App Setting
`PRODUCTOS_API_URL` (nunca en el código: la URL lleva la firma `sig=`, que es
una credencial). `api/src/productos.js` lo consume y lo cachea en memoria diez
minutos.

Cada producto trae tres campos —`Codigo`, `Descripcion`, `Bandeja`—, que la API
normaliza a minúscula y sin espacios en el código. `GET /api/productos` les pega
además `codigo_sima`, que sí sale de esta base (`cat.ProductoSima`, migración
36).

**Consecuencias que conviene tener presentes:**

- **Los productos no se agregan ni se editan desde RIC.** Un producto nuevo, o
  una descripción corregida, se cambia en la fuente del flujo. La aplicación
  solo edita la extensión Sima.
- **Para ver el cambio sin esperar la caché:** `GET /api/productos?refresh=1`.
- **La descripción se comporta distinto en dos lugares.** En bandejas se
  resuelve en vivo contra el catálogo. En las hojas de consumo se **congela** al
  guardar (`HojaConsumoDetalle.DescripcionNutricare`), a propósito: una hoja es
  un documento histórico y su reimpresión no debe cambiar de texto. O sea que
  una corrección del catálogo aplica **de aquí en adelante**, no hacia atrás.

> El otro flujo de Power Automate del proyecto es el de avisos, que es distinto
> y está documentado en `powerautomate/README.md`.

## Roles

- **Hospital:** sube hojas de consumo (wizard foto → revisar/editar → enviar) y consulta el listado.
- **Bodega:** revisa las hojas enviadas, corrige el detalle, agrega número de lote y crea la TR.
- **Administrador:** acceso a las pantallas de Hospital y de Bodega.

## Estados de una hoja

`Enviado` → `En revisión` → `Creando TR` → `Finalizada` (o `Error`).

## Configuración

La clave de Document Intelligence y la cadena de conexión a la base se cargan como variables de
entorno en el servidor (nunca en el código). Ver `api/local.settings.json.example`.
