/* ============================================================
   34_ValidacionFirma.sql
   Qué fotos vio la validación cuando dio su veredicto.

   EL PROBLEMA
   Un veredicto es una afirmación sobre UN conjunto de fotos.
   Si después alguien agrega otra foto, o borra la que traía la
   etiqueta legible, el veredicto guardado deja de hablar de lo
   que hay en pantalla — pero la tabla no tenía forma de notarlo.
   La pantalla seguía mostrando «Correcta» y ofreciendo el
   comparador sobre fotos distintas de las que se compararon.

   LA FIRMA
   Se guarda el md5 de los Id de las fotos que entraron en la
   comparación, en orden. Comparar esa firma con la de las fotos
   que hay AHORA contesta la pregunta de una vez y para los tres
   casos: se agregó una, se borró una, o se cambiaron.

   Un contador no bastaba: borrar una foto y subir otra deja el
   mismo número y no es el mismo conjunto. Y la fecha tampoco:
   una foto agregada es más nueva que el veredicto, pero una
   foto BORRADA no deja ninguna marca de tiempo detrás.

   NULL = veredicto anterior a esta migración. No se sabe qué
   fotos vio, así que no se le reclama nada: se trata como al
   día. Los veredictos nuevos siempre traen firma.

   Idempotente y no destructiva.
   ============================================================ */

ALTER TABLE dbo.SolicitudVerificacion
    ADD COLUMN IF NOT EXISTS FotosFirma VARCHAR(32) NULL;

COMMENT ON COLUMN dbo.SolicitudVerificacion.FotosFirma IS
    'md5 de los Id de dbo.SolicitudFoto que se compararon, en orden. '
    'Si no coincide con la firma de las fotos actuales, el veredicto '
    'quedó desactualizado. NULL = veredicto anterior a la migración 34.';
