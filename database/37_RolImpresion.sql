/* ============================================================================
   HDT · Hojas de Consumo — Rol 'Impresión'  (Fase 10)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 01..36:  psql "<cadena-de-conexion>" -f 37_RolImpresion.sql
   ----------------------------------------------------------------------------
   PARA QUÉ. En el hospital se instala una portátil para imprimir las hojas de
   consumo. Entrar con el correo de cada compañera pide el doble factor cada
   vez, así que la máquina entra con UNA cuenta compartida. Una cuenta
   compartida con rol Hospital vería —y podría editar y borrar— todo lo que ve
   Hospital, en una máquina que queda abierta en un pasillo. Este rol existe
   para que esa cuenta pueda hacer EXACTAMENTE una cosa: abrir una hoja de
   consumo e imprimirla.

   QUÉ NO HACE ESTE SCRIPT. No le asigna el rol a nadie. La cuenta del kiosco
   la crea IT en Entra ID, entra una vez a la aplicación —ahí queda registrada
   en dbo.UsuarioRol como 'Hospital', que es el rol por defecto— y después se
   le pone este rol con 37b_UsuarioKiosco.sql o desde «Usuarios y roles».

   OJO CON EL ORDEN: la fila del rol tiene que existir ANTES de desplegar el
   código. La API valida el rol contra cat.Rol al asignarlo, y el envoltorio
   que limita al rol compara por nombre exacto: sin esta fila, nadie puede
   quedar en 'Impresión' y el candado no tiene a quién aplicarse.

   'Impresión' son 9 caracteres y cat.Rol.Nombre es VARCHAR(30): entra.

   IDEMPOTENTE y NO destructivo: seguro de re-ejecutar.
   ============================================================================ */

INSERT INTO cat.Rol (Nombre) VALUES ('Impresión')
    ON CONFLICT (Nombre) DO NOTHING;

/* ============================================================================
   Verificación: deben salir los cuatro roles.
   ============================================================================ */
SELECT Id, Nombre FROM cat.Rol ORDER BY Id;
