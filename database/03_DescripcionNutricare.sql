/* ============================================================================
   Migración — Parte 2: catálogo de productos Nutricare
   Agrega la columna DescripcionNutricare al detalle de la hoja de consumo.
   Guarda la descripción oficial del catálogo (buscada por Codigo), además de
   la descripción que lee el OCR (columna Descripcion).

   Idempotente: se puede correr varias veces sin error.
   ============================================================================ */

ALTER TABLE dbo.HojaConsumoDetalle
    ADD COLUMN IF NOT EXISTS DescripcionNutricare VARCHAR(400) NULL;

/* Verificación opcional:
     SELECT column_name FROM information_schema.columns
     WHERE table_schema='dbo' AND table_name='hojaconsumodetalle'
     ORDER BY ordinal_position;
*/
