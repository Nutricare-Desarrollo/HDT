/* ============================================================================
   HDT · Hojas de Consumo — Observaciones al resolver un reemplazo  (Fase 10)
   Ejecutar DESPUÉS de 01..18:  psql "<cadena-de-conexion>" -f 19_ReemplazoObservacion.sql
   ----------------------------------------------------------------------------
   Bodega tiene que escribir una observación para poder marcar un
   reemplazo / corrección como resuelto. Queda en la hoja del reemplazo, junto
   con quién lo resolvió y cuándo.

   Se guardan las tres cosas y no solo el texto: una observación sin autor ni
   fecha obliga a cruzarla con otra tabla para saber de quién es y de cuándo.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

ALTER TABLE dbo.HojaConsumo
    ADD COLUMN IF NOT EXISTS ObservacionResolucion VARCHAR(2000) NULL;

ALTER TABLE dbo.HojaConsumo
    ADD COLUMN IF NOT EXISTS ResueltoPor VARCHAR(200) NULL;

ALTER TABLE dbo.HojaConsumo
    ADD COLUMN IF NOT EXISTS FechaResolucion TIMESTAMP(0) NULL;

/* Las columnas admiten NULL a propósito: los reemplazos que YA estaban
   resueltos antes de este cambio no tienen observación y no hay de dónde
   sacarla. La obligatoriedad se aplica de aquí en adelante, en la API. */

/* ============================================================================
   FIN. Verificación:
     SELECT Id, NumeroHoja, Estado, ResueltoPor,
            to_char((FechaResolucion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica',
                    'YYYY-MM-DD HH24:MI') AS resuelto,
            ObservacionResolucion
       FROM dbo.HojaConsumo
      WHERE EsReemplazo = TRUE
      ORDER BY Id DESC LIMIT 20;
   ============================================================================ */
SELECT COUNT(*) AS reemplazos_resueltos_sin_observacion
  FROM dbo.HojaConsumo
 WHERE EsReemplazo = TRUE AND Estado = 'Resuelto' AND ObservacionResolucion IS NULL;
