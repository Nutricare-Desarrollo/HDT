const { app } = require('@azure/functions');
const { query, getClient } = require('./db');
const { analyzeLayout, parseLayout, toInt } = require('./layout');
const { getCatalogo, getMapa, normCod } = require('./productos');

/* ============================================================
   Utilidades
   ============================================================ */
function json(status, body) { return { status, jsonBody: body }; }

/* Carga el mapa del catálogo para validar códigos. Best-effort: si el API de
   productos no responde, devuelve un Map vacío (no bloquea el guardado). */
async function mapaCatalogo(context) {
  try { return await getMapa(); }
  catch (e) { context.warn('Catálogo de productos no disponible para validar: ' + e.message); return new Map(); }
}
// Códigos del detalle que no existen en el catálogo (Map cargado). [] si el mapa está vacío.
function codigosInvalidos(detalle, mapa) {
  if (!mapa || !mapa.size) return [];
  return detalle
    .filter(d => (d.codigo != null && String(d.codigo).trim() !== ''))
    .filter(d => !mapa.has(normCod(d.codigo)))
    .map(d => d.codigo);
}
// Descripción oficial del catálogo para un código; si no está, usa la que mandó el cliente.
const descNutricare = (mapa, d) => (mapa.get(normCod(d.codigo)) || d.descripcion_nutricare || null);

// Usuario autenticado que inyecta Static Web Apps (Entra ID / SSO).
function getUser(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return {
      id: p.userId,
      name: p.userDetails,
      email: (p.userDetails || '').trim().toLowerCase(),
      roles: p.userRoles || []
    };
  } catch { return null; }
}

const ROLES = ['Hospital', 'Bodega', 'Administrador'];

// Registra/actualiza al usuario y devuelve su rol. Un usuario nuevo entra como 'Hospital'.
async function ensureUserRole(user) {
  if (!user || !user.email) return 'Hospital';
  await query(
    `INSERT INTO dbo.UsuarioRol (Email, Nombre, RolId, UltimoAcceso)
     VALUES ($1, $2, (SELECT Id FROM cat.Rol WHERE Nombre='Hospital'), (now() at time zone 'utc'))
     ON CONFLICT (Email) DO UPDATE
        SET Nombre = EXCLUDED.Nombre, UltimoAcceso = (now() at time zone 'utc')`,
    [user.email, user.name || user.email]
  );
  return getRole(user);
}
async function getRole(user) {
  if (!user || !user.email) return 'Hospital';
  const r = await query(
    `SELECT rol.Nombre AS rol FROM dbo.UsuarioRol u JOIN cat.Rol rol ON rol.Id = u.RolId WHERE u.Email = $1`,
    [user.email]);
  return r.rows.length ? r.rows[0].rol : 'Hospital';
}
const puedeSubir = (rol) => rol === 'Hospital' || rol === 'Administrador';
const puedeBodega = (rol) => rol === 'Bodega' || rol === 'Administrador';

/* ============================================================
   /api/me  -> usuario autenticado + rol
   ============================================================ */
app.http('me', {
  methods: ['GET'], authLevel: 'anonymous', route: 'me',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const rol = await ensureUserRole(user);
      return json(200, { ...user, rol });
    } catch (e) {
      context.error(e);
      return json(200, { ...user, rol: 'Hospital' });
    }
  }
});

/* ============================================================
   /api/extraer  -> lee la hoja (base64) y devuelve {encabezado, detalle}
   ============================================================ */
app.http('extraer', {
  methods: ['POST'], authLevel: 'anonymous', route: 'extraer',
  handler: async (request, context) => {
    try {
      const user = getUser(request);
      if (!user) return json(401, { error: 'No autenticado' });
      if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para subir hojas' });

      const body = await request.json();
      let b64 = body.imagenBase64 || '';
      // Acepta data URLs ("data:image/jpeg;base64,....") o base64 puro.
      const m = /^data:([^;]+);base64,(.*)$/s.exec(b64);
      if (m) b64 = m[2];
      if (!b64) return json(400, { error: 'Falta la imagen (imagenBase64)' });

      const analyzeResult = await analyzeLayout(b64);
      const parsed = parseLayout(analyzeResult);
      return json(200, parsed);
    } catch (e) {
      context.error(e);
      return json(502, { error: 'No se pudo leer la hoja', detail: e.message });
    }
  }
});

