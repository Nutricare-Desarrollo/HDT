const { app } = require('@azure/functions');
const { query, getClient } = require('./db');
const { analyzeLayout, parseLayout, toInt } = require('./layout');
const { getCatalogo, getMapa, normCod } = require('./productos');
const { getLotes } = require('./lotes');
const { iniciarDynamics, consultarDynamics } = require('./dynamics');

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
   /api/lotes  -> catálogo de lotes por producto (proxy + caché)
   ============================================================ */
app.http('lotes-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'lotes',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const force = (request.query.get('refresh') || '') === '1';
      const data = await getLotes(force);
      return json(200, data);
    } catch (e) {
      context.error(e);
      return json(502, { error: 'No se pudo obtener el catálogo de lotes', detail: e.message });
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
   Configuración (ubicaciones Origen/Destino) — solo Bodega/Administrador
   ============================================================ */
const CONFIG_AREAS = ['anaquel', 'nutricare', 'facturacion'];

/* Devuelve { anaquel:{origen,destino}, nutricare:{...}, facturacion:{...} }. */
app.http('config-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'configuracion',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega/Administrador' });
      const r = await query(`SELECT Area AS area, Origen AS origen, Destino AS destino FROM dbo.Configuracion`);
      const out = {};
      CONFIG_AREAS.forEach(a => { out[a] = { origen: '', destino: '' }; });
      r.rows.forEach(x => { if (out[x.area]) out[x.area] = { origen: x.origen || '', destino: x.destino || '' }; });
      return json(200, out);
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener la configuración', detail: e.message }); }
  }
});

/* Guarda las tres áreas (upsert). Body: { anaquel:{origen,destino}, ... }. */
app.http('config-save', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'configuracion',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar la configuración' });

    const body = await request.json();
    const norm = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();

    const client = await getClient();
    try {
      await client.query('BEGIN');
      for (const a of CONFIG_AREAS) {
        const area = body[a] || {};
        await client.query(
          `INSERT INTO dbo.Configuracion (Area, Origen, Destino, ModificadoPor, FechaModificacion)
           VALUES ($1,$2,$3,$4,(now() at time zone 'utc'))
           ON CONFLICT (Area) DO UPDATE
              SET Origen=EXCLUDED.Origen, Destino=EXCLUDED.Destino,
                  ModificadoPor=EXCLUDED.ModificadoPor, FechaModificacion=EXCLUDED.FechaModificacion`,
          [a, norm(area.origen), norm(area.destino), user.name || user.email]);
      }
      await client.query('COMMIT');
      return json(200, { ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo guardar la configuración', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* ============================================================
   Crear Trabajos en Dynamics  (solo Bodega / Administrador)
   Flujo asíncrono: el POST puede terminar de una (200) o pasar a 202 con una
   URL de seguimiento; el navegador consulta el estado hasta que termina.
   ============================================================ */

// Arma el objeto que espera el flujo: { Consecutivo, Detalle, Configuracion }.
async function construirPayloadDynamics(hojaId) {
  const h = await query(`SELECT Id AS id, Consecutivo AS consecutivo FROM dbo.HojaConsumo WHERE Id=$1`, [hojaId]);
  if (!h.rows.length) throw new Error('Hoja de consumo no encontrada');
  const consecutivo = h.rows[0].consecutivo;

  const det = await query(
    `SELECT Codigo AS codigo, NumeroLote AS numero_lote, Und AS und, ReposicionAnaquel AS reposicion_anaquel,
            NumeroEquipo AS numero_equipo, DescripcionNutricare AS descripcion_nutricare, Descripcion AS descripcion
     FROM dbo.HojaConsumoDetalle WHERE HojaConsumoId=$1 ORDER BY Linea, Id`, [hojaId]);
  const Detalle = det.rows.map(d => ({
    IdProducto: d.codigo || '',
    Lote: d.numero_lote || '',
    CantidadTotal: d.und == null ? 0 : d.und,
    ReposicionAnaquel: d.reposicion_anaquel == null ? 0 : d.reposicion_anaquel,
    Ubicacion: d.numero_equipo || '',                                  // "Ubicación" = N° de equipo
    Descripcion: d.descripcion_nutricare || d.descripcion || ''
  }));

  const cfg = await query(`SELECT Area AS area, Origen AS origen, Destino AS destino FROM dbo.Configuracion ORDER BY Area`);
  const Configuracion = cfg.rows.map(c => ({ area: c.area, origen: c.origen || '', destino: c.destino || '' }));

  return { Consecutivo: consecutivo, Detalle, Configuracion };
}

// ¿El proceso es "Pedido Pendiente"? (tolerante a mayúsculas/espacios)
const esPedidoPendiente = (s) => String(s || '').trim().toLowerCase() === 'pedido pendiente';

// Guarda el resultado del flujo: reemplaza los trabajos y los pedidos pendientes
// de la hoja, y la marca 'Finalizada'.
async function guardarResultadoDynamics(hojaId, data) {
  const arr = Array.isArray(data) ? data : [];
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM dbo.DynamicsTrabajo WHERE HojaConsumoId=$1`, [hojaId]);
    // Reemplaza los pedidos pendientes de la hoja (sus envíos caen por ON DELETE CASCADE).
    await client.query(`DELETE FROM dbo.PedidoPendiente WHERE HojaConsumoId=$1`, [hojaId]);
    for (const t of arr) {
      await client.query(
        `INSERT INTO dbo.DynamicsTrabajo (HojaConsumoId, IdProceso, IdHojaConsumo, Proceso, Estado)
         VALUES ($1,$2,$3,$4,$5)`,
        [hojaId, t.IdProceso || null, (t.IdHojaConsumo != null ? String(t.IdHojaConsumo) : null),
          t.Proceso || null, t.Estado || null]);
      // Productos del proceso "Pedido Pendiente" -> tabla de pedidos.
      if (esPedidoPendiente(t.Proceso) && Array.isArray(t.Productos)) {
        for (const p of t.Productos) {
          await client.query(
            `INSERT INTO dbo.PedidoPendiente
               (HojaConsumoId, IdProducto, Lote, Descripcion, CantidadTotal, ReposicionAnaquel, Ubicacion)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [hojaId, p.IdProducto || null, p.Lote || null, p.Descripcion || null,
              toInt(p.CantidadTotal) || 0, toInt(p.ReposicionAnaquel) || 0, p.Ubicacion || null]);
        }
      }
    }
    await client.query(
      `UPDATE dbo.HojaConsumo SET ResultadoTR=$2, Estado='Finalizada', DynamicsLocation=NULL WHERE Id=$1`,
      [hojaId, JSON.stringify(arr)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* POST /api/dynamics/{id} -> dispara la creación de trabajos.
   Respuesta: 200 {done:true, trabajos} si terminó; 202 {done:false} si sigue en proceso. */
app.http('dynamics-start', {
  methods: ['POST'], authLevel: 'anonymous', route: 'dynamics/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para crear trabajos en Dynamics' });
    const hojaId = parseInt(request.params.id, 10);
    if (!hojaId) return json(400, { error: 'Id inválido' });
    try {
      const payload = await construirPayloadDynamics(hojaId);
      // Marca la hoja como "Creando TR" desde ya (por si el proceso es largo).
      await query(`UPDATE dbo.HojaConsumo SET Estado='Creando TR' WHERE Id=$1`, [hojaId]);
      const r = await iniciarDynamics(payload);
      if (r.estado === 'en_proceso') {
        await query(`UPDATE dbo.HojaConsumo SET DynamicsLocation=$2 WHERE Id=$1`, [hojaId, r.location]);
        return json(202, { done: false });
      }
      await guardarResultadoDynamics(hojaId, r.data);
      return json(200, { done: true });
    } catch (e) {
      context.error(e);
      await query(`UPDATE dbo.HojaConsumo SET Estado='Error' WHERE Id=$1`, [hojaId]).catch(() => {});
      return json(502, { error: 'No se pudo crear los trabajos en Dynamics', detail: e.message });
    }
  }
});

