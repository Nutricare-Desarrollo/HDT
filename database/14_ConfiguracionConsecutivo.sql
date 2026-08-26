/* ============================================================================
   HDT · Hojas de Consumo — Configuración: Prefijo y Consecutivo
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar:  psql "<cadena-de-conexion>" -f 14_ConfiguracionConsecutivo.sql
   ----------------------------------------------------------------------------
   IDEMPOTENTE y NO destructivo: se puede re-ejecutar sin borrar datos.

   Guarda un único par Prefijo/Consecutivo para el nuevo panel de la pantalla
   "Configuración" (solo Bodega y Administrador).
     · Prefijo     -> alfanumérico (letras y números, sin espacios ni símbolos).
     · Consecutivo -> solo dígitos.
   Tabla de una sola fila: el CHECK sobre Id la mantiene así.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS dbo;

CREATE TABLE IF NOT EXISTS dbo.ConfiguracionConsecutivo (
    Id                SMALLINT PRIMARY KEY DEFAULT 1
                      CONSTRAINT CK_ConfigConsecutivo_Id CHECK (Id = 1),
    Prefijo           VARCHAR(20) NULL
                      CONSTRAINT CK_ConfigConsecutivo_Prefijo
                      CHECK (Prefijo IS NULL OR Prefijo ~ '^[A-Za-z0-9]+$'),
    Consecutivo       BIGINT NULL
                      CONSTRAINT CK_ConfigConsecutivo_Valor
                      CHECK (Consecutivo IS NULL OR Consecutivo >= 0),
    ModificadoPor     VARCHAR(200) NULL,
    FechaModificacion TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc')
);

/* Fila única (sin valores). Así el GET siempre responde y la UI muestra los
   campos vacíos hasta que Bodega los complete. */
INSERT INTO dbo.ConfiguracionConsecutivo (Id) VALUES (1)
    ON CONFLICT (Id) DO NOTHING;

/* ============================================================================
   FIN. Verificación rápida (opcional):
     SELECT * FROM dbo.ConfiguracionConsecutivo;
   ============================================================================ */
