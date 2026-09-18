/* ============================================================
   41 — El veredicto «Incompleta»

   EL CASO
   En la demo del 18 de setiembre se validó la NUT-0001338 con
   DOS fotos, contra un catálogo que tiene CINCO de referencia,
   y el sistema contestó «Correcta» con puntaje 0.595.

   Y tenía razón en lo que miró: el texto de esas dos fotos sí
   corresponde a esa bandeja. El problema es que de los otros
   tres recipientes no se sabía nada, y nadie lo dijo. La
   validación medía CONTENIDO y nunca medía COMPLETITUD.

   Una bandeja va completa o no va, así que no alcanza con
   «Correcta» / «Incorrecta» / «No puedo determinarlo»:
   «Incompleta» es un cuarto caso, y se arregla distinto que los
   otros tres —no hay que buscar otra bandeja ni comparar a ojo,
   hay que tomar las fotos que faltan—.

   POR QUÉ UN ESTADO PROPIO Y NO «Incorrecta»
   Porque «Incorrecta» manda a Bodega a revisar si trajo la
   bandeja equivocada, y acá la bandeja puede estar perfecta.
   Mezclarlos hace que el aviso al hospital diga algo que no es.

   Idempotente y no destructiva: solo amplía el CHECK. Ningún
   registro existente cambia.
   ============================================================ */

ALTER TABLE dbo.SolicitudVerificacion DROP CONSTRAINT IF EXISTS CK_SolicitudVerificacion_Resultado;
ALTER TABLE dbo.SolicitudVerificacion ADD  CONSTRAINT CK_SolicitudVerificacion_Resultado
      CHECK (Resultado IN ('Correcta','Incorrecta','Incompleta','No puedo determinarlo'));

COMMENT ON COLUMN dbo.SolicitudVerificacion.Resultado IS
    'Correcta / Incorrecta / Incompleta / No puedo determinarlo. '
    'Incompleta = el contenido de las fotos que se subieron corresponde, '
    'pero se subieron menos fotos que las de referencia del catálogo: '
    'faltan recipientes por fotografiar.';

-- Verificación: tiene que listar los cuatro valores.
SELECT pg_get_constraintdef(oid) AS check_resultado
  FROM pg_constraint
 WHERE conname = 'ck_solicitudverificacion_resultado';
