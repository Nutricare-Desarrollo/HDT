/* ============================================================================
   40 — La hora de la cirugía siempre con dos dígitos
   ----------------------------------------------------------------------------
   dbo.Cirugia.HoraInicio es VARCHAR(8) y el calendario lo ordena como texto.
   Comparado como texto, '8:30' va DESPUÉS de '18:30' (el carácter '8' es mayor
   que el '1'), así que la cirugía de las 8:30 de la mañana aparecía de última
   en el día. No estaba mal el orden: estaban mal guardadas las horas.

   Entraron sin el cero de adelante por POST /api/cirugias/importar, que hasta
   ahora guardaba lo que viniera. La API ya normaliza al escribir; este script
   arregla lo que quedó de antes.

   Idempotente: solo toca las filas que empiezan con un dígito y dos puntos, y
   correrlo dos veces no cambia nada la segunda.
   ============================================================================ */

BEGIN;

-- Cuántas hay antes (queda en el log del psql)
SELECT COUNT(*) AS horas_sin_cero
FROM dbo.Cirugia
WHERE HoraInicio ~ '^[0-9]:' OR HoraFin ~ '^[0-9]:';

UPDATE dbo.Cirugia
   SET HoraInicio = '0' || HoraInicio
 WHERE HoraInicio ~ '^[0-9]:';

UPDATE dbo.Cirugia
   SET HoraFin = '0' || HoraFin
 WHERE HoraFin ~ '^[0-9]:';

-- Verificación: esto tiene que dar 0
SELECT COUNT(*) AS quedan_sin_cero
FROM dbo.Cirugia
WHERE HoraInicio ~ '^[0-9]:' OR HoraFin ~ '^[0-9]:';

COMMIT;
