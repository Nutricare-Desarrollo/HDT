/* ============================================================================
   HDT · Hojas de Consumo — Vaciar el catálogo de Régimen
   ----------------------------------------------------------------------------
   Borra los valores de cat.Regimen. NO toca ninguna hoja ya creada: la hoja
   guarda el régimen como TEXTO en dbo.HojaConsumo.Regimen, no el Id del
   catálogo, así que las hojas viejas siguen mostrando lo que tenían.

   Después de esto la lista desplegable arranca en «— Seleccione —» y Bodega
   agrega los regímenes buenos desde la app, con el botón + del campo.
   ============================================================================ */

-- Ver qué hay (opcional).
SELECT Id, Nombre, CreadoPor FROM cat.Regimen ORDER BY Nombre;

-- Vaciar.
DELETE FROM cat.Regimen;

-- Verificar.
SELECT COUNT(*) AS regimenes FROM cat.Regimen;
