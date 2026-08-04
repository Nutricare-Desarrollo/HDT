/* ============================================================================
   HDT · Hojas de Consumo — Estado 'Pendiente reposición' (Fase 3)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 01..06:  node run-db.js  (o psql -f 07_ReposicionPendiente.sql)
   ----------------------------------------------------------------------------
   Agrega el estado 'Pendiente reposición': una hoja creada (manual o por foto)
   que se GUARDA sin ingresar la reposición todavía. Queda en su propia bandeja
   hasta que alguien completa la reposición y la ENVÍA (pasa a 'Enviado').

   Nota: la columna Estado la usa la vista dbo.vHojaConsumo, y PostgreSQL no deja
   cambiar el tipo de una columna referenciada por una vista. Por eso se suelta la
   vista, se amplía la columna y se recrea idéntica.

   Idempotente: seguro de re-ejecutar.
   ============================================================================ */

-- 1) Soltar la vista que referencia la columna Estado.
DROP VIEW IF EXISTS dbo.vHojaConsumo;

-- 2) 'Pendiente reposición' tiene 21 caracteres: se amplía la columna (era VARCHAR(20)).
ALTER TABLE dbo.HojaConsumo ALTER COLUMN Estado TYPE VARCHAR(30);

-- 3) Reemplazar el CHECK para admitir el nuevo estado.
--    Se incluye también 'Resuelto' (del 08) para que re-ejecutar sea seguro aunque
--    ya existan reemplazos resueltos: el 07 corre antes del 08 y no debe chocar.
ALTER TABLE dbo.HojaConsumo DROP CONSTRAINT IF EXISTS CK_HojaConsumo_Estado;
ALTER TABLE dbo.HojaConsumo ADD CONSTRAINT CK_HojaConsumo_Estado
    CHECK (Estado IN ('Pendiente reposición','Enviado','En revisión','Creando TR','Finalizada','Error','Resuelto'));

-- 4) Recrear la vista idéntica a la de 01_Esquema_HojaConsumo.sql.
CREATE OR REPLACE VIEW dbo.vHojaConsumo AS
SELECT h.Id,
       h.NumeroHoja,
       h.NumeroDocumento,
       h.Regimen,
       h.Paciente,
       h.Cirujano,
       h.Instrumentista,
       h.Diagnostico,
       h.Estado,
       h.CreadoPor,
       h.CreadoPorEmail,
       h.FechaCreacion,
       (SELECT COUNT(*) FROM dbo.HojaConsumoDetalle d WHERE d.HojaConsumoId = h.Id) AS CantidadLineas
FROM dbo.HojaConsumo h;
