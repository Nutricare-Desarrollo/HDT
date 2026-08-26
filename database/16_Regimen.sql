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
   Siembra: los regímenes que ya aparecen en las hojas de consumo y en las
   cirugías programadas. Se toma la primera variante de cada valor y se omiten
   los que ya existan en el catálogo.
   ---------------------------------------------------------------------------- */
INSERT INTO cat.Regimen (Nombre, CreadoPor)
SELECT nombre, 'migracion 16_Regimen.sql'
FROM (
    SELECT DISTINCT ON (LOWER(TRIM(nombre))) TRIM(nombre) AS nombre
    FROM (
        SELECT Regimen AS nombre FROM dbo.HojaConsumo
        UNION ALL
        SELECT Regimen AS nombre FROM dbo.Cirugia
    ) t
    WHERE nombre IS NOT NULL AND TRIM(nombre) <> ''
    ORDER BY LOWER(TRIM(nombre)), TRIM(nombre)
) s
WHERE NOT EXISTS (
    SELECT 1 FROM cat.Regimen c WHERE LOWER(TRIM(c.Nombre)) = LOWER(TRIM(s.nombre))
);

/* ============================================================================
   FIN. Verificación:
     SELECT COUNT(*) AS regimenes_en_catalogo FROM cat.Regimen;
     SELECT Id, Nombre FROM cat.Regimen ORDER BY Nombre;

   Si la siembra trae basura del OCR (p. ej. "INS " y "1NS"), se limpia con:
     UPDATE cat.Regimen SET Activo = FALSE WHERE Id = <id>;
   Desactivar no borra: las hojas que ya usaban ese texto lo conservan.
   ============================================================================ */
SELECT COUNT(*) AS regimenes_en_catalogo FROM cat.Regimen;
