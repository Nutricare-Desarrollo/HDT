/* ============================================================
   30_Bitacora.sql
   Bitácora de actividad: qué hizo cada usuario en la app.

   Una fila por ACCIÓN CON EFECTO: crear, editar, borrar, enviar,
   despachar, devolver, guardar un alisto, cambiar un rol. No se
   registra la navegación —con la app usada todo el día serían miles
   de filas de ruido por semana y las acciones de verdad quedarían
   enterradas— ni las lecturas.

   NO ES LO MISMO que dbo.HojaConsumoAuditoria, y conviven a
   propósito: esa guarda el diff campo por campo de UNA hoja, con
   valor anterior y nuevo, y la usa Bodega. Esta guarda la actividad
   de toda la app en lenguaje llano, y la ve solo el Administrador.

   SIN LLAVE FORÁNEA, igual que la auditoría de hojas: la bitácora
   tiene que sobrevivir al borrado de lo que registra. Por eso el
   registro se guarda desnormalizado, como texto legible
   ('ORT-000003', 'NUT-10104'), y no como un id que después no
   apunte a nada.

   Metodo, Ruta y Estado se guardan para poder depurar: el registro
   lo escribe un envoltorio de la API, no cada endpoint a mano, así
   que conviene poder ver de dónde salió cada fila.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.

   Aplicar a mano con psql, antes del push.
   ============================================================ */

BEGIN;

CREATE TABLE IF NOT EXISTS dbo.Bitacora (
    Id           BIGSERIAL PRIMARY KEY,
    FechaHora    TIMESTAMP(0)  NOT NULL DEFAULT (now() at time zone 'utc'),
    Usuario      VARCHAR(200)  NULL,          -- nombre o correo de quien lo hizo
    UsuarioEmail VARCHAR(200)  NULL,
    Rol          VARCHAR(30)   NULL,          -- rol con el que actuó
    Pantalla     VARCHAR(60)   NOT NULL,      -- 'Solicitud de Equipo', 'Bandejas'…
    Accion       VARCHAR(120)  NOT NULL,      -- 'Devolvió la solicitud al hospital'
    Registro     VARCHAR(120)  NULL,          -- 'ORT-000003', 'NUT-10104'…
    Detalle      VARCHAR(400)  NULL,          -- 'se descartaron 40 marcas del alisto'
    Metodo       VARCHAR(10)   NOT NULL,      -- POST | PUT | DELETE
    Ruta         VARCHAR(200)  NOT NULL,      -- ruta del endpoint, para depurar
    Estado       SMALLINT      NOT NULL       -- código HTTP de la respuesta
);

-- La pantalla: todo, lo más reciente primero.
CREATE INDEX IF NOT EXISTS IX_Bitacora_Fecha
    ON dbo.Bitacora (FechaHora DESC, Id DESC);

-- Filtro por usuario.
CREATE INDEX IF NOT EXISTS IX_Bitacora_Usuario
    ON dbo.Bitacora (UsuarioEmail, Id DESC);

-- «Qué se hizo en esta solicitud / esta bandeja».
CREATE INDEX IF NOT EXISTS IX_Bitacora_Registro
    ON dbo.Bitacora (Registro, Id DESC);

COMMIT;
