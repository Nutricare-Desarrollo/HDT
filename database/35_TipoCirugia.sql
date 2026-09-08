/* ============================================================================
   HDT · Hojas de Consumo — Tipo de cirugía (HDT / Transitoria) — Migración 35
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar:  psql "<cadena-de-conexion>" -f 35_TipoCirugia.sql
   ----------------------------------------------------------------------------
   IDEMPOTENTE y NO destructivo: se puede re-ejecutar sin perder datos.

   DOS COSAS, las dos del mismo pedido:

   1. dbo.HojaConsumo.TipoCirugia — 'HDT' o 'Transitoria'.
      Las hojas que YA existen quedan en 'HDT'. No hace falta un UPDATE de
      relleno: en PostgreSQL 11+ un ADD COLUMN con DEFAULT y NOT NULL escribe
      ese valor en las filas existentes de una sola vez, sin reescribir la
      tabla. El UPDATE de abajo queda igual como red por si algún día se corre
      sobre una columna que ya existía sin default.

      El DEFAULT se queda puesto a propósito: quien cree una hoja sin decir el
      tipo -Hospital, que no ve el campo- la crea como HDT sin que la API
      tenga que acordarse.

   2. dbo.Configuracion — una cuarta área, 'transitoria'.
      El panel nuevo de la pantalla Configuración pide Origen y Destino, que es
      EXACTAMENTE lo que esa tabla ya guarda por área. No se crea ninguna tabla
      nueva: se amplía el CHECK y se siembra la fila. A diferencia de las otras
      tres, esta NO es obligatoria en la pantalla: si lo fuera, nadie podría
      guardar la configuración -ni tocar el consecutivo- hasta completarla.
   ============================================================================ */

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · La columna en las hojas
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE dbo.HojaConsumo
  ADD COLUMN IF NOT EXISTS TipoCirugia VARCHAR(20) NOT NULL DEFAULT 'HDT';

-- Red de seguridad: si la columna ya existía sin default, esto la deja en HDT.
UPDATE dbo.HojaConsumo SET TipoCirugia = 'HDT'
 WHERE TipoCirugia IS NULL OR BTRIM(TipoCirugia) = '';

-- Solo los dos valores. Se rehace para que el script sea re-ejecutable.
ALTER TABLE dbo.HojaConsumo DROP CONSTRAINT IF EXISTS CK_HojaConsumo_TipoCirugia;
ALTER TABLE dbo.HojaConsumo ADD CONSTRAINT CK_HojaConsumo_TipoCirugia
    CHECK (TipoCirugia IN ('HDT','Transitoria'));

-- El listado filtra y ordena por esta columna en el rol Bodega.
CREATE INDEX IF NOT EXISTS IX_HojaConsumo_TipoCirugia ON dbo.HojaConsumo (TipoCirugia);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · La cuarta área de configuración
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE dbo.Configuracion DROP CONSTRAINT IF EXISTS CK_Configuracion_Area;
ALTER TABLE dbo.Configuracion ADD CONSTRAINT CK_Configuracion_Area
    CHECK (Area IN ('anaquel','nutricare','facturacion','transitoria'));

INSERT INTO dbo.Configuracion (Area) VALUES ('transitoria')
    ON CONFLICT (Area) DO NOTHING;

/* ============================================================================
   FIN. Verificación:

     SELECT TipoCirugia, COUNT(*) FROM dbo.HojaConsumo GROUP BY TipoCirugia;
     -- todas en HDT la primera vez

     SELECT Area, Origen, Destino FROM dbo.Configuracion ORDER BY Area;
     -- cuatro filas, 'transitoria' con Origen y Destino en NULL
   ============================================================================ */
