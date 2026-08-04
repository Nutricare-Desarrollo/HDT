/* ============================================================================
   HDT · Hojas de Consumo — Catálogo de Equipos (Anexo #2)  (Fase 5)
   Motor: PostgreSQL (Azure Database for PostgreSQL - Flexible Server)
   Ejecutar DESPUÉS de 01..08:  node run-db.js  (o psql -f 09_Equipos.sql)
   ----------------------------------------------------------------------------
   Catálogo de equipos para validar la columna "N° equipo" de la hoja de consumo.
   Codigo = número demarcado SIN el prefijo NUT- (lo que escribe el usuario:
   ej. 10284 en vez de NUT-10284). Datos iniciales tomados del Anexo #2; luego se
   actualizan desde la pantalla de carga (POST /equipos/importar).

   Idempotente: seguro de re-ejecutar.
   ============================================================================ */

CREATE SCHEMA IF NOT EXISTS cat;

CREATE TABLE IF NOT EXISTS cat.Equipo (
    Codigo             VARCHAR(40) PRIMARY KEY,   -- normalizado, sin NUT- (lo que escribe el usuario)
    Demarcado          VARCHAR(60) NULL,          -- valor original del Anexo (ej. NUT-10284)
    Nombre             VARCHAR(300) NULL,
    ActualizadoPor     VARCHAR(200) NULL,
    FechaActualizacion TIMESTAMP(0) NULL
);

-- Carga inicial (upsert por Codigo). Re-ejecutar es seguro.
INSERT INTO cat.Equipo (Codigo, Demarcado, Nombre) VALUES
  ('10284', 'NUT-10284', 'Placas tibia Proximal Lateral Derecha # 1'),
  ('10287', 'NUT-10287', 'Placas tibia Proximal Lateral Derecha # 2'),
  ('10285', 'NUT-10285', 'Placas tibia Proximal Lateral Izquierda # 1'),
  ('10288', 'NUT-10288', 'Placas tibia Proximal Lateral Izquierda # 2'),
  ('10286', 'NUT-10286', 'Placas tibia Proximal Lateral 4.5 /5.0 # 1'),
  ('10289', 'NUT-10289', 'Placas tibia Proximal Lateral 4.5 /5.0 # 2'),
  ('10110', 'NUT-10110', 'Placa de Tibia Proximal Medial # 1'),
  ('10125', 'NUT-10125', 'Placa de Tibia Proximal Medial # 2'),
  ('10101', 'NUT-10101', 'Canulados 4.0 # 1'),
  ('10102', 'NUT-10102', 'Canulados 4.0 # 2'),
  ('10112', 'NUT-10112', 'Canulados 4.5  # 1'),
  ('10111', 'NUT-10111', 'Canulados 4.5  # 2'),
  ('10142', 'NUT-10142', 'Canulados 7.3 # 1'),
  ('10141', 'NUT-10141', 'Canulados 7.3 # 2'),
  ('10113', 'NUT-10113', 'Hcs 2.4/3.0  # 1'),
  ('10114', 'NUT-10114', 'Hcs 2.4/3.0  # 2'),
  ('10104', 'NUT-10104', 'Placas Radio Distal # 1'),
  ('10103', 'NUT-10103', 'Placas Radio Distal # 2'),
  ('10146', 'NUT-10146', 'Instrumental Radio Distal # 1'),
  ('10128', 'NUT-10128', 'Instrumental Radio Distal # 2'),
  ('10108', 'NUT-10108', 'Placas rectas 4.5 /5.0 # 1'),
  ('10107', 'NUT-10107', 'Placas rectas 4.5 /5.0 # 2'),
  ('10131', 'NUT-10131', 'Placas rectas 3.5  # 1'),
  ('10132', 'NUT-10132', 'Placas rectas 3.5  # 2'),
  ('10115', 'NUT-10115', 'Placas Tibia Distal # 1'),
  ('10116', 'NUT-10116', 'Placas Tibia Distal # 2'),
  ('10118', 'NUT-10118', 'Placas humero proximal # 1'),
  ('10117', 'NUT-10117', 'Placas humero proximal # 2'),
  ('10119', 'NUT-10119', 'Placas femur distal # 1'),
  ('10120', 'NUT-10120', 'Placas femur distal # 2'),
  ('10121', 'NUT-10121', 'Placa Perone # 1'),
  ('10122', 'NUT-10122', 'Placa Perone # 2'),
  ('10136', 'NUT-10136', 'Placas Humero Distal # 1'),
  ('10135', 'NUT-10135', 'Placas Humero Distal # 2'),
  ('10139', 'NUT-10139', 'Grandes Fragmentos # 1'),
  ('10140', 'NUT-10140', 'Grandes Fragmentos # 2'),
  ('10145', 'NUT-10145', 'Pequeños Fragmentos # 1'),
  ('10144', 'NUT-10144', 'Pequeños Fragmentos # 2'),
  ('10143', 'NUT-10143', 'Pequeños Fragmentos # 3'),
  ('10129', 'NUT-10129', 'Pequeños Fragmentos # 4'),
  ('10130', 'NUT-10130', 'Pequeños Fragmentos # 5'),
  ('10147', 'NUT-10147', 'Clavo NeoSupra  # 1 Tornillos e Instrumental Suprapatelar  caja # 2'),
  ('10105', 'NUT-10105', 'Clavo Neosupra # 1 Implantes Caja #3'),
  ('10126', 'NUT-10126', 'Clavo Tibia Neosupra # 2  Instrumental Caja 1'),
  ('PI01', 'PI01', 'Pin de kirschner 1.6×180 mm # 1'),
  ('PI02', 'PI02', 'Pin de kirschner 1.6×180 mm # 2'),
  ('PI03', 'PI03', 'Pin de kirschner  2.5×230mm # 1'),
  ('PI04', 'PI04', 'Pin de kirschner  2.5×230mm # 2'),
  ('PI05', 'PI05', 'Pin de kirschner  2.5×280mm # 1'),
  ('PI06', 'PI06', 'Pin de kirschner  2.5×280mm # 2'),
  ('10106', 'NUT-10106', 'Taladro pequeños Fragmentos # 1'),
  ('10170', 'NUT-10170', 'Taladro pequeños Fragmentos # 2'),
  ('10171', 'NUT-10171', 'Taladro pequeños Fragmentos # 3'),
  ('10172', 'NUT-10172', 'Talagro Grandes Fragmentos # 1'),
  ('10109', 'NUT-10109', 'Talagro Grandes Fragmentos # 2'),
  ('10291', 'NUT-10291', 'Placas Tercio Caña')
ON CONFLICT (Codigo) DO UPDATE
    SET Demarcado = EXCLUDED.Demarcado, Nombre = EXCLUDED.Nombre;
