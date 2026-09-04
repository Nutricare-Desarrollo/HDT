/* ============================================================
   31_EquipoActivo.sql
   Una bandeja se puede desactivar en vez de borrarse.

   Pedido de la demo con Bodega: poder sacar del catálogo una
   bandeja que ya no se usa. Se borra solo si NUNCA se usó; si
   aparece en alguna Solicitud de Equipo o como N° de equipo en
   alguna hoja de consumo, se desactiva — así ningún registro
   histórico queda apuntando a una bandeja que dejó de existir.

   OJO: Activo NO es lo mismo que Completo, que ya existe desde la
   21. Completo dice si la bandeja está completa o le falta algo
   (y por eso lleva MotivoIncompleto). Activo dice si la bandeja
   sigue en uso en el catálogo. Una bandeja puede estar activa e
   incompleta, o completa y desactivada.

   Arranca en TRUE para todas: lo que hay hoy en el catálogo está
   en uso.

   IDEMPOTENTE: ADD COLUMN IF NOT EXISTS.

   Aplicar a mano con psql, antes del push.
   ============================================================ */

BEGIN;

ALTER TABLE cat.Equipo
      ADD COLUMN IF NOT EXISTS Activo BOOLEAN NOT NULL DEFAULT TRUE;

/* El listado del mantenimiento oculta las desactivadas por defecto, así que
   el filtro es por Activo y conviene el índice. */
CREATE INDEX IF NOT EXISTS IX_Equipo_Activo ON cat.Equipo (Activo);

COMMIT;
