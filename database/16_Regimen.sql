/* ============================================================================
   HDT · Hojas de Consumo — Catálogo de Régimen  (Fase 7)
   Ejecutar DESPUÉS de 01..15:  psql "<cadena-de-conexion>" -f 16_Regimen.sql
   ----------------------------------------------------------------------------
   Alimenta la lista desplegable "Régimen" del encabezado de la hoja de consumo,
   igual que cat.Cirujano alimenta la de Cirujano.

   El valor se guarda TEXTUAL en dbo.HojaConsumo.Regimen (histórico): si luego
   se corrige el nombre en el catálogo, las hojas ya creadas no se modifican.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS cat;

CREATE TABLE IF NOT EXISTS cat.Regimen (
    Id                 SERIAL PRIMARY KEY,
    Nombre             VARCHAR(60)  NOT NULL,   -- igual que dbo.HojaConsumo.Regimen
    Activo             BOOLEAN NOT NULL DEFAULT TRUE,
    CreadoPor          VARCHAR(200) NULL,
    FechaCreacion      TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc'),
    ActualizadoPor     VARCHAR(200) NULL,
    FechaActualizacion TIMESTAMP(0) NULL
);

-- Un mismo régimen no puede quedar dos veces (sin distinguir mayúsculas ni espacios).
CREATE UNIQUE INDEX IF NOT EXISTS UX_Regimen_Nombre
    ON cat.Regimen (LOWER(TRIM(Nombre)));

-- Índice para el listado (activos, por nombre).
CREATE INDEX IF NOT EXISTS IX_Regimen_Activo ON cat.Regimen (Activo, Nombre);

/* ----------------------------------------------------------------------------
   SIN SIEMBRA — a propósito.

   La versión anterior de este script copiaba al catálogo los regímenes que ya
   estaban en dbo.HojaConsumo y dbo.Cirugia. En la práctica eso trae la basura
   del OCR ("1NS", "INS ", "PRIVAD0") y deja la lista desplegable inservible,
   igual que pasó con cat.Cirujano (ver 13b_LimpiarCirujanos.sql).

   Así que la tabla se crea VACÍA: la lista arranca en «— Seleccione —» y Bodega
   agrega los regímenes buenos desde la app, con el botón + del campo Régimen.
   Correr este archivo de nuevo NO reinserta nada.

   Las hojas ya creadas no se ven afectadas: guardan el régimen como texto en
   dbo.HojaConsumo.Regimen, no el Id del catálogo.
   ---------------------------------------------------------------------------- */

/* ============================================================================
   FIN. Verificación:
     SELECT COUNT(*) AS regimenes_en_catalogo FROM cat.Regimen;
     SELECT Id, Nombre FROM cat.Regimen ORDER BY Nombre;

   Para vaciar el catálogo si quedó con valores que no sirven:
     DELETE FROM cat.Regimen;
   Eso no toca ninguna hoja: el régimen se guarda como texto en la hoja.
   ============================================================================ */
SELECT COUNT(*) AS regimenes_en_catalogo FROM cat.Regimen;
