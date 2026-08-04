/* ============================================================================
   HDT · Hojas de Consumo — Reemplazos / Correcciones (Fase 4)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 01..07:  node run-db.js  (o psql -f 08_ReemplazoCorreccion.sql)
   ----------------------------------------------------------------------------
   Una hoja creada A PARTIR DE otra (corrección/reemplazo): guarda la referencia
   a la original (HojaOrigenId) y se marca con EsReemplazo. Estas NO se envían a
   Dynamics como TR; Bodega las resuelve en su bandeja con un botón que las pasa
   al estado 'Resuelto'.

   Idempotente: seguro de re-ejecutar.
   ============================================================================ */

ALTER TABLE dbo.HojaConsumo ADD COLUMN IF NOT EXISTS HojaOrigenId INT NULL;
ALTER TABLE dbo.HojaConsumo ADD COLUMN IF NOT EXISTS EsReemplazo BOOLEAN NOT NULL DEFAULT FALSE;

-- FK a la hoja original (autoreferencia). Se agrega solo si no existe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_hojaconsumo_origen') THEN
    ALTER TABLE dbo.HojaConsumo
      ADD CONSTRAINT FK_HojaConsumo_Origen FOREIGN KEY (HojaOrigenId) REFERENCES dbo.HojaConsumo(Id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS IX_HojaConsumo_EsReemplazo ON dbo.HojaConsumo (EsReemplazo);

-- Estado 'Resuelto' para los reemplazos que Bodega cierra.
ALTER TABLE dbo.HojaConsumo DROP CONSTRAINT IF EXISTS CK_HojaConsumo_Estado;
ALTER TABLE dbo.HojaConsumo ADD CONSTRAINT CK_HojaConsumo_Estado
    CHECK (Estado IN ('Pendiente reposición','Enviado','En revisión','Creando TR','Finalizada','Error','Resuelto'));
