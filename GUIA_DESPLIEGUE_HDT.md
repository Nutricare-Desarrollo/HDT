# Guía de despliegue — HDT · Hojas de Consumo

Esta guía deja la aplicación corriendo en Azure para poder probar la subida real de hojas.
Tiene cuatro bloques: **base de datos**, **Static Web App (frontend + API)**, **variables de
configuración** (PostgreSQL, Document Intelligence y SSO) y **primer administrador**.

> Recordá: la app tiene tres piezas que ya están en el repo — `frontend/` (la web),
> `api/` (Azure Functions) y `database/` (el script SQL).

---

## 0. Requisitos previos

- Suscripción de Azure (la misma *Azure - Nutricare*).
- El repositorio **HDT** ya en GitHub (rama `main`).
- El servidor de **Azure Database for PostgreSQL** que ya usás para la app de códigos.
- El recurso de **Document Intelligence** `nutricare-docintel` (Endpoint + Clave que ya obtuviste).
- Permisos de Colaborador/Propietario sobre la suscripción.

---

## 1. Base de datos

1. En el servidor PostgreSQL existente, creá una **base nueva** llamada `hdt`
   (desde el portal de Azure, o con `CREATE DATABASE hdt;` desde `psql`).
2. Ejecutá el script del esquema contra esa base:

   ```bash
   psql "host=TU-SERVIDOR.postgres.database.azure.com port=5432 dbname=hdt user=TU_USUARIO sslmode=require" -f database/01_Esquema_HojaConsumo.sql
   ```

3. Verificá que se crearon los roles y las tablas:

   ```sql
   SELECT Nombre FROM cat.Rol ORDER BY Id;              -- Hospital, Bodega, Administrador
   SELECT * FROM dbo.vHojaConsumo;                       -- vacío al inicio
   ```

4. **Firewall:** en el servidor PostgreSQL, en *Redes/Networking*, activá
   **"Permitir el acceso a servicios de Azure"** para que las Functions de la Static Web App
   puedan conectarse. (Más adelante, para producción, se puede restringir con red privada.)

---

## 2. Crear la Static Web App (frontend + API)

1. Portal de Azure → **Crear un recurso** → **Static Web App** → **Crear**.
2. Completá:
   - **Suscripción:** Azure - Nutricare.
   - **Grupo de recursos:** `rg-nutricare-hojas-consumo` (el mismo del Document Intelligence).
   - **Nombre:** ej. `hdt-hojas-consumo`.
   - **Plan:** Standard (recomendado para producción; Free sirve para pruebas).
   - **Origen de la implementación:** **GitHub** → autorizá y seleccioná la organización, el
     repositorio **HDT** y la rama **main**.
   - **Detalles de compilación (Build Details):**
     - **App location:** `frontend`
     - **Api location:** `api`
     - **Output location:** *(dejar vacío)*
3. **Revisar + crear** → **Crear**. Azure agrega automáticamente un workflow de GitHub Actions
   al repo (`.github/workflows/…`) y hace el primer despliegue en unos minutos (pestaña **Actions**
   del repo para ver el progreso).

---

## 3. Variables de configuración (App settings de la API)

En la Static Web App → **Configuración / Environment variables** (o *Application settings*),
agregá estas variables. Son las que la API lee en tiempo de ejecución (la **clave nunca va en el
código**):

**PostgreSQL**

| Nombre | Valor |
|---|---|
| `PGHOST` | `TU-SERVIDOR.postgres.database.azure.com` |
| `PGPORT` | `5432` |
| `PGDATABASE` | `hdt` |
| `PGUSER` | tu usuario |
| `PGPASSWORD` | tu contraseña |
| `PGSSLMODE` | `require` |

**Document Intelligence**

| Nombre | Valor |
|---|---|
| `DOCINTEL_ENDPOINT` | `https://nutricare-docintel.cognitiveservices.azure.com/` |
| `DOCINTEL_KEY` | *(tu Clave 1 — pegala aquí, en el servidor)* |
| `DOCINTEL_MODEL` | `prebuilt-layout` |

Guardá. La API se reinicia sola y toma los valores.

---

## 4. SSO con Microsoft (Entra ID)

La app exige inicio de sesión con Microsoft. Configuración (una sola vez):

1. En **Microsoft Entra ID** → **Registros de aplicaciones** → **Nuevo registro**:
   - Nombre: `HDT Hojas de Consumo`.
   - Tipos de cuenta: *Solo cuentas de este directorio organizativo* (single-tenant).
   - **URI de redirección** (tipo *Web*): `https://<tu-static-web-app>.azurestaticapps.net/.auth/login/aad/callback`
2. Anotá el **Id. de aplicación (cliente)** y el **Id. de directorio (inquilino/tenant)**.
3. En **Certificados y secretos** → creá un **secreto de cliente** y copiá su valor.
4. En el archivo `frontend/staticwebapp.config.json`, reemplazá `COMPLETAR-TENANT-ID` por tu
   **tenant** en `openIdIssuer` y hacé commit/push (o dejalo y usá solo app settings, ver abajo).
5. En la Static Web App → **App settings**, agregá:
   - `AAD_CLIENT_ID` = Id. de aplicación (cliente)
   - `AAD_CLIENT_SECRET` = el secreto que creaste

> Con esto, al entrar a la app te redirige al login de Microsoft y solo entran usuarios de la organización.

---

## 5. Primer administrador (bootstrap de roles)

Todo usuario nuevo entra con rol **Hospital**. Para tener el primer **Administrador** (y desde ahí
poder asignar Bodega a quien corresponda), hacelo una vez por SQL:

1. Que el futuro admin **inicie sesión una vez** en la app (así queda registrado su correo).
2. Ejecutá en la base `hdt`:

   ```sql
   UPDATE dbo.UsuarioRol
      SET RolId = (SELECT Id FROM cat.Rol WHERE Nombre='Administrador')
    WHERE Email = 'correo-del-admin@nutricare.co.cr';
   ```

3. Los demás usuarios: el Administrador podrá reasignar roles (la pantalla de gestión de usuarios
   se agrega en una fase siguiente; por ahora, roles como Bodega se asignan con el mismo `UPDATE`).

---

## 6. Probar de punta a punta

1. Entrá a `https://<tu-static-web-app>.azurestaticapps.net` e iniciá sesión.
2. Como Hospital: **Subir hoja de consumo** → tomá/seleccioná una foto → **Continuar** (lee con
   Document Intelligence) → revisá/corregí encabezado y detalle → **Enviar hoja de consumo**.
3. Verificá que aparezca en el grid en estado **Enviado** y que **Ver** muestre los datos y la imagen.
4. Como Bodega/Administrador: revisá el inicio (gráfico por estado) y el listado.

---

## 7. Notas de seguridad (datos de pacientes)

- Los servicios (Document Intelligence, PostgreSQL, Static Web App) están dentro del **tenant de
  la organización**; Document Intelligence **no usa los datos para entrenar**.
- La **clave** de Document Intelligence y la **contraseña** de la base viven solo como *app settings*
  del servidor, nunca en el código ni en el repositorio.
- Para producción, conviene restringir la red del PostgreSQL (evitar "todas las redes") y revisar
  retención/borrado de las imágenes.

---

## 8. Costos (referencia)

- **Document Intelligence:** F0 gratis para pruebas (500 páginas/mes); S0 pago por página en producción.
- **Static Web App:** plan Free para pruebas; Standard para producción.
- **PostgreSQL:** el mismo servidor que ya tenés; una base adicional no agrega costo de servidor.

Consultá los precios actualizados en el portal de Azure antes de pasar a producción.
