/* ============================================================================
   HDT · Hojas de Consumo — Envíos al anaquel: Lote, Estado y N° TR  (Fase 8)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 01..11:  psql "<cadena-de-conexion>" -f 12_EnvioLoteEstadoTR.sql
   ----------------------------------------------------------------------------
   Agrega a los envíos del anaquel (dbo.PedidoPendienteEnvio):
     - Lote     : lote del producto enviado (obligatorio a nivel de aplicación).
     - Estado   : 'Pendiente' (línea nueva, editable) | 'Procesado' | 'Error'.
     - NumeroTR : N° de TR generado en Dynamics. Lo llena OTRO proceso; el
                  usuario NUNCA lo edita. Queda en blanco para líneas nuevas.

   Idempotente y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

ALTER TABLE dbo.PedidoPendienteEnvio ADD COLUMN IF NOT EXISTS Lote     VARCHAR(80) NULL;
ALTER TABLE dbo.PedidoPendienteEnvio ADD COLUMN IF NOT EXISTS Estado   VARCHAR(20) NOT NULL DEFAULT 'Pendiente';
ALTER TABLE dbo.PedidoPendienteEnvio ADD COLUMN IF NOT EXISTS NumeroTR VARCHAR(60) NULL;

-- CHECK del Estado (se agrega solo si no existe, para poder re-ejecutar).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ppenvio_estado') THEN
    ALTER TABLE dbo.PedidoPendienteEnvio
      ADD CONSTRAINT CK_PPEnvio_Estado CHECK (Estado IN ('Pendiente','Procesado','Error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS IX_PPEnvio_Estado ON dbo.PedidoPendienteEnvio (Estado);

/* ============================================================================
   FIN. Verificación rápida (opcional):
     SELECT Id, PedidoPendienteId, CantidadEnviada, Lote, Estado, NumeroTR, Usuario
       FROM dbo.PedidoPendienteEnvio ORDER BY Id DESC;
   ============================================================================ */
