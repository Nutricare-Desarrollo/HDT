/* ============================================================
   29_NotificacionDevuelta.sql
   El evento «Devuelta al hospital» entra a las notificaciones.

   Bodega puede regresar una solicitud al hospital para que le haga
   cambios: la solicitud vuelve a Borrador y el alisto marcado se
   descarta. Es el caso que la sección 5.4 del documento de
   requerimientos dejaba por definir.

   El aviso necesita su propia lista de cuentas: quien quiere saber
   que un equipo se alistó no es necesariamente quien quiere saber
   que una solicitud se devolvió.

   Ojo con el CHECK: CK_Notificacion_AlMenosUno enumera las columnas
   de evento, así que hay que volver a crearlo con la nueva. Si no,
   una cuenta suscrita SOLO a «Devuelta» sería rechazada al guardar.

   No hace falta tocar el estado: 'Borrador' ya está en el catálogo
   desde la 24.

   Idempotente: ADD COLUMN IF NOT EXISTS y DROP/ADD del constraint.

   Aplicar a mano con psql, antes del push.
   ============================================================ */

BEGIN;

ALTER TABLE cat.Notificacion
      ADD COLUMN IF NOT EXISTS Devuelta BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE cat.Notificacion DROP CONSTRAINT IF EXISTS CK_Notificacion_AlMenosUno;
ALTER TABLE cat.Notificacion ADD  CONSTRAINT CK_Notificacion_AlMenosUno
      CHECK (Solicitud OR Alistado OR Devolucion OR Liberado OR Devuelta);

COMMIT;
