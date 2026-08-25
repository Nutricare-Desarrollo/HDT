/* ============================================================================
   HDT · Hojas de Consumo — N° de hoja único (consecutivo Prefijo-Número)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar:  psql "<cadena-de-conexion>" -f 15_NumeroHojaUnico.sql
   ----------------------------------------------------------------------------
   IDEMPOTENTE y NO destructivo.

   El campo "N° de hoja" (dbo.HojaConsumo.NumeroHoja) pasa a ser el consecutivo
   del documento, con el formato PREFIJO-NÚMERO que define la pantalla
   Configuración. Este script le pone un índice ÚNICO para que la base sea la
   última barrera contra un consecutivo repetido, incluso si dos usuarios
   guardan al mismo tiempo.

   La comparación es sobre UPPER(TRIM(NumeroHoja)): 'hdt-3001' y ' HDT-3001 '
   se consideran el mismo consecutivo. Las hojas sin número (NULL o vacío) no
   entran al índice, así que no chocan entre sí.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   PASO 1 · ¿Hay consecutivos repetidos hoy? Si esta consulta devuelve filas,
   hay que resolverlos ANTES de que el índice pueda crearse.
   ---------------------------------------------------------------------------- */
SELECT UPPER(TRIM(NumeroHoja)) AS numero_hoja,
       COUNT(*)                AS veces,
       STRING_AGG(Id::text, ', ' ORDER BY Id) AS ids
FROM dbo.HojaConsumo
WHERE NumeroHoja IS NOT NULL AND TRIM(NumeroHoja) <> ''
GROUP BY UPPER(TRIM(NumeroHoja))
HAVING COUNT(*) > 1
ORDER BY veces DESC;

/* ----------------------------------------------------------------------------
   PASO 2 · Índice único. Si hay duplicados, el bloque NO aborta el script:
   avisa por consola y deja el índice sin crear para que los resuelvas y
   vuelvas a ejecutar este mismo archivo.
   ---------------------------------------------------------------------------- */
DO $$
BEGIN
    BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS UX_HojaConsumo_NumeroHoja
            ON dbo.HojaConsumo (UPPER(TRIM(NumeroHoja)))
            WHERE NumeroHoja IS NOT NULL AND TRIM(NumeroHoja) <> '';
        RAISE NOTICE 'OK: indice UX_HojaConsumo_NumeroHoja disponible.';
    EXCEPTION WHEN unique_violation THEN
        RAISE WARNING 'NO se creo UX_HojaConsumo_NumeroHoja: hay N. de hoja repetidos. Revise el PASO 1, corrijalos y vuelva a ejecutar este script.';
    END;
END $$;

/* ----------------------------------------------------------------------------
   PASO 3 (opcional) · Alinear el "último usado" de Configuración con el mayor
   consecutivo que ya exista en las hojas, para el prefijo configurado.
   Descomentar solo si ya hay hojas con el formato PREFIJO-NÚMERO.
   ---------------------------------------------------------------------------- */
-- UPDATE dbo.ConfiguracionConsecutivo c
--    SET Consecutivo = GREATEST(COALESCE(c.Consecutivo, 0), COALESCE((
--            SELECT MAX(SUBSTRING(UPPER(TRIM(h.NumeroHoja)) FROM '[0-9]+$')::BIGINT)
--            FROM dbo.HojaConsumo h
--            WHERE UPPER(TRIM(h.NumeroHoja)) LIKE UPPER(TRIM(c.Prefijo)) || '-%'
--              AND UPPER(TRIM(h.NumeroHoja)) ~ '[0-9]+$'
--        ), 0)),
--        FechaModificacion = (now() at time zone 'utc')
--  WHERE c.Id = 1 AND c.Prefijo IS NOT NULL;

/* ============================================================================
   FIN. Verificación:
     SELECT indexname FROM pg_indexes
      WHERE schemaname='dbo' AND tablename='hojaconsumo';
     SELECT * FROM dbo.ConfiguracionConsecutivo;
   ============================================================================ */
