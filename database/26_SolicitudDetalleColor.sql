/* ============================================================
   26_SolicitudDetalleColor.sql
   Color de demarcación en el detalle de la solicitud.

   Se guarda igual que Demarcado y Descripcion: como fotografía del
   momento en que se pidió. Si mañana Bodega corrige el color de una
   bandeja en el catálogo, las solicitudes ya enviadas conservan el color
   con el que se pidieron, que es lo que el hospital vio.

   Rellena el color de los borradores que ya existan; las enviadas
   también, porque hasta ahora nadie lo había registrado.

   Aplicar a mano con psql, antes del push.
   ============================================================ */

BEGIN;

ALTER TABLE dbo.SolicitudEquipoDetalle ADD COLUMN IF NOT EXISTS Color VARCHAR(40) NULL;

/* Lo que ya está cargado toma el color actual del catálogo: es la mejor
   aproximación disponible y deja de mostrarse vacío. */
UPDATE dbo.SolicitudEquipoDetalle d
   SET Color = e.Color
  FROM cat.Equipo e
 WHERE d.Color IS NULL
   AND UPPER(TRIM(e.Codigo)) = UPPER(TRIM(d.EquipoCodigo));

COMMIT;
