/* ============================================================
   25_Provincia.sql
   Catálogo de provincias de Costa Rica.

   Es de solo lectura para el usuario: no hay pantalla de mantenimiento
   ni endpoints de alta, edición o borrado. Son siete y no cambian.

   Reemplaza tres copias del mismo listado que había sueltas: el CHECK
   de cat.Hospital, el arreglo PROVINCIAS de la API y el del frontend.

   cat.Hospital pasa de guardar el nombre a guardar ProvinciaId. La
   migración ABORTA si algún hospital tiene una provincia que no calza,
   en vez de perder el dato en silencio.

   Aplicar a mano con psql, antes del push.
   ============================================================ */

BEGIN;

CREATE TABLE IF NOT EXISTS cat.Provincia (
    Id     SMALLINT     PRIMARY KEY,
    Nombre VARCHAR(40)  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS UX_Provincia_Nombre ON cat.Provincia (Nombre);

INSERT INTO cat.Provincia (Id, Nombre) VALUES
  (1, 'San José'),
  (2, 'Alajuela'),
  (3, 'Cartago'),
  (4, 'Heredia'),
  (5, 'Guanacaste'),
  (6, 'Puntarenas'),
  (7, 'Limón')
ON CONFLICT (Id) DO UPDATE SET Nombre = EXCLUDED.Nombre;

/* ---------- cat.Hospital pasa a referenciar el catálogo ---------- */

ALTER TABLE cat.Hospital ADD COLUMN IF NOT EXISTS ProvinciaId SMALLINT NULL;

ALTER TABLE cat.Hospital DROP CONSTRAINT IF EXISTS FK_Hospital_Provincia;
ALTER TABLE cat.Hospital ADD  CONSTRAINT FK_Hospital_Provincia
      FOREIGN KEY (ProvinciaId) REFERENCES cat.Provincia(Id);

/* La columna de texto ya no manda, así que se suelta el CHECK antes de
   migrar: si no, el UPDATE chocaría con él. */
ALTER TABLE cat.Hospital DROP CONSTRAINT IF EXISTS CK_Hospital_Provincia;

/* Migración del texto al Id. Se compara sin tildes y sin mayúsculas por si
   algún registro quedó escrito distinto.

   Se usa translate() y no unaccent(): esa función viene de una extensión que
   puede no estar instalada y cuya creación pide permisos que la cuenta de la
   aplicación no necesariamente tiene. Con siete nombres fijos, translate()
   alcanza de sobra. */
UPDATE cat.Hospital h
   SET ProvinciaId = p.Id
  FROM cat.Provincia p
 WHERE h.ProvinciaId IS NULL
   AND h.Provincia IS NOT NULL
   AND lower(translate(trim(h.Provincia), 'áéíóúÁÉÍÓÚüÜ', 'aeiouAEIOUuU'))
     = lower(translate(p.Nombre,          'áéíóúÁÉÍÓÚüÜ', 'aeiouAEIOUuU'));

/* Si algo no calzó, se aborta: perder la provincia de un hospital en
   silencio sería peor que tener que revisar el dato a mano. */
DO $$
DECLARE sueltos int;
BEGIN
  SELECT COUNT(*) INTO sueltos
    FROM cat.Hospital
   WHERE Provincia IS NOT NULL AND trim(Provincia) <> '' AND ProvinciaId IS NULL;
  IF sueltos > 0 THEN
    RAISE EXCEPTION 'Hay % hospital(es) con una provincia que no calza con cat.Provincia. Se aborta para no perder el dato.', sueltos;
  END IF;
END $$;

/* Ya migrado, la columna de texto se va: dos fuentes de verdad del mismo
   dato es justo lo que hay que evitar. */
ALTER TABLE cat.Hospital DROP COLUMN IF EXISTS Provincia;

COMMIT;
