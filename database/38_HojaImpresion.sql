/* ============================================================================
   HDT · Hojas de Consumo — Registro de impresiones  (Fase 10)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 37:  psql "<cadena-de-conexion>" -f 38_HojaImpresion.sql
   ----------------------------------------------------------------------------
   PARA QUÉ. Hasta ahora imprimir no dejaba rastro de ninguna clase: el
   imprimible se arma en el navegador y no llama a la API, así que nadie sabía
   si una hoja se imprimió, cuándo ni cuántas veces. Con la portátil del
   hospital eso pasa de curiosidad a dato de trabajo: la compañera necesita ver
   cuáles de la cola ya salieron.

   POR QUÉ UNA TABLA Y NO LA BITÁCORA. La fila de la bitácora se escribe igual
   —el envoltorio la agrega sola— y ahí queda el rastro legible. Pero la
   bitácora no guarda el Id de la hoja: su columna Ruta guarda el PATRÓN de la
   ruta ('hojas/{id}/impresa', sin el número) y Registro guarda el N° de hoja
   como texto, que puede venir vacío. Cruzar el listado contra eso fallaría
   justo en las hojas sin N°. Esta tabla existe para poder contar y ordenar por
   hoja sin adivinar.

   POR QUÉ NO UNA COLUMNA EN HojaConsumo. Porque una columna guarda la última
   impresión y pierde las anteriores. Acá una fila por impresión: el conteo
   sale gratis y una reimpresión no borra la primera.

   ON DELETE CASCADE, igual que las fotos de la hoja sellada: si se elimina una
   hoja pendiente, sus impresiones se van con ella. El rastro de que existió
   queda en la bitácora, que no tiene llave foránea a propósito.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS dbo;

CREATE TABLE IF NOT EXISTS dbo.HojaImpresion (
    Id            BIGSERIAL PRIMARY KEY,
    IdHojaConsumo INTEGER      NOT NULL
                  REFERENCES dbo.HojaConsumo(Id) ON DELETE CASCADE,
    ConSima       BOOLEAN      NOT NULL DEFAULT FALSE,  -- cuál de los dos imprimibles
    Usuario       VARCHAR(200) NULL,                    -- nombre visible de quien imprimió
    UsuarioEmail  VARCHAR(200) NULL,
    Rol           VARCHAR(30)  NULL,                    -- rol con el que imprimió
    FechaHora     TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc')
);

/* El listado pregunta «cuántas veces y cuándo fue la última» por hoja. */
CREATE INDEX IF NOT EXISTS IX_HojaImpresion_Hoja
    ON dbo.HojaImpresion (IdHojaConsumo, Id);

/* ============================================================================
   FIN. Verificación:
     SELECT i.IdHojaConsumo, h.NumeroHoja, COUNT(*) AS veces,
            to_char((MAX(i.FechaHora) AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica',
                    'YYYY-MM-DD HH24:MI') AS ultima
       FROM dbo.HojaImpresion i
       JOIN dbo.HojaConsumo h ON h.Id = i.IdHojaConsumo
      GROUP BY i.IdHojaConsumo, h.NumeroHoja
      ORDER BY MAX(i.FechaHora) DESC
      LIMIT 20;
   ============================================================================ */
SELECT COUNT(*) AS impresiones FROM dbo.HojaImpresion;
