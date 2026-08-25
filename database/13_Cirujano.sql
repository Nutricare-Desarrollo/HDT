/* ============================================================================
   HDT · Hojas de Consumo — Catálogo de Cirujanos  (Fase 6)
   Ejecutar DESPUÉS de 01..12:  psql -f 13_Cirujano.sql
   ----------------------------------------------------------------------------
   Alimenta la lista desplegable "Cirujano" del encabezado de la hoja de consumo.
   El nombre se guarda TEXTUAL en dbo.HojaConsumo.Cirujano (histórico): si luego
   se corrige el nombre en el catálogo, las hojas ya creadas no se modifican.
   Idempotente: seguro de re-ejecutar.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS cat;

CREATE TABLE IF NOT EXISTS cat.Cirujano (
    Id                 SERIAL PRIMARY KEY,
    Nombre             VARCHAR(200) NOT NULL,
    Activo             BOOLEAN NOT NULL DEFAULT TRUE,
    CreadoPor          VARCHAR(200) NULL,
    FechaCreacion      TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc'),
    ActualizadoPor     VARCHAR(200) NULL,
    FechaActualizacion TIMESTAMP(0) NULL
);

-- Un mismo cirujano no puede quedar dos veces (sin distinguir mayúsculas ni espacios).
CREATE UNIQUE INDEX IF NOT EXISTS UX_Cirujano_Nombre
    ON cat.Cirujano (LOWER(TRIM(Nombre)));

-- Índice para el listado (activos, por nombre).
CREATE INDEX IF NOT EXISTS IX_Cirujano_Activo ON cat.Cirujano (Activo, Nombre);

/* ----------------------------------------------------------------------------
   Siembra: los cirujanos que ya aparecen en las hojas de consumo y en las
   cirugías programadas. Se toma el primer nombre de cada variante y se omiten
   los que ya existan en el catálogo.
   ---------------------------------------------------------------------------- */
INSERT INTO cat.Cirujano (Nombre, CreadoPor)
SELECT nombre, 'migracion 13_Cirujano.sql'
FROM (
    SELECT DISTINCT ON (LOWER(TRIM(nombre))) TRIM(nombre) AS nombre
    FROM (
        SELECT Cirujano AS nombre FROM dbo.HojaConsumo
        UNION ALL
        SELECT Cirujano AS nombre FROM dbo.Cirugia
    ) t
    WHERE nombre IS NOT NULL AND TRIM(nombre) <> ''
    ORDER BY LOWER(TRIM(nombre)), TRIM(nombre)
) s
WHERE NOT EXISTS (
    SELECT 1 FROM cat.Cirujano c WHERE LOWER(TRIM(c.Nombre)) = LOWER(TRIM(s.nombre))
);

-- Resultado
SELECT COUNT(*) AS cirujanos_en_catalogo FROM cat.Cirujano;
