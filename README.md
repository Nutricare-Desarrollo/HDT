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

## Roles

- **Hospital:** sube hojas de consumo (wizard foto → revisar/editar → enviar) y consulta el listado.
- **Bodega:** revisa las hojas enviadas, corrige el detalle, agrega número de lote y crea la TR.
- **Administrador:** acceso a las pantallas de Hospital y de Bodega.

## Estados de una hoja

`Enviado` → `En revisión` → `Creando TR` → `Finalizada` (o `Error`).

## Configuración

La clave de Document Intelligence y la cadena de conexión a la base se cargan como variables de
entorno en el servidor (nunca en el código). Ver `api/local.settings.json.example`.