/* ============================================================
   /api/productos  -> catálogo de productos Nutricare (proxy + caché)
   ============================================================ */
app.http('productos-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'productos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const force = (request.query.get('refresh') || '') === '1';
      const data = await getCatalogo(force);
      return json(200, data);
    } catch (e) {
      context.error(e);
      return json(502, { error: 'No se pudo obtener el catálogo de productos', detail: e.message });
    }
  }
});

/* ============================================================
   Hojas de consumo — CRUD
   ============================================================ */
const ENC_FIELDS = [
  ['numero_hoja', 'NumeroHoja'], ['numero_documento', 'NumeroDocumento'], ['regimen', 'Regimen'],
  ['paciente', 'Paciente'], ['identificacion', 'Identificacion'], ['tipo', 'Tipo'],
  ['fecha_accidente', 'FechaAccidente'], ['fecha_cirugia', 'FechaCirugia'], ['fecha_hoja', 'FechaHoja'],
  ['cirujano', 'Cirujano'], ['instrumentista', 'Instrumentista'], ['diagnostico', 'Diagnostico'],
  ['procedimiento', 'Procedimiento']
];
const DATE_KEYS = new Set(['fecha_accidente', 'fecha_cirugia', 'fecha_hoja']);

// Formato de fecha/hora local (Costa Rica) para los listados.
const FECHA_LOCAL = `to_char((FechaCreacion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

/* Crear hoja (encabezado + detalle + imagen base64). Estado inicial = 'Enviado'. */
app.http('hoja-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'hojas',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para enviar hojas' });

    const body = await request.json();
    const enc = body.encabezado || {};
    const detalle = Array.isArray(body.detalle) ? body.detalle : [];

    // Validación de códigos contra el catálogo (no bloquea si el catálogo no responde).
    const mapa = await mapaCatalogo(context);
    const invalidos = codigosInvalidos(detalle, mapa);
    if (invalidos.length) return json(400, { error: 'Hay códigos que no existen en el catálogo: ' + invalidos.join(', ') });

    const cols = [], vals = [], ph = [];
    let i = 0;
    for (const [k, col] of ENC_FIELDS) {
      i++; cols.push(col); ph.push('$' + i);
      let v = enc[k];
      v = (v === undefined || v === null || v === '') ? null : v;
      if (DATE_KEYS.has(k) && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = null; // fecha inválida -> null
      vals.push(v);
    }
    cols.push('ImagenBase64'); vals.push(body.imagenBase64 || null); ph.push('$' + (++i));
    cols.push('ImagenTipo'); vals.push(body.imagenTipo || null); ph.push('$' + (++i));
    cols.push('Estado'); vals.push('Enviado'); ph.push('$' + (++i));
    cols.push('CreadoPor'); vals.push(user.name || user.email); ph.push('$' + (++i));
    cols.push('CreadoPorEmail'); vals.push(user.email); ph.push('$' + (++i));

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO dbo.HojaConsumo (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING Id`, vals);
      const id = r.rows[0].id;
      let linea = 0;
      for (const d of detalle) {
        linea++;
        await client.query(
          `INSERT INTO dbo.HojaConsumoDetalle (HojaConsumoId, Linea, Codigo, NumeroEquipo, Descripcion, DescripcionNutricare, Und, ReposicionAnaquel)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, d.linea || linea, d.codigo || null, d.numero_equipo || null, d.descripcion || null,
            descNutricare(mapa, d), toInt(d.und), toInt(d.reposicion_anaquel)]);
      }
      await client.query('COMMIT');
      return json(201, { ok: true, id });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo guardar la hoja de consumo', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* Listado para los grids. ?scope=hoy (por defecto) | historial */
app.http('hojas-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hojas',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      await getRole(user);
      const scope = (request.query.get('scope') || 'hoy').toLowerCase();
      const soloHoy = scope !== 'historial';
      const where = soloHoy
        ? `WHERE (FechaCreacion AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date
                 = (now() AT TIME ZONE 'America/Costa_Rica')::date`
        : '';
      const r = await query(
        `SELECT Id AS id, NumeroHoja AS numero_hoja, NumeroDocumento AS numero_documento,
                Regimen AS regimen, Cirujano AS cirujano, Instrumentista AS instrumentista,
                Diagnostico AS diagnostico, Estado AS estado, CreadoPor AS usuario,
                CreadoPorEmail AS usuario_email, ${FECHA_LOCAL} AS fecha, CantidadLineas AS cantidad_lineas
         FROM dbo.vHojaConsumo ${where} ORDER BY FechaCreacion DESC`);
      return json(200, r.rows);
    } catch (e) { context.error(e); return json(500, { error: 'Error al listar', detail: e.message }); }
  }
});

/* Una hoja completa (encabezado + detalle + imagen). */
app.http('hoja-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hojas/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const id = parseInt(request.params.id, 10);
      const h = await query(
        `SELECT Id AS id, NumeroHoja AS numero_hoja, NumeroDocumento AS numero_documento, Regimen AS regimen,
                Paciente AS paciente, Identificacion AS identificacion, Tipo AS tipo,
                to_char(FechaAccidente,'YYYY-MM-DD') AS fecha_accidente,
                to_char(FechaCirugia,'YYYY-MM-DD') AS fecha_cirugia,
                to_char(FechaHoja,'YYYY-MM-DD') AS fecha_hoja,
                Cirujano AS cirujano, Instrumentista AS instrumentista, Diagnostico AS diagnostico,
                Procedimiento AS procedimiento, ImagenBase64 AS imagen_base64, ImagenTipo AS imagen_tipo,
                Estado AS estado, CreadoPor AS usuario, CreadoPorEmail AS usuario_email,
                ${FECHA_LOCAL} AS fecha, ResultadoTR AS resultado_tr
         FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      if (!h.rows.length) return json(404, { error: 'No encontrada' });
      const d = await query(
        `SELECT Id AS id, Linea AS linea, Codigo AS codigo, NumeroEquipo AS numero_equipo,
                Descripcion AS descripcion, DescripcionNutricare AS descripcion_nutricare,
                Und AS und, ReposicionAnaquel AS reposicion_anaquel, NumeroLote AS numero_lote
         FROM dbo.HojaConsumoDetalle WHERE HojaConsumoId=$1 ORDER BY Linea, Id`, [id]);
      return json(200, { ...h.rows[0], detalle: d.rows });
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener', detail: e.message }); }
  }
});