/* GET /api/dynamics/{id}/estado -> consulta el avance (polling desde el navegador).
   Respuesta: {done:true} si ya terminó; {done:false} si sigue en proceso. */
app.http('dynamics-estado', {
  methods: ['GET'], authLevel: 'anonymous', route: 'dynamics/{id}/estado',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega/Administrador' });
    const hojaId = parseInt(request.params.id, 10);
    if (!hojaId) return json(400, { error: 'Id inválido' });
    try {
      const h = await query(
        `SELECT Estado AS estado, DynamicsLocation AS location, (ResultadoTR IS NOT NULL) AS tiene_resultado
         FROM dbo.HojaConsumo WHERE Id=$1`, [hojaId]);
      if (!h.rows.length) return json(404, { error: 'No encontrada' });
      const row = h.rows[0];
      if (row.estado === 'Finalizada' && row.tiene_resultado) return json(200, { done: true });
      if (!row.location) return json(200, { done: false }); // aún no hay seguimiento (o terminó sin location)
      const r = await consultarDynamics(row.location);
      if (r.estado === 'en_proceso') {
        if (r.location) await query(`UPDATE dbo.HojaConsumo SET DynamicsLocation=$2 WHERE Id=$1`, [hojaId, r.location]);
        return json(200, { done: false });
      }
      await guardarResultadoDynamics(hojaId, r.data);
      return json(200, { done: true });
    } catch (e) {
      context.error(e);
      await query(`UPDATE dbo.HojaConsumo SET Estado='Error', DynamicsLocation=NULL WHERE Id=$1`, [hojaId]).catch(() => {});
      return json(502, { error: 'No se pudo consultar el estado en Dynamics', detail: e.message });
    }
  }
});

