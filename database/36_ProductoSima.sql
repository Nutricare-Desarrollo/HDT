/* ============================================================================
   HDT · Hojas de Consumo — Códigos Sima del catálogo — Migración 36
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar:  psql "<cadena-de-conexion>" -f 36_ProductoSima.sql
   ----------------------------------------------------------------------------
   IDEMPOTENTE y NO destructivo.

   POR QUE ES UNA TABLA NUEVA Y NO COLUMNAS EN EL CATALOGO. El catálogo de
   productos NO vive en esta base: lo sirve un API externo de Power Automate
   -la App Setting PRODUCTOS_API_URL- y la API lo cachea en memoria. No hay
   tabla de productos a la cual agregarle columnas. Así que los seis campos
   Sima viven acá, indexados por el código de producto Nutricare, y se unen al
   catálogo al mostrarlos.

   De paso eso resuelve gratis el «no puede agregar productos»: las filas del
   grid las manda el catálogo, y esta tabla solo guarda la extensión Sima.

   SIN LLAVE FORANEA, a la fuerza: el catálogo es externo y no hay contra qué
   referenciar. La consecuencia hay que tenerla clara: acá pueden quedar filas
   de códigos que el catálogo ya no tiene. No molestan -la unión las deja
   afuera y no se ven- y se pueden listar con la consulta del final.

   LA LLAVE ES EL CODIGO DE PRODUCTO, no el código Sima. Un mismo código Sima
   cubre VARIOS productos: en la carga inicial, QX2-0103 abarca cuatro
   materiales (20108004, 20108005, 20108010, 20108012). Los campos son del
   producto, así que cada uno lleva su copia y se edita producto por producto.

   PRECIO EXACTO. NUMERIC(18,6) y no NUMERIC(18,2): el precio de origen viene
   con doce decimales (234.468571428571). Se guarda tal cual y la pantalla
   muestra dos. Redondear al guardar perdería el número original, que si es un
   unitario calculado importa al multiplicarlo por cantidades.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS cat;

CREATE TABLE IF NOT EXISTS cat.ProductoSima (
    -- Código de producto Nutricare. Es la llave: un producto, una fila.
    ProductoCodigo    VARCHAR(60) PRIMARY KEY,
    -- Los seis campos, TODOS opcionales. Que estén en NULL es un estado
    -- normal, no un error: el catálogo tiene productos sin equivalente Sima.
    CodigoSima        VARCHAR(60)   NULL,
    DescripcionSima   VARCHAR(600)  NULL,   -- las de origen llegan a 262
    LineaSima         VARCHAR(30)   NULL,
    PartidaSima       VARCHAR(300)  NULL,
    RenglonSima       VARCHAR(300)  NULL,
    PrecioSima        NUMERIC(18,6) NULL,
    ModificadoPor     VARCHAR(200)  NULL,
    FechaModificacion TIMESTAMP(0) NOT NULL DEFAULT (now() at time zone 'utc')
);

-- El grid filtra y ordena por el código Sima; muchos productos no tienen, así
-- que el índice va parcial y solo indexa las filas que sirven.
CREATE INDEX IF NOT EXISTS IX_ProductoSima_Codigo
    ON cat.ProductoSima (CodigoSima) WHERE CodigoSima IS NOT NULL;

/* ============================================================================
   FIN. Verificación:

     SELECT COUNT(*) AS filas,
            COUNT(CodigoSima)  AS con_codigo,
            COUNT(PrecioSima)  AS con_precio
       FROM cat.ProductoSima;

   Filas cuyo producto ya no está en el catálogo -no se ven en la pantalla,
   porque la unión las deja afuera-. No se pueden detectar con SQL: el catálogo
   es externo. Se ven comparando esta lista contra GET /api/productos:

     SELECT ProductoCodigo, CodigoSima FROM cat.ProductoSima ORDER BY ProductoCodigo;
   ============================================================================ */