/* Editar hoja (encabezado + detalle, incluye NumeroLote). Solo Bodega/Administrador. */
app.http('hoja-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'hojas/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar hojas' });

    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });

    const body = await request.json();
    const enc = body.encabezado || {};
    const detalle = Array.isArray(body.detalle) ? body.detalle : [];

    // Validación de códigos contra el catálogo (no bloquea si el catálogo no responde).
    const mapa = await mapaCatalogo(context);
    const invalidos = codigosInvalidos(detalle, mapa);
    if (invalidos.length) return json(400, { error: 'Hay códigos que no existen en el catálogo: ' + invalidos.join(', ') });

    const sets = [], vals = [];
    let i = 0;
    for (const [k, col] of ENC_FIELDS) {
      i++;
      let v = enc[k];
      v = (v === undefined || v === null || v === '') ? null : v;
      if (DATE_KEYS.has(k) && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = null; // fecha inválida -> null
      sets.push(`${col}=$${i}`); vals.push(v);
    }
    const idPh = '$' + (++i); vals.push(id);

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const up = await client.query(
        `UPDATE dbo.HojaConsumo SET ${sets.join(',')} WHERE Id=${idPh}`, vals);
      if (!up.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'No encontrada' }); }
      // Reemplaza el detalle completo (maneja altas, ediciones y bajas de líneas).
      await client.query(`DELETE FROM dbo.HojaConsumoDetalle WHERE HojaConsumoId=$1`, [id]);
      let linea = 0;
      for (const d of detalle) {
        linea++;
        await client.query(
          `INSERT INTO dbo.HojaConsumoDetalle (HojaConsumoId, Linea, Codigo, NumeroEquipo, Descripcion, DescripcionNutricare, Und, ReposicionAnaquel, NumeroLote)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, d.linea || linea, d.codigo || null, d.numero_equipo || null, d.descripcion || null,
            descNutricare(mapa, d), toInt(d.und), toInt(d.reposicion_anaquel),
            (d.numero_lote === undefined || d.numero_lote === '') ? null : d.numero_lote]);
      }
      await client.query('COMMIT');
      return json(200, { ok: true, id });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo actualizar la hoja de consumo', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* Resumen Hospital: cantidad de hojas subidas hoy y ayer (fecha local CR). */
app.http('resumen-hospital', {
  methods: ['GET'], authLevel: 'anonymous', route: 'resumen/hospital',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const r = await query(
        `WITH x AS (SELECT (FechaCreacion AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date AS d FROM dbo.HojaConsumo)
         SELECT
           COUNT(*) FILTER (WHERE d = (now() AT TIME ZONE 'America/Costa_Rica')::date) AS hoy,
           COUNT(*) FILTER (WHERE d = (now() AT TIME ZONE 'America/Costa_Rica')::date - 1) AS ayer
         FROM x`);
      const row = r.rows[0] || {};
      return json(200, { hoy: parseInt(row.hoy || 0, 10), ayer: parseInt(row.ayer || 0, 10) });
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener resumen', detail: e.message }); }
  }
});

/* Resumen Bodega: cantidad de hojas por estado. */
app.http('resumen-bodega', {
  methods: ['GET'], authLevel: 'anonymous', route: 'resumen/bodega',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega/Administrador' });
      const r = await query(`SELECT Estado AS estado, COUNT(*) AS n FROM dbo.HojaConsumo GROUP BY Estado`);
      const out = {};
      r.rows.forEach(x => { out[x.estado] = parseInt(x.n, 10); });
      return json(200, out);
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener resumen', detail: e.message }); }
  }
});

/* ============================================================
   Usuarios y roles (solo Administrador)
   ============================================================ */
app.http('usuarios-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'usuarios',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      if ((await getRole(user)) !== 'Administrador') return json(403, { error: 'Solo Administrador' });
      const r = await query(
        `SELECT u.Email AS email, u.Nombre AS nombre, rol.Nombre AS rol,
                to_char(u.UltimoAcceso,'YYYY-MM-DD HH24:MI') AS ultimo_acceso
         FROM dbo.UsuarioRol u JOIN cat.Rol rol ON rol.Id=u.RolId
         ORDER BY u.UltimoAcceso DESC NULLS LAST, u.Email`);
      return json(200, r.rows);
    } catch (e) { context.error(e); return json(500, { error: 'Error al listar usuarios', detail: e.message }); }
  }
});
app.http('usuario-set-rol', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'usuarios/{email}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      if ((await getRole(user)) !== 'Administrador') return json(403, { error: 'Solo Administrador' });
      const email = decodeURIComponent(request.params.email).trim().toLowerCase();
      const body = await request.json();
      const rol = (body.rol || '').trim();
      if (!ROLES.includes(rol)) return json(400, { error: 'Rol inválido' });
      const r = await query(
        `UPDATE dbo.UsuarioRol SET RolId=(SELECT Id FROM cat.Rol WHERE Nombre=$1) WHERE Email=$2`, [rol, email]);
      if (!r.rowCount) return json(404, { error: 'Usuario no encontrado' });
      return json(200, { ok: true });
    } catch (e) { context.error(e); return json(500, { error: 'No se pudo asignar el rol', detail: e.message }); }
  }
});
