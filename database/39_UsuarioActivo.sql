/* ============================================================================
   HDT · RIC — Un usuario se puede inactivar  (Fase 11)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 38:  psql "<cadena-de-conexion>" -f 39_UsuarioActivo.sql
   ----------------------------------------------------------------------------
   PARA QUÉ. Alguien que ya no debe usar RIC —cambió de puesto, se fue, entró
   por curiosidad— se inactiva desde «Usuarios y roles» y deja de poder hacer
   cualquier cosa en la aplicación.

   NO SE BORRA LA FILA, se marca. Igual que cat.Equipo (31) y cat.Hospital: si
   se borrara, se perdería el rol que tenía y su último acceso, y reactivarlo
   sería volver a empezar. Las hojas de esa persona no se ven afectadas de
   ninguna manera: CreadoPor guarda el NOMBRE como texto, no un id, así que el
   historial sigue diciendo quién las hizo.

   ARRANCA EN TRUE PARA TODOS, y esto importa: si arrancara en FALSE, aplicar
   esta migración bloquearía a la empresa entera. Lo que hay hoy en
   dbo.UsuarioRol es gente que usa la aplicación.

   ⚠️ EL RESCATE, que es lo que alguien va a venir a buscar acá en un apuro.
   Si te inactivaste a vos mismo, o quedó inactivo el único Administrador, y
   por lo tanto ya nadie puede reactivar a nadie desde la pantalla:

       UPDATE dbo.UsuarioRol SET Activo = TRUE
        WHERE Email = 'alguien@nutricare.co.cr';

   Y para ver cómo está el mundo:

       SELECT u.Email, r.Nombre AS Rol, u.Activo, u.UltimoAcceso
         FROM dbo.UsuarioRol u JOIN cat.Rol r ON r.Id = u.RolId
        ORDER BY u.Activo, u.Email;

   La API tiene tres candados para que ese apuro no ocurra —no se puede
   inactivar un correo protegido, ni a uno mismo, ni al último Administrador
   activo—, pero la línea de arriba existe por si algún día fallan.

   LO QUE ESTA MIGRACIÓN NO CAMBIA. El alta sigue siendo automática: quien
   abra la aplicación por primera vez sigue entrando como 'Hospital'. Se
   decidió a propósito dejarlo así; Activo es para bloquear a quien haga falta,
   no para repartir invitaciones. Si algún día se quiere alta explícita, el
   cambio es que ensureUserRole inserte con Activo=FALSE — y ahí hay que
   avisarle a la gente antes, porque el día del despliegue nadie nuevo entra.

   IDEMPOTENTE: ADD COLUMN IF NOT EXISTS.

   Aplicar a mano con psql, antes del push.
   ============================================================================ */

BEGIN;

ALTER TABLE dbo.UsuarioRol
      ADD COLUMN IF NOT EXISTS Activo BOOLEAN NOT NULL DEFAULT TRUE;

/* El listado de «Usuarios y roles» esconde los inactivos por defecto, así que
   filtra por Activo. La tabla es chica —una fila por persona que entró—, pero
   el índice no estorba y deja la intención escrita. */
CREATE INDEX IF NOT EXISTS IX_UsuarioRol_Activo ON dbo.UsuarioRol (Activo);

COMMIT;

/* ============================================================================
   FIN. Verificación: todos tienen que quedar activos.
   ============================================================================ */
SELECT COUNT(*) FILTER (WHERE Activo)     AS activos,
       COUNT(*) FILTER (WHERE NOT Activo) AS inactivos
  FROM dbo.UsuarioRol;
