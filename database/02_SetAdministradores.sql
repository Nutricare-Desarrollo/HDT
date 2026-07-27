/* ---------------------------------------------------------------------------
   02_SetAdministradores.sql
   Asigna el rol 'Administrador' a los usuarios indicados en la base `hdt`.

   Idempotente y no destructivo:
     - Si el correo no existe en dbo.UsuarioRol, lo crea como Administrador.
     - Si ya existe (p. ej. entró antes como 'Hospital'), le cambia el rol.
   Ejecutar una sola vez. Seguro de re-ejecutar.
   --------------------------------------------------------------------------- */

INSERT INTO dbo.UsuarioRol (Email, Nombre, RolId, UltimoAcceso)
VALUES
  ('desarrollo@nutricare.co.cr', 'Desarrollo NTC',
     (SELECT Id FROM cat.Rol WHERE Nombre = 'Administrador'),
     (now() at time zone 'utc')),
  ('lgomez@nutricare.co.cr', 'Luis Fernando Gomez Ramirez',
     (SELECT Id FROM cat.Rol WHERE Nombre = 'Administrador'),
     (now() at time zone 'utc'))
ON CONFLICT (Email) DO UPDATE
  SET RolId = (SELECT Id FROM cat.Rol WHERE Nombre = 'Administrador');

/* Verificacion: debe listar ambos correos con Rol = Administrador */
SELECT u.Email, u.Nombre, r.Nombre AS Rol
FROM dbo.UsuarioRol u
JOIN cat.Rol r ON r.Id = u.RolId
WHERE u.Email IN ('desarrollo@nutricare.co.cr', 'lgomez@nutricare.co.cr');
