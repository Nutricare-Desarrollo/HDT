/* ============================================================================
   HDT · Hojas de Consumo — Descripción adicional por línea de detalle  (Fase 11)
   Ejecutar DESPUÉS de 01..19:  psql "<cadena-de-conexion>" -f 20_DescripcionAdicional.sql
   ----------------------------------------------------------------------------
   Hospital necesita poder anotar algo sobre el producto que la descripción del
   catálogo no dice (una aclaración de la cirugía, una medida, un detalle del
   material). Es texto libre y OPCIONAL, con tope de 150 caracteres.

   Va en una columna NUEVA y no se reutiliza ninguna de las dos que ya existen,
   porque cada una tiene un dueño distinto:
     · Descripcion           -> lo que el OCR leyó de la foto de la hoja.
     · DescripcionNutricare  -> la del catálogo oficial, derivada del Código.
     · DescripcionAdicional  -> lo que escribe el usuario.  <-- esta
   Mezclarlas haría imposible saber después quién escribió qué.

   El tope de 150 se declara en el tipo, para que la base lo sostenga aunque
   alguien escriba contra la API sin pasar por el formulario. La API igual la
   recorta antes de insertar, así un texto largo no revienta con error 500.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

ALTER TABLE dbo.HojaConsumoDetalle
    ADD COLUMN IF NOT EXISTS DescripcionAdicional VARCHAR(150) NULL;

/* Admite NULL a propósito: es opcional, y las líneas que ya existen no tienen
   nota ni hay de dónde sacarla. NULL y '' significan lo mismo (sin nota). */

/* ============================================================================
   FIN. Verificación:
     SELECT column_name, data_type, character_maximum_length, is_nullable
       FROM information_schema.columns
      WHERE table_schema='dbo' AND table_name='hojaconsumodetalle'
        AND column_name='descripcionadicional';
   ============================================================================ */
SELECT COUNT(*) AS lineas_con_descripcion_adicional
  FROM dbo.HojaConsumoDetalle
 WHERE DescripcionAdicional IS NOT NULL AND btrim(DescripcionAdicional) <> '';
