/* ============================================================
   28_SolicitudEnviadoHospital.sql
   El estado «Enviado a Hospital» entra al catálogo de estados.

   Bodega cierra el alisto y el equipo sale. Es la transición que la
   Tabla 6 del documento de requerimientos llama «Equipo Alistado».

   El estado es el único cambio que necesita la base: la fecha del
   despacho sale de FechaActualizacion y quién lo hizo de
   ActualizadoPor, que ya existen desde la 24. No hace falta columna
   nueva.

   OJO: Estado tiene un CHECK constraint, así que el estado nuevo NO
   entra solo por ser un VARCHAR. Sin esta migración, «Enviar a
   hospital» falla con:
     new row for relation "solicitudequipo" violates check constraint
     "ck_solicitudequipo_estado"
   Cada migración que agrega un estado vuelve a crear el constraint con
   la lista completa — la 24 lo creó con dos, la 27 lo dejó en tres.

   Idempotente: DROP IF EXISTS y se vuelve a crear.

   Aplicar a mano con psql, antes del push.
   ============================================================ */

BEGIN;

ALTER TABLE dbo.SolicitudEquipo DROP CONSTRAINT IF EXISTS CK_SolicitudEquipo_Estado;
ALTER TABLE dbo.SolicitudEquipo ADD  CONSTRAINT CK_SolicitudEquipo_Estado
      CHECK (Estado IN ('Borrador','Enviada','En Preparación','Enviado a Hospital'));

COMMIT;
