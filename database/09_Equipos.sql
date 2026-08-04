/* ============================================================================
   HDT · Hojas de Consumo — Catálogo de Equipos (Anexo #2)  (Fase 5)
   Ejecutar DESPUÉS de 01..08:  node run-db.js  (o psql -f 09_Equipos.sql)
   ----------------------------------------------------------------------------
   Catálogo de equipos para validar la columna "N° equipo" de la hoja de consumo.
   Codigo = número demarcado SIN el prefijo NUT- (lo que escribe el usuario).
   Color = color de demarcación del Anexo #2 (para pintar la celda en la hoja).
   Idempotente: seguro de re-ejecutar.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS cat;

CREATE TABLE IF NOT EXISTS cat.Equipo (
    Codigo             VARCHAR(40) PRIMARY KEY,
    Demarcado          VARCHAR(60) NULL,
    Nombre             VARCHAR(300) NULL,
    ActualizadoPor     VARCHAR(200) NULL,
    FechaActualizacion TIMESTAMP(0) NULL
);
-- Color de demarcación (se agrega si la tabla ya existía sin la columna).
ALTER TABLE cat.Equipo ADD COLUMN IF NOT EXISTS Color VARCHAR(40) NULL;

INSERT INTO cat.Equipo (Codigo, Demarcado, Nombre, Color) VALUES
  ('10284', 'NUT-10284', 'Placas tibia Proximal Lateral Derecha # 1', 'Azul'),
  ('10287', 'NUT-10287', 'Placas tibia Proximal Lateral Derecha # 2', 'Negro'),
  ('10285', 'NUT-10285', 'Placas tibia Proximal Lateral Izquierda # 1', 'Rojo'),
  ('10288', 'NUT-10288', 'Placas tibia Proximal Lateral Izquierda # 2', 'Verde'),
  ('10286', 'NUT-10286', 'Placas tibia Proximal Lateral 4.5 /5.0 # 1', 'Morado'),
  ('10289', 'NUT-10289', 'Placas tibia Proximal Lateral 4.5 /5.0 # 2', 'Morado'),
  ('10110', 'NUT-10110', 'Placa de Tibia Proximal Medial # 1', 'Amarillo'),
  ('10125', 'NUT-10125', 'Placa de Tibia Proximal Medial # 2', 'Café'),
  ('10101', 'NUT-10101', 'Canulados 4.0 # 1', 'Verde'),
  ('10102', 'NUT-10102', 'Canulados 4.0 # 2', 'Azul'),
  ('10112', 'NUT-10112', 'Canulados 4.5  # 1', 'Amarillo'),
  ('10111', 'NUT-10111', 'Canulados 4.5  # 2', 'Naranja'),
  ('10142', 'NUT-10142', 'Canulados 7.3 # 1', 'Naranja'),
  ('10141', 'NUT-10141', 'Canulados 7.3 # 2', 'Blanco'),
  ('10113', 'NUT-10113', 'Hcs 2.4/3.0  # 1', 'Rojo'),
  ('10114', 'NUT-10114', 'Hcs 2.4/3.0  # 2', 'Café'),
  ('10104', 'NUT-10104', 'Placas Radio Distal # 1', 'Azul'),
  ('10103', 'NUT-10103', 'Placas Radio Distal # 2', 'Amarillo'),
  ('10146', 'NUT-10146', 'Instrumental Radio Distal # 1', 'Blanco'),
  ('10128', 'NUT-10128', 'Instrumental Radio Distal # 2', 'Verde'),
  ('10108', 'NUT-10108', 'Placas rectas 4.5 /5.0 # 1', 'Amarillo'),
  ('10107', 'NUT-10107', 'Placas rectas 4.5 /5.0 # 2', 'Rojo'),
  ('10131', 'NUT-10131', 'Placas rectas 3.5  # 1', 'Negro Blanco'),
  ('10132', 'NUT-10132', 'Placas rectas 3.5  # 2', 'Amarillo'),
  ('10115', 'NUT-10115', 'Placas Tibia Distal # 1', 'Negro'),
  ('10116', 'NUT-10116', 'Placas Tibia Distal # 2', 'Verde Naranja'),
  ('10118', 'NUT-10118', 'Placas humero proximal # 1', 'Amarillo Negro'),
  ('10117', 'NUT-10117', 'Placas humero proximal # 2', 'Verde'),
  ('10119', 'NUT-10119', 'Placas femur distal # 1', 'Morado'),
  ('10120', 'NUT-10120', 'Placas femur distal # 2', 'Verde'),
  ('10121', 'NUT-10121', 'Placa Perone # 1', 'Blanco'),
  ('10122', 'NUT-10122', 'Placa Perone # 2', 'Rojo Morado'),
  ('10136', 'NUT-10136', 'Placas Humero Distal # 1', 'Negro'),
  ('10135', 'NUT-10135', 'Placas Humero Distal # 2', 'Café'),
  ('10139', 'NUT-10139', 'Grandes Fragmentos # 1', 'Amarillo'),
  ('10140', 'NUT-10140', 'Grandes Fragmentos # 2', 'Rojo'),
  ('10145', 'NUT-10145', 'Pequeños Fragmentos # 1', 'Naranja'),
  ('10144', 'NUT-10144', 'Pequeños Fragmentos # 2', 'Morado'),
  ('10143', 'NUT-10143', 'Pequeños Fragmentos # 3', 'Azul'),
  ('10129', 'NUT-10129', 'Pequeños Fragmentos # 4', 'Café'),
  ('10130', 'NUT-10130', 'Pequeños Fragmentos # 5', 'Blanco'),
  ('10147', 'NUT-10147', 'Clavo NeoSupra  # 1 Tornillos e Instrumental Suprapatelar  caja # 2', 'Café'),
  ('10105', 'NUT-10105', 'Clavo Neosupra # 1 Implantes Caja #3', 'Café'),
  ('10126', 'NUT-10126', 'Clavo Tibia Neosupra # 2  Instrumental Caja 1', 'Negro'),
  ('PI01', 'PI01', 'Pin de kirschner 1.6×180 mm # 1', 'Morado'),
  ('PI02', 'PI02', 'Pin de kirschner 1.6×180 mm # 2', 'Verde'),
  ('PI03', 'PI03', 'Pin de kirschner  2.5×230mm # 1', 'Amarillo'),
  ('PI04', 'PI04', 'Pin de kirschner  2.5×230mm # 2', 'Rojo'),
  ('PI05', 'PI05', 'Pin de kirschner  2.5×280mm # 1', 'Azul'),
  ('PI06', 'PI06', 'Pin de kirschner  2.5×280mm # 2', 'Café'),
  ('10106', 'NUT-10106', 'Taladro pequeños Fragmentos # 1', 'Verde'),
  ('10170', 'NUT-10170', 'Taladro pequeños Fragmentos # 2', 'Blanco'),
  ('10171', 'NUT-10171', 'Taladro pequeños Fragmentos # 3', NULL),
  ('10172', 'NUT-10172', 'Talagro Grandes Fragmentos # 1', 'Naranja'),
  ('10109', 'NUT-10109', 'Talagro Grandes Fragmentos # 2', NULL),
  ('10291', 'NUT-10291', 'Placas Tercio Caña', 'Amarillo')
ON CONFLICT (Codigo) DO UPDATE
    SET Demarcado = EXCLUDED.Demarcado, Nombre = EXCLUDED.Nombre, Color = EXCLUDED.Color;
