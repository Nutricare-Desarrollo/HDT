/* ============================================================================
   HDT · Hojas de Consumo — Limpieza segura del catálogo de Cirujanos
   Ejecutar contra la base hdt. Reemplaza a 13b_LimpiarCirujanos.sql.
   ----------------------------------------------------------------------------
   NO volver a ejecutar 13_Cirujano.sql: ese script siembra el catálogo desde
   dbo.HojaConsumo y dbo.Cirugia, que es lo que lo ensució. Como el campo
   Cirujano conserva el texto del OCR aunque no esté registrado, las hojas
   acumularon nombres mal leídos desde entonces: re-sembrar mete más basura
   que la original.

   Diferencia con 13b: acá NADA toca las filas que un usuario ya corrigió
   (ActualizadoPor IS NOT NULL) ni las que se agregaron desde la app.

   Borrar o desactivar NO modifica ninguna hoja ya creada: la hoja guarda el
   nombre como texto, no el Id del cirujano.
   ============================================================================ */

-- ─────────────────────────────────────────────────────────────────────────────
-- PASO 1 · Revisar. Corré SOLO esto primero.
-- La columna "usos" dice en cuántas hojas aparece ese nombre: los que tienen 0
-- son candidatos claros a salir; uno con muchos usos probablemente sea real.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT  c.Id,
        c.Nombre,
        c.Activo,
        c.CreadoPor,
        c.ActualizadoPor,
        (SELECT COUNT(*) FROM dbo.HojaConsumo h
          WHERE LOWER(TRIM(h.Cirujano)) = LOWER(TRIM(c.Nombre)))  AS usos_en_hojas,
        (SELECT COUNT(*) FROM dbo.Cirugia g
          WHERE LOWER(TRIM(g.Cirujano)) = LOWER(TRIM(c.Nombre)))  AS usos_en_cirugias
FROM cat.Cirujano c
ORDER BY usos_en_hojas DESC, c.Nombre;


-- ─────────────────────────────────────────────────────────────────────────────
-- OPCIÓN A (recomendada) · DESACTIVAR lo que sembró la migración y nadie tocó.
-- Reversible: sale de la lista desplegable pero la fila queda, y se puede
-- volver a activar desde el botón ＋ marcando "Ver desactivados".
-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE cat.Cirujano
--    SET Activo = FALSE,
--        ActualizadoPor = 'limpieza 13c',
--        FechaActualizacion = (now() at time zone 'utc')
--  WHERE CreadoPor = 'migracion 13_Cirujano.sql'
--    AND ActualizadoPor IS NULL          -- respeta lo ya corregido desde la app
--    AND Activo = TRUE;


-- ─────────────────────────────────────────────────────────────────────────────
-- OPCIÓN B · Igual que A, pero conservando los que sí se usan.
-- Desactiva solo los que no aparecen en ninguna hoja ni cirugía... que en la
-- práctica son pocos, porque la siembra salió justamente de ahí. Sirve más
-- como red de seguridad si querés ir despacio.
-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE cat.Cirujano c
--    SET Activo = FALSE,
--        ActualizadoPor = 'limpieza 13c',
--        FechaActualizacion = (now() at time zone 'utc')
--  WHERE c.CreadoPor = 'migracion 13_Cirujano.sql'
--    AND c.ActualizadoPor IS NULL
--    AND c.Activo = TRUE
--    AND NOT EXISTS (SELECT 1 FROM dbo.HojaConsumo h
--                     WHERE LOWER(TRIM(h.Cirujano)) = LOWER(TRIM(c.Nombre)));


-- ─────────────────────────────────────────────────────────────────────────────
-- OPCIÓN C · Basura evidente del OCR: nombres muy cortos, sin letras, o con
-- números pegados. Revisá el SELECT antes de correr el UPDATE.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT Id, Nombre FROM cat.Cirujano
--  WHERE Activo = TRUE
--    AND (LENGTH(TRIM(Nombre)) < 5
--         OR Nombre !~ '[A-Za-zÁÉÍÓÚÑáéíóúñ]'
--         OR Nombre ~ '[0-9]')
--  ORDER BY Nombre;

-- UPDATE cat.Cirujano
--    SET Activo = FALSE, ActualizadoPor = 'limpieza 13c',
--        FechaActualizacion = (now() at time zone 'utc')
--  WHERE Activo = TRUE
--    AND ActualizadoPor IS NULL
--    AND (LENGTH(TRIM(Nombre)) < 5
--         OR Nombre !~ '[A-Za-zÁÉÍÓÚÑáéíóúñ]'
--         OR Nombre ~ '[0-9]');


-- ─────────────────────────────────────────────────────────────────────────────
-- OPCIÓN D · Borrado físico. Solo si ya revisaste y estás seguro: esto no se
-- deshace. Mismo criterio que A, respetando lo corregido desde la app.
-- ─────────────────────────────────────────────────────────────────────────────
-- DELETE FROM cat.Cirujano
--  WHERE CreadoPor = 'migracion 13_Cirujano.sql'
--    AND ActualizadoPor IS NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- REVERTIR · Si la Opción A o B dejó afuera a alguien que sí servía.
-- ─────────────────────────────────────────────────────────────────────────────
-- UPDATE cat.Cirujano SET Activo = TRUE, ActualizadoPor = 'revertir 13c',
--        FechaActualizacion = (now() at time zone 'utc')
--  WHERE ActualizadoPor = 'limpieza 13c';


-- ─────────────────────────────────────────────────────────────────────────────
-- PASO FINAL · Cómo quedó.
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT Activo, COUNT(*) FROM cat.Cirujano GROUP BY Activo;
-- SELECT Id, Nombre FROM cat.Cirujano WHERE Activo = TRUE ORDER BY Nombre;