/* GET /api/trabajos -> histórico de trabajos creados en Dynamics (para el grid). */
app.http('trabajos-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'trabajos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega/Administrador' });
    try {
      const r = await query(
        `SELECT t.Id AS id, t.HojaConsumoId AS hoja_id, h.Consecutivo AS consecutivo,
                t.IdHojaConsumo AS id_hoja_consumo, t.IdProceso AS id_proceso,
                t.Proceso AS proceso, t.Estado AS estado,
                to_char((t.FechaCreacion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI') AS fecha
         FROM dbo.DynamicsTrabajo t
         JOIN dbo.HojaConsumo h ON h.Id = t.HojaConsumoId
         ORDER BY t.FechaCreacion DESC, t.Id DESC`);
      return json(200, r.rows);
    } catch (e) { context.error(e); return json(500, { error: 'Error al listar trabajos', detail: e.message }); }
  }
});

/* ============================================================
   Pedido Pendiente  (solo Bodega / Administrador)
   Productos del proceso "Pedido Pendiente"; se registran envíos parciales.
   ============================================================ */
const PP_FECHA_LOCAL = `to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

// Un pedido con sus campos calculados (pendiente por enviar).
const PP_SELECT = `
  SELECT p.Id AS id, p.HojaConsumoId AS hoja_id, h.Consecutivo AS consecutivo,
         p.Ubicacion AS ubicacion, p.IdProducto AS id_producto, p.Lote AS lote,
         p.Descripcion AS descripcion, p.CantidadTotal AS cantidad_total,
         p.ReposicionAnaquel AS reposicion_anaquel, p.CantidadEnviada AS cantidad_enviada,
         (p.CantidadTotal - p.CantidadEnviada) AS pendiente, p.Estado AS estado
  FROM dbo.PedidoPendiente p JOIN dbo.HojaConsumo h ON h.Id = p.HojaConsumoId`;

/* GET /api/pedidos -> listado para el grid principal. */
app.http('pedidos-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'pedidos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega/Administrador' });
    try {
      const r = await query(`${PP_SELECT} ORDER BY p.Id DESC`);
      return json(200, r.rows);
    } catch (e) { context.error(e); return json(500, { error: 'Error al listar pedidos', detail: e.message }); }
  }
});

/* GET /api/pedidos/{id} -> un pedido + sus envíos. */
app.http('pedido-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'pedidos/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega/Administrador' });
    try {
      const id = parseInt(request.params.id, 10);
      const p = await query(`${PP_SELECT} WHERE p.Id=$1`, [id]);
      if (!p.rows.length) return json(404, { error: 'No encontrado' });
      const e = await query(
        `SELECT Id AS id, CantidadEnviada AS cantidad_enviada, Usuario AS usuario, ${PP_FECHA_LOCAL} AS fecha
         FROM dbo.PedidoPendienteEnvio WHERE PedidoPendienteId=$1 ORDER BY FechaHora, Id`, [id]);
      return json(200, { ...p.rows[0], envios: e.rows });
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener el pedido', detail: e.message }); }
  }
});

/* POST /api/pedidos/{id}/envios -> registra un envío parcial al anaquel.
   Body: { cantidad }. Valida: entero > 0 y no mayor al pendiente (CantidadTotal - CantidadEnviada). */
app.http('pedido-envio-add', {
  methods: ['POST'], authLevel: 'anonymous', route: 'pedidos/{id}/envios',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para registrar envíos' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    const body = await request.json();
    const cantidad = toInt(body.cantidad);
    if (!cantidad || cantidad <= 0) return json(400, { error: 'La cantidad a enviar debe ser mayor a cero' });

    const client = await getClient();
    try {
      await client.query('BEGIN');
      // Bloquea la fila para calcular el pendiente sin condiciones de carrera.
      const p = await client.query(
        `SELECT CantidadTotal AS total, CantidadEnviada AS enviada FROM dbo.PedidoPendiente WHERE Id=$1 FOR UPDATE`, [id]);
      if (!p.rows.length) { await client.query('ROLLBACK'); return json(404, { error: 'Pedido no encontrado' }); }
      const pendiente = p.rows[0].total - p.rows[0].enviada;
      if (cantidad > pendiente) {
        await client.query('ROLLBACK');
        return json(400, { error: `La cantidad a enviar (${cantidad}) no puede superar el pendiente (${pendiente})` });
      }
      await client.query(
        `INSERT INTO dbo.PedidoPendienteEnvio (PedidoPendienteId, CantidadEnviada, Usuario, FechaHora)
         VALUES ($1,$2,$3,(now() at time zone 'utc'))`, [id, cantidad, user.name || user.email]);
      // Acumula lo enviado. El estado se mantiene 'Por enviar'.
      await client.query(
        `UPDATE dbo.PedidoPendiente SET CantidadEnviada = CantidadEnviada + $2 WHERE Id=$1`, [id, cantidad]);
      await client.query('COMMIT');
      return json(201, { ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo registrar el envío', detail: e.message });
    } finally {
      client.release();
    }
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
