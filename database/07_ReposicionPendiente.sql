/* ============================================================================
   HDT · Hojas de Consumo — Estado 'Pendiente reposición' (Fase 3)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 01..06:  node run-db.js  (o psql -f 07_ReposicionPendiente.sql)
   ----------------------------------------------------------------------------
   Agrega el estado 'Pendiente reposición': una hoja creada (manual o por foto)
   que se GUARDA sin ingresar la reposición todavía. Queda en su propia bandeja
   hasta que alguien completa la reposición y la ENVÍA (pasa a 'Enviado').

   Idempotente: seguro de re-ejecutar.
   ============================================================================ */

-- 'Pendiente reposición' tiene 21 caracteres: se amplía la columna (era VARCHAR(20)).
ALTER TABLE dbo.HojaConsumo ALTER COLUMN Estado TYPE VARCHAR(30);

-- Se reemplaza el CHECK para admitir el nuevo estado.
ALTER TABLE dbo.HojaConsumo DROP CONSTRAINT IF EXISTS CK_HojaConsumo_Estado;
ALTER TABLE dbo.HojaConsumo ADD CONSTRAINT CK_HojaConsumo_Estado
    CHECK (Estado IN ('Pendiente reposición','Enviado','En revisión','Creando TR','Finalizada','Error'));
