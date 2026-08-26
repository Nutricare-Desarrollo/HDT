/* ============================================================================
   HDT · Hojas de Consumo — Fotos de la hoja SELLADA  (Fase 9)
   Ejecutar DESPUÉS de 01..17:  psql "<cadena-de-conexion>" -f 18_HojaSellada.sql
   ----------------------------------------------------------------------------
   Guarda las fotos de la hoja de consumo YA SELLADA por el hospital. Son solo
   respaldo: NO se procesan con Document Intelligence. La foto que se lee por
   OCR sigue siendo dbo.HojaConsumo.ImagenBase64; estas son otra cosa.

   Una hoja de consumo puede ocupar varias hojas físicas, así que se admiten
   varias imágenes por registro.

   El contenido va en base64 en la columna TEXT, igual que ImagenBase64. El
   frontend reduce cada imagen a 2000px de lado largo y la recomprime a JPEG
   antes de subirla (una foto de celular pasa de ~5 MB a ~400 KB), así que la
   tabla no crece tanto como parecería.

   ON DELETE CASCADE: si se elimina una hoja pendiente, sus fotos se van con
   ella. A diferencia de la auditoría, acá no hay nada que preservar.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS dbo;

CREATE TABLE IF NOT EXISTS dbo.HojaConsumoSellada (
    Id            BIGSERIAL PRIMARY KEY,
    IdHojaConsumo INTEGER      NOT NULL
                  REFERENCES dbo.HojaConsumo(Id) ON DELETE CASCADE,
    Nombre        VARCHAR(260) NULL,        -- nombre del archivo original
    Tipo          VARCHAR(60)  NOT NULL,    -- MIME; solo imágenes (lo valida la API)
    Bytes         INTEGER      NULL,        -- tamaño aproximado ya decodificado
    Contenido     TEXT         NOT NULL,    -- la imagen en base64 (sin el prefijo data:)
    Usuario       VARCHAR(200) NOT NULL,    -- quién la subió
    UsuarioEmail  VARCHAR(200) NULL,        -- con esto se decide quién puede borrarla
    FechaHora     TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc')
);

-- El listado de una hoja, en orden de subida.
CREATE INDEX IF NOT EXISTS IX_HojaSellada_Hoja
    ON dbo.HojaConsumoSellada (IdHojaConsumo, Id);

/* ============================================================================
   FIN. Verificación (sin traer el base64, que es enorme):
     SELECT Id, IdHojaConsumo, Nombre, Tipo,
            round(Bytes/1024.0) AS kb, Usuario,
            to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica',
                    'YYYY-MM-DD HH24:MI') AS fecha
       FROM dbo.HojaConsumoSellada
      ORDER BY Id DESC LIMIT 20;

   Cuánto pesa la tabla:
     SELECT pg_size_pretty(pg_total_relation_size('dbo.HojaConsumoSellada'));
   ============================================================================ */
SELECT COUNT(*) AS fotos_selladas FROM dbo.HojaConsumoSellada;
