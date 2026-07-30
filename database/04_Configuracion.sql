/* ============================================================================
   HDT · Hojas de Consumo — Configuración (ubicaciones Origen/Destino)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar:  psql "<cadena-de-conexion>" -f 04_Configuracion.sql
   ----------------------------------------------------------------------------
   IDEMPOTENTE y NO destructivo: se puede re-ejecutar sin borrar datos.

   Guarda, por área (Anaquel, Nutricare, Facturación), una ubicación de
   Origen y una de Destino. La pantalla "Configuración" (solo Bodega y
   Administrador) lee y escribe esta tabla.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS dbo;

CREATE TABLE IF NOT EXISTS dbo.Configuracion (
    Area              VARCHAR(40) PRIMARY KEY
                      CONSTRAINT CK_Configuracion_Area
                      CHECK (Area IN ('anaquel','nutricare','facturacion')),
    Origen            VARCHAR(100) NULL,
    Destino           VARCHAR(100) NULL,
    ModificadoPor     VARCHAR(200) NULL,
    FechaModificacion TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc')
);

/* Semilla de las tres áreas (sin valores). Así el GET siempre devuelve las
   tres filas y la UI muestra los campos vacíos hasta que Bodega los complete. */
INSERT INTO dbo.Configuracion (Area) VALUES ('anaquel'), ('nutricare'), ('facturacion')
    ON CONFLICT (Area) DO NOTHING;

/* ============================================================================
   FIN. Verificación rápida (opcional):
     SELECT * FROM dbo.Configuracion ORDER BY Area;
   ============================================================================ */
