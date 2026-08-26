/* ============================================================================
   HDT · Hojas de Consumo — Auditoría de cambios  (Fase 8)
   Ejecutar DESPUÉS de 01..16:  psql "<cadena-de-conexion>" -f 17_Auditoria.sql
   ----------------------------------------------------------------------------
   Registra QUÉ cambió en una hoja de consumo, CUÁNDO y QUIÉN lo hizo.
   Una fila por campo cambiado, no una por guardado: así se puede filtrar por
   campo y comparar el valor anterior con el nuevo.

   El diff lo hace la API dentro de la transacción del PUT /api/hojas/{id}:
   lee el encabezado y el detalle ANTES del UPDATE y los compara con lo que
   llega. Si la transacción falla, tampoco queda el registro de auditoría.

   NO tiene llave foránea contra dbo.HojaConsumo a propósito: si algún día se
   elimina una hoja, su historial debe sobrevivir — es justamente para eso. Por
   eso también se guarda NumeroHoja desnormalizado, para que la fila siga
   significando algo cuando la hoja ya no exista.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS dbo;

CREATE TABLE IF NOT EXISTS dbo.HojaConsumoAuditoria (
    Id             BIGSERIAL PRIMARY KEY,
    IdHojaConsumo  INTEGER      NOT NULL,
    NumeroHoja     VARCHAR(60)  NULL,        -- desnormalizado (ver nota arriba)
    FechaHora      TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc'),
    Usuario        VARCHAR(200) NOT NULL,    -- nombre o correo de quien guardó
    UsuarioEmail   VARCHAR(200) NULL,
    Rol            VARCHAR(30)  NULL,        -- rol con el que se hizo el cambio
    Seccion        VARCHAR(20)  NOT NULL     -- 'Encabezado' | 'Detalle' | 'Estado'
                   CONSTRAINT CK_Auditoria_Seccion
                   CHECK (Seccion IN ('Encabezado','Detalle','Estado')),
    Linea          INTEGER      NULL,        -- n° de línea, solo en 'Detalle'
    Campo          VARCHAR(60)  NOT NULL,    -- etiqueta legible: 'Cirujano', 'N° Lote'…
    ValorAnterior  TEXT         NULL,        -- NULL = estaba vacío
    ValorNuevo     TEXT         NULL         -- NULL = quedó vacío
);

-- El panel de una hoja: sus cambios, el más reciente primero.
CREATE INDEX IF NOT EXISTS IX_Auditoria_Hoja
    ON dbo.HojaConsumoAuditoria (IdHojaConsumo, Id DESC);

-- La pantalla global: todo, lo más reciente primero.
CREATE INDEX IF NOT EXISTS IX_Auditoria_Fecha
    ON dbo.HojaConsumoAuditoria (FechaHora DESC, Id DESC);

-- Filtro por usuario en la pantalla global.
CREATE INDEX IF NOT EXISTS IX_Auditoria_Usuario
    ON dbo.HojaConsumoAuditoria (UsuarioEmail, Id DESC);

/* ============================================================================
   FIN. Verificación:
     SELECT COUNT(*) AS filas FROM dbo.HojaConsumoAuditoria;

     -- Los últimos 20 cambios, en hora de Costa Rica:
     SELECT to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica',
                    'YYYY-MM-DD HH24:MI') AS fecha,
            Usuario, Rol, NumeroHoja, Seccion, Linea, Campo,
            ValorAnterior, ValorNuevo
       FROM dbo.HojaConsumoAuditoria
      ORDER BY Id DESC
      LIMIT 20;
   ============================================================================ */
SELECT COUNT(*) AS filas_auditoria FROM dbo.HojaConsumoAuditoria;
