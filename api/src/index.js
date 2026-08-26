const { app } = require('@azure/functions');
const { query, getClient } = require('./db');
const { analyzeLayout, parseLayout, toInt } = require('./layout');
const audit = require('./auditoria');
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

// Usuarios cuyo rol NO se puede cambiar (protegidos). Comparación en minúsculas.
const EMAILS_PROTEGIDOS = new Set(['desarrollo@nutricare.co.cr']);
const esProtegido = (email) => EMAILS_PROTEGIDOS.has(String(email || '').trim().toLowerCase());

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
   /api/equipos  -> catálogo de equipos (Anexo #2) para validar "N° equipo"
   ============================================================ */
/* ============================================================
   Catálogo de cirujanos (lista desplegable del encabezado)
   ============================================================ */

// Normaliza el nombre: colapsa espacios y recorta. Vacío -> ''.
const normNombre = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/* GET /api/cirujanos -> lista de cirujanos activos (cualquier usuario autenticado). */
app.http('cirujanos-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'cirujanos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const r = await query(
        `SELECT Id AS id, Nombre AS nombre FROM cat.Cirujano WHERE Activo = TRUE ORDER BY Nombre`);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el cat\u00e1logo de cirujanos', detail: e.message });
    }
  }
});

/* POST /api/cirujanos -> agrega un cirujano (Hospital/Administrador). Body: { nombre } */
app.http('cirujano-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'cirujanos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el cat\u00e1logo de cirujanos' });
    const body = await request.json();
    const nombre = normNombre(body && body.nombre);
    if (!nombre) return json(400, { error: 'El nombre del cirujano es obligatorio' });
    if (nombre.length > 200) return json(400, { error: 'El nombre no puede superar los 200 caracteres' });
    try {
      const r = await query(
        `INSERT INTO cat.Cirujano (Nombre, CreadoPor) VALUES ($1, $2) RETURNING Id AS id, Nombre AS nombre`,
        [nombre, user.name || user.email]);
      return json(201, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ese cirujano ya existe en el cat\u00e1logo' });
      context.error(e);
      return json(500, { error: 'No se pudo agregar el cirujano', detail: e.message });
    }
  }
});

/* PUT /api/cirujanos/{id} -> corrige el nombre (Hospital/Administrador). Body: { nombre }
   No modifica las hojas ya creadas: ahí el nombre queda como se guardó. */
app.http('cirujano-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'cirujanos/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el cat\u00e1logo de cirujanos' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inv\u00e1lido' });
    const body = await request.json();
    const nombre = normNombre(body && body.nombre);
    if (!nombre) return json(400, { error: 'El nombre del cirujano es obligatorio' });
    if (nombre.length > 200) return json(400, { error: 'El nombre no puede superar los 200 caracteres' });
    try {
      const r = await query(
        `UPDATE cat.Cirujano SET Nombre=$1, ActualizadoPor=$2, FechaActualizacion=(now() at time zone 'utc')
          WHERE Id=$3 AND Activo = TRUE RETURNING Id AS id, Nombre AS nombre`,
        [nombre, user.name || user.email, id]);
      if (!r.rowCount) return json(404, { error: 'El cirujano no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ya hay otro cirujano con ese nombre' });
      context.error(e);
      return json(500, { error: 'No se pudo actualizar el cirujano', detail: e.message });
    }
  }
});

/* ============================================================
   Catálogo de régimen (lista desplegable del encabezado)
   ============================================================ */

/* GET /api/regimenes -> lista de regímenes activos (cualquier usuario autenticado). */
app.http('regimenes-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'regimenes',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const r = await query(
        `SELECT Id AS id, Nombre AS nombre FROM cat.Regimen WHERE Activo = TRUE ORDER BY Nombre`);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el cat\u00e1logo de reg\u00edmenes', detail: e.message });
    }
  }
});

/* POST /api/regimenes -> agrega un régimen. Body: { nombre }
   Lo puede usar cualquier rol autenticado: el campo Régimen se llena tanto en el
   wizard de Hospital como en la edición de Bodega, así que los dos necesitan el "+". */
app.http('regimen-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'regimenes',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const body = await request.json();
    const nombre = normNombre(body && body.nombre);
    if (!nombre) return json(400, { error: 'El nombre del r\u00e9gimen es obligatorio' });
    if (nombre.length > 60) return json(400, { error: 'El nombre no puede superar los 60 caracteres' });
    try {
      const r = await query(
        `INSERT INTO cat.Regimen (Nombre, CreadoPor) VALUES ($1, $2) RETURNING Id AS id, Nombre AS nombre`,
        [nombre, user.name || user.email]);
      return json(201, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ese r\u00e9gimen ya existe en el cat\u00e1logo' });
      context.error(e);
      return json(500, { error: 'No se pudo agregar el r\u00e9gimen', detail: e.message });
    }
  }
});

/* PUT /api/regimenes/{id} -> corrige el nombre. Body: { nombre }
   No modifica las hojas ya creadas: ahí el texto queda como se guardó. */
app.http('regimen-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'regimenes/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inv\u00e1lido' });
    const body = await request.json();
    const nombre = normNombre(body && body.nombre);
    if (!nombre) return json(400, { error: 'El nombre del r\u00e9gimen es obligatorio' });
    if (nombre.length > 60) return json(400, { error: 'El nombre no puede superar los 60 caracteres' });
    try {
      const r = await query(
        `UPDATE cat.Regimen SET Nombre=$1, ActualizadoPor=$2, FechaActualizacion=(now() at time zone 'utc')
          WHERE Id=$3 AND Activo = TRUE RETURNING Id AS id, Nombre AS nombre`,
        [nombre, user.name || user.email, id]);
      if (!r.rowCount) return json(404, { error: 'El r\u00e9gimen no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ya hay otro r\u00e9gimen con ese nombre' });
      context.error(e);
      return json(500, { error: 'No se pudo actualizar el r\u00e9gimen', detail: e.message });
    }
  }
});

app.http('equipos-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'equipos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const r = await query(`SELECT Codigo AS codigo, Demarcado AS demarcado, Nombre AS nombre, Color AS color FROM cat.Equipo ORDER BY Codigo`);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el catálogo de equipos', detail: e.message });
    }
  }
});

/* POST /api/equipos/importar -> reemplaza el catálogo de equipos (Bodega/Administrador).
   Body: { equipos: [{ codigo, demarcado, nombre }, ...] }. Normaliza y deduplica por código. */
app.http('equipos-importar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'equipos/importar',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para actualizar equipos' });
    const body = await request.json();
    const equipos = Array.isArray(body.equipos) ? body.equipos : [];
    const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, '').replace(/^nut-?/i, '').toUpperCase();
    const map = new Map();
    for (const e of equipos) {
      const cod = norm(e && (e.codigo != null ? e.codigo : e.demarcado));
      if (!cod) continue;
      if (!map.has(cod)) map.set(cod, {
        codigo: cod,
        demarcado: (e.demarcado != null && String(e.demarcado).trim() !== '') ? String(e.demarcado).trim() : null,
        nombre: (e.nombre != null && String(e.nombre).trim() !== '') ? String(e.nombre).trim() : null,
        color: (e.color != null && String(e.color).trim() !== '') ? String(e.color).trim() : null
      });
    }
    if (!map.size) return json(400, { error: 'No se encontraron equipos válidos para importar' });
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM cat.Equipo`);
      for (const it of map.values()) {
        await client.query(
          `INSERT INTO cat.Equipo (Codigo, Demarcado, Nombre, Color, ActualizadoPor, FechaActualizacion)
           VALUES ($1,$2,$3,$4,$5,(now() at time zone 'utc'))`,
          [it.codigo, it.demarcado, it.nombre, it.color, user.name || user.email]);
      }
      await client.query('COMMIT');
      return json(200, { ok: true, total: map.size });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo importar el catálogo de equipos', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* GET /api/equipos/productos -> relación equipo -> [códigos] para validar la combinación. */
app.http('equipo-productos', {
  methods: ['GET'], authLevel: 'anonymous', route: 'equipos/productos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      const r = await query(
        `SELECT EquipoCodigo AS equipo, array_agg(ProductoCodigo ORDER BY ProductoCodigo) AS codigos
         FROM cat.EquipoProducto GROUP BY EquipoCodigo ORDER BY EquipoCodigo`);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la relación equipo-producto', detail: e.message });
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

/* Estados en los que la hoja queda BLOQUEADA: ya se dispararon sus trabajos en
   Dynamics. 'Creando TR' se pone en cuanto el usuario toca el botón, así que el
   bloqueo empieza ahí y no cuando el flujo responde.
   'Error' NO entra: si el envío falló, Bodega tiene que poder corregir y
   reintentar; si no, un problema de red dejaría la hoja trabada para siempre.
   El bloqueo es para TODOS los roles, Administrador incluido: una hoja con su TR
   creada es un documento cerrado y lo que haya que corregir va en un
   reemplazo / corrección. */
const ESTADOS_BLOQUEADOS = new Set(['Creando TR', 'Finalizada']);

// Formato de fecha/hora local (Costa Rica) para los listados.
const FECHA_LOCAL = `to_char((FechaCreacion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

// N° de equipo canónico: siempre con prefijo NUT- (ej. "10129" -> "NUT-10129").
// Quita espacios y cualquier "NUT-" previo para no duplicarlo (idempotente). Vacío -> null.
function equipoConPrefijo(v) {
  const c = String(v == null ? '' : v).replace(/\s+/g, '').replace(/^nut-?/i, '').toUpperCase();
  return c ? ('NUT-' + c) : null;
}

/* Crear hoja (encabezado + detalle + imagen base64). Estado inicial = 'Enviado'. */
/* ============================================================
   Consecutivo del N° de hoja (PREFIJO-NUMERO)
   ============================================================ */

// Clave de comparación: mismo criterio que el índice único de la base.
const numeroHojaKey = (v) => String(v == null ? '' : v).trim().toUpperCase();

// Lee el prefijo y el último consecutivo usado de la pantalla Configuración.
async function getConfigConsecutivo() {
  const r = await query(
    `SELECT Prefijo AS prefijo, Consecutivo AS consecutivo FROM dbo.ConfiguracionConsecutivo WHERE Id = 1`);
  if (!r.rows.length) return { prefijo: '', ultimo: 0 };
  return {
    prefijo: (r.rows[0].prefijo || '').trim(),
    ultimo: r.rows[0].consecutivo != null ? Number(r.rows[0].consecutivo) : 0
  };
}

// Arma el texto del consecutivo. Sin prefijo configurado, va solo el número.
const armarNumero = (prefijo, n) => (prefijo ? (prefijo + '-' + n) : String(n));

/* Extrae la parte numérica de un N° de hoja para guardarla como "último usado".
   Devuelve null si el usuario escribió algo que no termina en número. */
function parteNumerica(numero, prefijo) {
  let resto = String(numero == null ? '' : numero).trim();
  if (!resto) return null;
  if (prefijo) {
    const esc = prefijo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    resto = resto.replace(new RegExp('^' + esc + '\\s*-?\\s*', 'i'), '');
  }
  return /^\d+$/.test(resto) ? resto : null;
}

/* ¿Ese N° de hoja ya está usado? excluirId permite editar una hoja sin chocar
   consigo misma. */
async function numeroHojaEnUso(numero, excluirId) {
  const key = numeroHojaKey(numero);
  if (!key) return false;
  const r = excluirId
    ? await query(`SELECT 1 FROM dbo.HojaConsumo WHERE UPPER(TRIM(NumeroHoja)) = $1 AND Id <> $2 LIMIT 1`, [key, excluirId])
    : await query(`SELECT 1 FROM dbo.HojaConsumo WHERE UPPER(TRIM(NumeroHoja)) = $1 LIMIT 1`, [key]);
  return r.rows.length > 0;
}

/* Guarda el consecutivo recién usado como "último usado" en Configuración.
   Best-effort: si falla, no tumba el guardado de la hoja. */
async function actualizarUltimoConsecutivo(numero, prefijo, user, context) {
  try {
    const n = parteNumerica(numero, prefijo);
    if (n === null) return;   // el usuario escribió un número libre, no numérico
    await query(
      `INSERT INTO dbo.ConfiguracionConsecutivo (Id, Consecutivo, ModificadoPor, FechaModificacion)
       VALUES (1,$1,$2,(now() at time zone 'utc'))
       ON CONFLICT (Id) DO UPDATE
          SET Consecutivo=EXCLUDED.Consecutivo, ModificadoPor=EXCLUDED.ModificadoPor,
              FechaModificacion=EXCLUDED.FechaModificacion`,
      [n, (user && (user.name || user.email)) || null]);
  } catch (e) {
    if (context) context.warn('No se pudo actualizar el ultimo consecutivo: ' + e.message);
  }
}

/* GET /api/consecutivo/siguiente -> { numero, prefijo, ultimo }
   Ruta propia (no 'hojas/...') para que no compita con GET /api/hojas/{id}.
   Sugiere el último usado + 1, y sigue subiendo mientras ese número ya exista
   (por si alguien escribió uno a mano más adelante). */
app.http('hoja-siguiente-numero', {
  methods: ['GET'], authLevel: 'anonymous', route: 'consecutivo/siguiente',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para crear hojas' });
    try {
      const { prefijo, ultimo } = await getConfigConsecutivo();
      let n = (Number.isFinite(ultimo) ? ultimo : 0) + 1;
      if (n < 1) n = 1;
      // Salta los que ya estén ocupados (tope defensivo por si algo se descuadra).
      for (let i = 0; i < 500; i++) {
        if (!(await numeroHojaEnUso(armarNumero(prefijo, n)))) break;
        n++;
      }
      return json(200, { numero: armarNumero(prefijo, n), prefijo, ultimo });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo calcular el siguiente consecutivo', detail: e.message });
    }
  }
});

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

    // El N° de hoja es el consecutivo del documento: no se puede repetir.
    const numHoja = String((enc.numero_hoja == null ? '' : enc.numero_hoja)).trim();
    if (numHoja && await numeroHojaEnUso(numHoja))
      return json(400, { error: 'El consecutivo ' + numHoja + ' ya existe. Cambie el N\u00b0 de hoja.' });

    // Una cirugía admite una sola hoja "real"; los reemplazos sí se permiten.
    const cirugiaIdChk = parseInt(body.cirugia_id, 10);
    if (Number.isFinite(cirugiaIdChk) && body.es_reemplazo !== true) {
      const ya = await query(`SELECT 1 FROM dbo.HojaConsumo WHERE CirugiaId=$1 AND EsReemplazo=FALSE LIMIT 1`, [cirugiaIdChk]);
      if (ya.rows.length) return json(400, { error: 'La cirugía ya tiene una hoja de consumo. Cree un reemplazo desde esa hoja si necesita corregirla.' });
    }

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
    // Estado inicial: 'Enviado' (por defecto) o 'Pendiente reposición' (acción Guardar de Hospital).
    const estadoInicial = (body.estado === 'Pendiente reposición') ? 'Pendiente reposición' : 'Enviado';
    cols.push('Estado'); vals.push(estadoInicial); ph.push('$' + (++i));
    // Reemplazo/corrección: marca + referencia a la hoja original (se resuelve en Bodega, no va a Dynamics).
    const origenId = parseInt(body.hoja_origen_id, 10);
    const cirugiaId = parseInt(body.cirugia_id, 10);
    cols.push('EsReemplazo'); vals.push(body.es_reemplazo === true); ph.push('$' + (++i));
    cols.push('HojaOrigenId'); vals.push(Number.isFinite(origenId) ? origenId : null); ph.push('$' + (++i));
    cols.push('CirugiaId'); vals.push(Number.isFinite(cirugiaId) ? cirugiaId : null); ph.push('$' + (++i));
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
          [id, d.linea || linea, d.codigo || null, equipoConPrefijo(d.numero_equipo), d.descripcion || null,
            descNutricare(mapa, d), toInt(d.und), toInt(d.reposicion_anaquel)]);
      }
      await client.query('COMMIT');
      // El consecutivo recién usado pasa a ser el "último usado" de Configuración.
      const cfgCons = await getConfigConsecutivo();
      await actualizarUltimoConsecutivo(numHoja, cfgCons.prefijo, user, context);
      return json(201, { ok: true, id });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // Carrera entre dos usuarios: el índice único de la base es la última barrera.
      if (e.code === '23505' && String(e.constraint || '').toLowerCase().indexOf('numerohoja') >= 0)
        return json(400, { error: 'El consecutivo ' + numHoja + ' ya existe. Cambie el N\u00b0 de hoja.' });
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
      const estadoF = request.query.get('estado');
      const soloReemplazos = request.query.get('reemplazos') === '1';
      let where = '', params = [];
      if (soloReemplazos) {
        // Bandeja de reemplazos/correcciones (Bodega): todas las marcadas como reemplazo.
        where = `WHERE h.EsReemplazo = TRUE`;
      } else if (estadoF) {
        // Filtro explícito por estado (p. ej. la bandeja de Pendientes de reposición).
        where = `WHERE h.Estado = $1`; params = [estadoF];
      } else {
        // Grid principal: se excluyen las pendientes de reposición y los reemplazos (tienen su bandeja).
        const conds = [`h.Estado <> 'Pendiente reposición'`, `h.EsReemplazo = FALSE`];
        if (soloHoy) conds.push(`(h.FechaCreacion AT TIME ZONE 'UTC' AT TIME ZONE 'America/Costa_Rica')::date
                 = (now() AT TIME ZONE 'America/Costa_Rica')::date`);
        where = 'WHERE ' + conds.join(' AND ');
      }
      const r = await query(
        `SELECT h.Id AS id, h.Consecutivo AS consecutivo, h.NumeroHoja AS numero_hoja, h.NumeroDocumento AS numero_documento,
                h.Regimen AS regimen, h.Cirujano AS cirujano, h.Instrumentista AS instrumentista,
                h.Diagnostico AS diagnostico, h.Estado AS estado, h.CreadoPor AS usuario,
                h.CreadoPorEmail AS usuario_email,
                to_char((h.FechaCreacion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI') AS fecha,
                (SELECT COUNT(*) FROM dbo.HojaConsumoDetalle d WHERE d.HojaConsumoId = h.Id) AS cantidad_lineas,
                h.EsReemplazo AS es_reemplazo, h.HojaOrigenId AS hoja_origen_id,
                (SELECT o.NumeroHoja FROM dbo.HojaConsumo o WHERE o.Id = h.HojaOrigenId) AS origen_numero_hoja
         FROM dbo.HojaConsumo h ${where} ORDER BY h.FechaCreacion DESC`, params);
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
        `SELECT Id AS id, Consecutivo AS consecutivo, NumeroHoja AS numero_hoja, NumeroDocumento AS numero_documento, Regimen AS regimen,
                Paciente AS paciente, Identificacion AS identificacion, Tipo AS tipo,
                to_char(FechaAccidente,'YYYY-MM-DD') AS fecha_accidente,
                to_char(FechaCirugia,'YYYY-MM-DD') AS fecha_cirugia,
                to_char(FechaHoja,'YYYY-MM-DD') AS fecha_hoja,
                Cirujano AS cirujano, Instrumentista AS instrumentista, Diagnostico AS diagnostico,
                Procedimiento AS procedimiento, ImagenBase64 AS imagen_base64, ImagenTipo AS imagen_tipo,
                Estado AS estado, CreadoPor AS usuario, CreadoPorEmail AS usuario_email,
                EsReemplazo AS es_reemplazo, HojaOrigenId AS hoja_origen_id, CirugiaId AS cirugia_id,
                (SELECT o.NumeroHoja FROM dbo.HojaConsumo o WHERE o.Id = HojaConsumo.HojaOrigenId) AS origen_numero_hoja,
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
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });

    // Estado actual: define permisos y las transiciones permitidas.
    const curH = await query(`SELECT Estado AS estado FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
    if (!curH.rows.length) return json(404, { error: 'No encontrada' });
    const estadoActual = curH.rows[0].estado;
    const rolEditor = await getRole(user);
    const esPendiente = estadoActual === 'Pendiente reposición';
    // Bodega/Administrador siempre pueden editar; Hospital solo si la hoja está 'Pendiente reposición'.
    if (!(puedeBodega(rolEditor) || (puedeSubir(rolEditor) && esPendiente))) {
      return json(403, { error: 'No tiene permiso para editar esta hoja' });
    }
    /* Bloqueo por Dynamics. Va acá, en el servidor, y no solo escondiendo el
       botón: el frontend deshabilita los campos, pero la regla tiene que valer
       para cualquier llamada al endpoint. */
    if (ESTADOS_BLOQUEADOS.has(estadoActual)) {
      return json(409, {
        error: 'La hoja est\u00e1 bloqueada porque sus trabajos ya se enviaron a Dynamics '
             + '(estado "' + estadoActual + '"). Para corregir algo, cree un reemplazo / correcci\u00f3n.'
      });
    }

    const body = await request.json();
    const enc = body.encabezado || {};
    const detalle = Array.isArray(body.detalle) ? body.detalle : [];

    /* Auditoría: solo se registran los cambios hechos por Bodega/Administrador.
       Se lee el estado ANTERIOR completo antes de tocar nada; el diff y el
       INSERT van dentro de la misma transacción del UPDATE, así que si el
       guardado se revierte, no queda un historial que miente. */
    const auditar = puedeBodega(rolEditor);
    let antes = null;
    if (auditar) {
      const ah = await query(
        `SELECT NumeroHoja AS numero_hoja, NumeroDocumento AS numero_documento, Regimen AS regimen,
                Paciente AS paciente, Identificacion AS identificacion, Tipo AS tipo,
                to_char(FechaAccidente,'YYYY-MM-DD') AS fecha_accidente,
                to_char(FechaCirugia,'YYYY-MM-DD')   AS fecha_cirugia,
                to_char(FechaHoja,'YYYY-MM-DD')      AS fecha_hoja,
                Cirujano AS cirujano, Instrumentista AS instrumentista,
                Diagnostico AS diagnostico, Procedimiento AS procedimiento, Estado AS estado
           FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      const ad = await query(
        `SELECT Codigo AS codigo, NumeroEquipo AS numero_equipo, Und AS und,
                ReposicionAnaquel AS reposicion_anaquel, NumeroLote AS numero_lote
           FROM dbo.HojaConsumoDetalle WHERE HojaConsumoId=$1 ORDER BY Linea, Id`, [id]);
      antes = { encabezado: ah.rows[0] || {}, detalle: ad.rows, estado: estadoActual };
    }

    // Transición de estado permitida solo desde 'Pendiente reposición' (Guardar/Enviar de Hospital).
    let nuevoEstado = null;
    if (esPendiente && (body.estado === 'Pendiente reposición' || body.estado === 'Enviado')) nuevoEstado = body.estado;

    // El N° de hoja es el consecutivo: no puede chocar con OTRA hoja.
    const numHojaUp = String((enc.numero_hoja == null ? '' : enc.numero_hoja)).trim();
    if (numHojaUp && await numeroHojaEnUso(numHojaUp, id))
      return json(400, { error: 'El consecutivo ' + numHojaUp + ' ya existe. Cambie el N\u00b0 de hoja.' });

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
    if (nuevoEstado) { i++; sets.push(`Estado=$${i}`); vals.push(nuevoEstado); }
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
          [id, d.linea || linea, d.codigo || null, equipoConPrefijo(d.numero_equipo), d.descripcion || null,
            descNutricare(mapa, d), toInt(d.und), toInt(d.reposicion_anaquel),
            (d.numero_lote === undefined || d.numero_lote === '') ? null : d.numero_lote]);
      }

      /* Diff contra el estado anterior. El detalle se compara ya normalizado
         (equipo con prefijo NUT-, Und y Reposición como entero) para que el
         formato no se confunda con un cambio real. */
      if (auditar && antes) {
        const detNorm = detalle.map(d => ({
          codigo: d.codigo || null,
          numero_equipo: equipoConPrefijo(d.numero_equipo),
          und: toInt(d.und),
          reposicion_anaquel: toInt(d.reposicion_anaquel),
          numero_lote: (d.numero_lote === undefined || d.numero_lote === '') ? null : d.numero_lote
        }));
        const cambios = audit.diffHoja(antes, {
          encabezado: enc,
          detalle: detNorm,
          estado: nuevoEstado || estadoActual
        });
        await audit.grabarCambios(client, {
          id,
          numeroHoja: numHojaUp || (antes.encabezado && antes.encabezado.numero_hoja) || null,
          usuario: user.name || user.email,
          email: user.email,
          rol: rolEditor
        }, cambios);
      }

      await client.query('COMMIT');
      // Si el usuario corrigió el consecutivo, ese pasa a ser el "último usado".
      const cfgConsUp = await getConfigConsecutivo();
      await actualizarUltimoConsecutivo(numHojaUp, cfgConsUp.prefijo, user, context);
      return json(200, { ok: true, id });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505' && String(e.constraint || '').toLowerCase().indexOf('numerohoja') >= 0)
        return json(400, { error: 'El consecutivo ' + numHojaUp + ' ya existe. Cambie el N\u00b0 de hoja.' });
      context.error(e);
      return json(500, { error: 'No se pudo actualizar la hoja de consumo', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* ============================================================
   Auditoría de cambios de la hoja de consumo
   ============================================================ */

// Fecha y hora en hora de Costa Rica, igual que el resto de los listados.
const FECHA_AUDIT = `to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

const SELECT_AUDIT = `SELECT Id AS id, IdHojaConsumo AS id_hoja, NumeroHoja AS numero_hoja,
              ${FECHA_AUDIT} AS fecha, Usuario AS usuario, UsuarioEmail AS usuario_email,
              Rol AS rol, Seccion AS seccion, Linea AS linea, Campo AS campo,
              ValorAnterior AS valor_anterior, ValorNuevo AS valor_nuevo
         FROM dbo.HojaConsumoAuditoria`;

/* GET /api/hojas/{id}/auditoria -> historial de UNA hoja (panel dentro de la hoja).
   Solo Bodega/Administrador: es la misma restricción con la que se audita. */
app.http('hoja-auditoria', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hojas/{id}/auditoria',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user)))
      return json(403, { error: 'No tiene permiso para ver la auditor\u00eda' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inv\u00e1lido' });
    try {
      const r = await query(`${SELECT_AUDIT} WHERE IdHojaConsumo=$1 ORDER BY Id DESC`, [id]);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el historial de cambios', detail: e.message });
    }
  }
});

/* GET /api/auditoria -> todos los cambios, el más reciente primero (pantalla global).
   `?limite=` acota el listado; por defecto 1000 filas para que el grid no se ahogue. */
app.http('auditoria-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'auditoria',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user)))
      return json(403, { error: 'No tiene permiso para ver la auditor\u00eda' });
    let limite = parseInt(request.query.get('limite') || '1000', 10);
    if (!Number.isFinite(limite) || limite <= 0) limite = 1000;
    if (limite > 5000) limite = 5000;
    try {
      const r = await query(`${SELECT_AUDIT} ORDER BY Id DESC LIMIT $1`, [limite]);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la auditor\u00eda', detail: e.message });
    }
  }
});

/* ============================================================
   Fotos de la hoja SELLADA (solo respaldo, no se procesan por OCR)
   ============================================================ */

/* Tope de fotos por hoja y peso máximo por foto. El frontend reduce a 2000px
   JPEG (~400 KB), así que 6 MB es holgura de sobra: el tope está para atajar
   una subida cruda, no para pelear con el caso normal. */
const SELLADA_MAX_POR_HOJA = 10;
const SELLADA_MAX_MB = 6;
// Solo imágenes. La lista es explícita: 'image/*' dejaría pasar cualquier cosa
// que el navegador etiquete como imagen, incluido un SVG (que puede traer script).
const SELLADA_TIPOS = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']);

// La foto sellada se sube ANTES de enviar la hoja: una vez enviada, el respaldo
// queda cerrado igual que el resto del documento.
const SELLADA_ESTADO_ABIERTO = 'Pendiente reposición';

const FECHA_SELLADA = `to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

/* GET /api/hojas/{id}/selladas -> listado SIN el contenido.
   Traer el base64 acá haría que abrir una hoja con 10 fotos bajara varios MB;
   el contenido se pide foto por foto, solo cuando el usuario la quiere ver.
   Lo ve cualquier rol autenticado. */
app.http('selladas-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hojas/{id}/selladas',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const h = await query(`SELECT Estado AS estado FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      if (!h.rows.length) return json(404, { error: 'La hoja no existe' });
      const abierta = h.rows[0].estado === SELLADA_ESTADO_ABIERTO;
      const rol = await getRole(user);
      const r = await query(
        `SELECT Id AS id, Nombre AS nombre, Tipo AS tipo, Bytes AS bytes,
                Usuario AS usuario, UsuarioEmail AS usuario_email, ${FECHA_SELLADA} AS fecha
           FROM dbo.HojaConsumoSellada WHERE IdHojaConsumo=$1 ORDER BY Id`, [id]);
      // El servidor decide quién puede borrar cada foto; el frontend solo pinta.
      const rows = r.rows.map(x => ({
        ...x,
        puede_eliminar: abierta && puedeSubir(rol) &&
          String(x.usuario_email || '').toLowerCase() === String(user.email || '').toLowerCase()
      }));
      return json(200, { puede_subir: abierta && puedeSubir(rol), maximo: SELLADA_MAX_POR_HOJA, fotos: rows });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener las fotos', detail: e.message });
    }
  }
});

/* GET /api/hojas/{id}/selladas/{sid}/contenido -> una foto (base64).
   Cualquier rol autenticado la puede ver. */
app.http('sellada-contenido', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hojas/{id}/selladas/{sid}/contenido',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const id = parseInt(request.params.id, 10);
    const sid = parseInt(request.params.sid, 10);
    if (!id || !sid) return json(400, { error: 'Id inválido' });
    try {
      const r = await query(
        `SELECT Nombre AS nombre, Tipo AS tipo, Contenido AS contenido
           FROM dbo.HojaConsumoSellada WHERE Id=$1 AND IdHojaConsumo=$2`, [sid, id]);
      if (!r.rows.length) return json(404, { error: 'La foto no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la foto', detail: e.message });
    }
  }
});

/* POST /api/hojas/{id}/selladas -> sube una foto. Body: { nombre, tipo, base64 }
   Solo Hospital/Administrador y solo mientras la hoja no se haya enviado. */
app.http('sellada-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'hojas/{id}/selladas',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol)) return json(403, { error: 'Solo el rol Hospital puede subir las fotos de la hoja sellada' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });

    const body = await request.json();
    const tipo = String((body && body.tipo) || '').toLowerCase().trim();
    const b64 = String((body && body.base64) || '');
    const nombre = String((body && body.nombre) || '').trim().slice(0, 260) || null;

    if (!b64) return json(400, { error: 'No llegó la imagen' });
    if (!SELLADA_TIPOS.has(tipo))
      return json(400, { error: 'Solo se admiten imágenes (JPG, PNG, WEBP, GIF o BMP). Recibido: ' + (tipo || 'sin tipo') });
    // 3 caracteres de base64 = 4 bytes; alcanza para el tope sin decodificar.
    const bytes = Math.floor(b64.length * 3 / 4);
    if (bytes > SELLADA_MAX_MB * 1024 * 1024)
      return json(400, { error: 'La imagen supera los ' + SELLADA_MAX_MB + ' MB' });

    try {
      const h = await query(`SELECT Estado AS estado FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      if (!h.rows.length) return json(404, { error: 'La hoja no existe' });
      if (h.rows[0].estado !== SELLADA_ESTADO_ABIERTO)
        return json(409, { error: 'La hoja ya fue enviada: las fotos de la hoja sellada se suben antes de enviarla' });

      const c = await query(`SELECT COUNT(*)::int AS n FROM dbo.HojaConsumoSellada WHERE IdHojaConsumo=$1`, [id]);
      if (c.rows[0].n >= SELLADA_MAX_POR_HOJA)
        return json(400, { error: 'Ya hay ' + SELLADA_MAX_POR_HOJA + ' fotos en esta hoja, el máximo permitido' });

      const r = await query(
        `INSERT INTO dbo.HojaConsumoSellada (IdHojaConsumo, Nombre, Tipo, Bytes, Contenido, Usuario, UsuarioEmail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING Id AS id, Nombre AS nombre, Tipo AS tipo, Bytes AS bytes, Usuario AS usuario, ${FECHA_SELLADA} AS fecha`,
        [id, nombre, tipo, bytes, b64, user.name || user.email, user.email]);
      return json(201, r.rows[0]);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo guardar la foto', detail: e.message });
    }
  }
});

/* DELETE /api/hojas/{id}/selladas/{sid} -> borra una foto.
   Solo la puede borrar QUIEN LA SUBIÓ, y solo mientras la hoja no se haya
   enviado. Ni el Administrador borra las de otro: si se necesita, la sube de
   nuevo quien corresponda. */
app.http('sellada-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'hojas/{id}/selladas/{sid}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol)) return json(403, { error: 'Su rol no puede eliminar fotos' });
    const id = parseInt(request.params.id, 10);
    const sid = parseInt(request.params.sid, 10);
    if (!id || !sid) return json(400, { error: 'Id inválido' });
    try {
      const h = await query(`SELECT Estado AS estado FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      if (!h.rows.length) return json(404, { error: 'La hoja no existe' });
      if (h.rows[0].estado !== SELLADA_ESTADO_ABIERTO)
        return json(409, { error: 'La hoja ya fue enviada: sus fotos no se pueden eliminar' });

      const f = await query(
        `SELECT UsuarioEmail AS email FROM dbo.HojaConsumoSellada WHERE Id=$1 AND IdHojaConsumo=$2`, [sid, id]);
      if (!f.rows.length) return json(404, { error: 'La foto no existe' });
      if (String(f.rows[0].email || '').toLowerCase() !== String(user.email || '').toLowerCase())
        return json(403, { error: 'Solo puede eliminar las fotos que subió usted' });

      await query(`DELETE FROM dbo.HojaConsumoSellada WHERE Id=$1 AND IdHojaConsumo=$2`, [sid, id]);
      return json(200, { ok: true });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo eliminar la foto', detail: e.message });
    }
  }
});

/* Eliminar una hoja en estado 'Pendiente reposición' (Hospital/Administrador).
   Solo se permite en ese estado: una hoja ya enviada no se borra.
   El detalle cae por ON DELETE CASCADE. */
app.http('hoja-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'hojas/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol)) return json(403, { error: 'No tiene permiso para eliminar hojas' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inv\u00e1lido' });
    try {
      const cur = await query(
        `SELECT Estado AS estado, CreadoPorEmail AS email FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      if (!cur.rows.length) return json(404, { error: 'La hoja no existe' });
      if (cur.rows[0].estado !== 'Pendiente reposici\u00f3n')
        return json(400, { error: 'Solo se pueden eliminar hojas pendientes de reposici\u00f3n' });
      // Hospital elimina solo las suyas; Administrador puede eliminar cualquiera.
      if (rol !== 'Administrador' && String(cur.rows[0].email || '').toLowerCase() !== user.email)
        return json(403, { error: 'Solo puede eliminar las hojas que usted cre\u00f3' });

      const r = await query(
        `DELETE FROM dbo.HojaConsumo WHERE Id=$1 AND Estado='Pendiente reposici\u00f3n' RETURNING Id`, [id]);
      if (!r.rowCount) return json(400, { error: 'La hoja ya no est\u00e1 pendiente de reposici\u00f3n' });
      return json(200, { ok: true, id });
    } catch (e) {
      context.error(e);
      // FK_HojaConsumo_Origen: otra hoja la referencia como origen del reemplazo.
      if (e.code === '23503')
        return json(400, { error: 'No se puede eliminar: otra hoja la referencia como origen.' });
      return json(500, { error: 'No se pudo eliminar la hoja', detail: e.message });
    }
  }
});

/* Marcar un reemplazo/corrección como 'Resuelto' (Bodega/Administrador). */
app.http('hoja-resolver', {
  methods: ['POST'], authLevel: 'anonymous', route: 'hojas/{id}/resolver',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para resolver reemplazos' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const r = await query(`UPDATE dbo.HojaConsumo SET Estado='Resuelto' WHERE Id=$1 AND EsReemplazo=TRUE RETURNING Id`, [id]);
      if (!r.rowCount) return json(400, { error: 'La hoja no existe o no es un reemplazo/corrección' });
      return json(200, { ok: true });
    } catch (e) { context.error(e); return json(500, { error: 'No se pudo resolver', detail: e.message }); }
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
      const r = await query(`SELECT Estado AS estado, COUNT(*) AS n FROM dbo.HojaConsumo WHERE Estado <> 'Pendiente reposición' AND EsReemplazo = FALSE GROUP BY Estado`);
      const out = {};
      r.rows.forEach(x => { out[x.estado] = parseInt(x.n, 10); });
      return json(200, out);
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener resumen', detail: e.message }); }
  }
});

/* ============================================================
   Cirugías programadas (calendario) — Hospital / Administrador
   ============================================================ */
const CIR_FIELDS = [
  ['fecha_cirugia', 'FechaCirugia'], ['hora_inicio', 'HoraInicio'], ['hora_fin', 'HoraFin'], ['tiempo', 'Tiempo'],
  ['ubicacion', 'Ubicacion'], ['identificacion', 'Identificacion'], ['paciente', 'Paciente'], ['regimen', 'Regimen'],
  ['fecha_accidente', 'FechaAccidente'], ['numero_caso', 'NumeroCaso'], ['cirugia', 'Cirugia'], ['cirujano', 'Cirujano'],
  ['observacion', 'Observacion'], ['requerimiento', 'RequerimientoQuirurgico']
];
const CIR_DATE_KEYS = new Set(['fecha_cirugia', 'fecha_accidente']);
const CIR_ESTADOS = ['Programada', 'Realizada', 'Cancelada'];
const CIR_SELECT = `SELECT Id AS id, to_char(FechaCirugia,'YYYY-MM-DD') AS fecha_cirugia, HoraInicio AS hora_inicio,
  HoraFin AS hora_fin, Tiempo AS tiempo, Ubicacion AS ubicacion, Identificacion AS identificacion, Paciente AS paciente,
  Regimen AS regimen, to_char(FechaAccidente,'YYYY-MM-DD') AS fecha_accidente, NumeroCaso AS numero_caso,
  Cirugia AS cirugia, Cirujano AS cirujano, Observacion AS observacion, RequerimientoQuirurgico AS requerimiento,
  Estado AS estado FROM dbo.Cirugia`;

/* GET /api/cirugias?desde=YYYY-MM-DD&hasta=YYYY-MM-DD -> cirugías en el rango (para el calendario). */
app.http('cirugias-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'cirugias',
  handler: async (request, context) => {
    const user = getUser(request); if (!user) return json(401, { error: 'No autenticado' });
    try {
      const desde = request.query.get('desde'), hasta = request.query.get('hasta');
      const ok = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s);
      let where = '', params = [];
      if (ok(desde) && ok(hasta)) { where = `WHERE FechaCirugia BETWEEN $1 AND $2`; params = [desde, hasta]; }
      const r = await query(`${CIR_SELECT} ${where} ORDER BY FechaCirugia, HoraInicio, Id`, params);
      return json(200, r.rows);
    } catch (e) { context.error(e); return json(500, { error: 'Error al listar cirugías', detail: e.message }); }
  }
});

/* GET /api/cirugias/{id} -> una cirugía + sus hojas de consumo. */
app.http('cirugia-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'cirugias/{id}',
  handler: async (request, context) => {
    const user = getUser(request); if (!user) return json(401, { error: 'No autenticado' });
    try {
      const id = parseInt(request.params.id, 10);
      const r = await query(`${CIR_SELECT} WHERE Id=$1`, [id]);
      if (!r.rows.length) return json(404, { error: 'No encontrada' });
      const h = await query(
        `SELECT Id AS id, NumeroHoja AS numero_hoja, Estado AS estado, EsReemplazo AS es_reemplazo
         FROM dbo.HojaConsumo WHERE CirugiaId=$1 ORDER BY EsReemplazo, Id`, [id]);
      return json(200, { ...r.rows[0], hojas: h.rows });
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener la cirugía', detail: e.message }); }
  }
});

/* POST /api/cirugias -> programar una cirugía (Hospital/Administrador). */
app.http('cirugia-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'cirugias',
  handler: async (request, context) => {
    const user = getUser(request); if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para programar cirugías' });
    const body = await request.json();
    const cols = [], vals = [], ph = []; let i = 0;
    for (const [k, col] of CIR_FIELDS) {
      i++; cols.push(col); ph.push('$' + i);
      let v = body[k]; v = (v === undefined || v === null || v === '') ? null : v;
      if (CIR_DATE_KEYS.has(k) && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = null;
      vals.push(v);
    }
    cols.push('Estado'); vals.push(CIR_ESTADOS.includes(body.estado) ? body.estado : 'Programada'); ph.push('$' + (++i));
    cols.push('CreadoPor'); vals.push(user.name || user.email); ph.push('$' + (++i));
    cols.push('CreadoPorEmail'); vals.push(user.email); ph.push('$' + (++i));
    try {
      const r = await query(`INSERT INTO dbo.Cirugia (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING Id`, vals);
      return json(201, { ok: true, id: r.rows[0].id });
    } catch (e) { context.error(e); return json(500, { error: 'No se pudo programar la cirugía', detail: e.message }); }
  }
});

/* PUT /api/cirugias/{id} -> editar una cirugía (incluye estado). */
app.http('cirugia-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'cirugias/{id}',
  handler: async (request, context) => {
    const user = getUser(request); if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para editar cirugías' });
    const id = parseInt(request.params.id, 10); if (!id) return json(400, { error: 'Id inválido' });
    const body = await request.json();
    const sets = [], vals = []; let i = 0;
    for (const [k, col] of CIR_FIELDS) {
      i++; let v = body[k]; v = (v === undefined || v === null || v === '') ? null : v;
      if (CIR_DATE_KEYS.has(k) && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = null;
      sets.push(`${col}=$${i}`); vals.push(v);
    }
    if (CIR_ESTADOS.includes(body.estado)) { i++; sets.push(`Estado=$${i}`); vals.push(body.estado); }
    const idPh = '$' + (++i); vals.push(id);
    try {
      const up = await query(`UPDATE dbo.Cirugia SET ${sets.join(',')} WHERE Id=${idPh}`, vals);
      if (!up.rowCount) return json(404, { error: 'No encontrada' });
      return json(200, { ok: true });
    } catch (e) { context.error(e); return json(500, { error: 'No se pudo actualizar la cirugía', detail: e.message }); }
  }
});

/* POST /api/cirugias/importar -> alta/actualización masiva (Excel del INS).
   Body: { cirugias: [ {campos...} ] }. Upsert por NumeroCaso cuando viene. */
app.http('cirugias-importar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'cirugias/importar',
  handler: async (request, context) => {
    const user = getUser(request); if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para importar cirugías' });
    const body = await request.json();
    const arr = Array.isArray(body.cirugias) ? body.cirugias : [];
    const okDate = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    let creadas = 0, actualizadas = 0, omitidas = 0;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      for (const c of arr) {
        const fecha = okDate(c.fecha_cirugia) ? c.fecha_cirugia : null;
        if (!fecha) { omitidas++; continue; }
        const facc = okDate(c.fecha_accidente) ? c.fecha_accidente : null;
        const caso = (c.numero_caso != null && String(c.numero_caso).trim() !== '') ? String(c.numero_caso).trim() : null;
        const vals = [fecha, c.hora_inicio || null, c.tiempo || null, c.ubicacion || null, c.identificacion || null,
          c.paciente || null, c.regimen || null, facc, caso, c.cirugia || null, c.cirujano || null,
          c.observacion || null, c.requerimiento || null];
        let upd = null;
        if (caso) {
          upd = await client.query(
            `UPDATE dbo.Cirugia SET FechaCirugia=$1,HoraInicio=$2,Tiempo=$3,Ubicacion=$4,Identificacion=$5,
               Paciente=$6,Regimen=$7,FechaAccidente=$8,Cirugia=$10,Cirujano=$11,Observacion=$12,RequerimientoQuirurgico=$13
             WHERE NumeroCaso=$9`, vals);
        }
        if (upd && upd.rowCount) { actualizadas += upd.rowCount; continue; }
        await client.query(
          `INSERT INTO dbo.Cirugia (FechaCirugia,HoraInicio,Tiempo,Ubicacion,Identificacion,Paciente,Regimen,
             FechaAccidente,NumeroCaso,Cirugia,Cirujano,Observacion,RequerimientoQuirurgico,Estado,CreadoPor,CreadoPorEmail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Programada',$14,$15)`,
          [...vals, user.name || user.email, user.email]);
        creadas++;
      }
      await client.query('COMMIT');
      return json(200, { ok: true, creadas, actualizadas, omitidas });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo importar', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* POST /api/cirugias/ingest -> alta/actualización de cirugías desde un sistema EXTERNO
   (ej. Power Automate). NO usa el login AAD: se autentica con una clave en el header
   'x-api-key' que debe coincidir con la App Setting CIRUGIAS_INGEST_KEY. La ruta está
   habilitada como anónima en staticwebapp.config.json (solo esta), la seguridad la da
   la clave. Devuelve 403 (no 401) en clave inválida para que el SWA no lo redirija al login.
   Body admitido: un objeto de cirugía, o { "cirugias": [ ... ] }, o un array [ ... ].
   Campos por registro (snake_case): fecha_cirugia (YYYY-MM-DD, obligatoria), hora_inicio,
   hora_fin, tiempo, ubicacion, identificacion, paciente, regimen, fecha_accidente,
   numero_caso, cirugia, cirujano, observacion, requerimiento, estado.
   Deduplica por numero_caso (si viene y ya existe, ACTUALIZA; si no, INSERTA). */
app.http('cirugias-ingest', {
  methods: ['POST'], authLevel: 'anonymous', route: 'cirugias/ingest',
  handler: async (request, context) => {
    const key = process.env.CIRUGIAS_INGEST_KEY;
    if (!key) return json(500, { error: 'Falta configurar CIRUGIAS_INGEST_KEY en el servidor (Application settings del Static Web App).' });
    const sent = request.headers.get('x-api-key') || '';
    if (sent !== key) return json(403, { error: 'Clave de acceso inválida o ausente (header x-api-key).' });

    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'El cuerpo no es JSON válido.' }); }
    let arr;
    if (Array.isArray(body)) arr = body;
    else if (body && Array.isArray(body.cirugias)) arr = body.cirugias;
    else if (body && typeof body === 'object') arr = [body];
    else arr = [];

    const okDate = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    let creadas = 0, actualizadas = 0, omitidas = 0;
    const client = await getClient();
    try {
      await client.query('BEGIN');
      for (const c of arr) {
        const fecha = okDate(c.fecha_cirugia) ? c.fecha_cirugia : null;
        if (!fecha) { omitidas++; continue; }  // sin fecha válida no entra al calendario
        const facc = okDate(c.fecha_accidente) ? c.fecha_accidente : null;
        const caso = (c.numero_caso != null && String(c.numero_caso).trim() !== '') ? String(c.numero_caso).trim() : null;
        const estado = CIR_ESTADOS.includes(c.estado) ? c.estado : 'Programada';
        const vals = [fecha, c.hora_inicio || null, c.tiempo || null, c.ubicacion || null, c.identificacion || null,
          c.paciente || null, c.regimen || null, facc, caso, c.cirugia || null, c.cirujano || null,
          c.observacion || null, c.requerimiento || null];
        let upd = null;
        if (caso) {
          upd = await client.query(
            `UPDATE dbo.Cirugia SET FechaCirugia=$1,HoraInicio=$2,Tiempo=$3,Ubicacion=$4,Identificacion=$5,
               Paciente=$6,Regimen=$7,FechaAccidente=$8,Cirugia=$10,Cirujano=$11,Observacion=$12,RequerimientoQuirurgico=$13
             WHERE NumeroCaso=$9`, vals);
        }
        if (upd && upd.rowCount) { actualizadas += upd.rowCount; continue; }
        await client.query(
          `INSERT INTO dbo.Cirugia (FechaCirugia,HoraInicio,Tiempo,Ubicacion,Identificacion,Paciente,Regimen,
             FechaAccidente,NumeroCaso,Cirugia,Cirujano,Observacion,RequerimientoQuirurgico,Estado,CreadoPor,CreadoPorEmail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PowerAutomate','powerautomate')`,
          [...vals, estado]);
        creadas++;
      }
      await client.query('COMMIT');
      return json(200, { ok: true, creadas, actualizadas, omitidas });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo ingestar las cirugías', detail: e.message });
    } finally {
      client.release();
    }
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
      // Panel Prefijo / Consecutivo (fila única).
      const c = await query(
        `SELECT Prefijo AS prefijo, Consecutivo AS consecutivo FROM dbo.ConfiguracionConsecutivo WHERE Id = 1`);
      out.consecutivo = c.rows.length
        ? { prefijo: c.rows[0].prefijo || '', consecutivo: (c.rows[0].consecutivo != null ? String(c.rows[0].consecutivo) : '') }
        : { prefijo: '', consecutivo: '' };
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

    // Panel Prefijo / Consecutivo: prefijo alfanumérico, consecutivo solo dígitos.
    const cons = body.consecutivo || {};
    const prefijo = norm(cons.prefijo);
    const consecStr = norm(cons.consecutivo);
    if (prefijo !== null && !/^[A-Za-z0-9]+$/.test(prefijo))
      return json(400, { error: 'El prefijo solo admite letras y n\u00fameros, sin espacios ni s\u00edmbolos' });
    if (prefijo !== null && prefijo.length > 20)
      return json(400, { error: 'El prefijo no puede superar los 20 caracteres' });
    if (consecStr !== null && !/^\d+$/.test(consecStr))
      return json(400, { error: 'El consecutivo solo admite n\u00fameros enteros' });
    if (consecStr !== null && consecStr.length > 18)
      return json(400, { error: 'El consecutivo es demasiado grande' });
    const consecutivo = (consecStr === null) ? null : consecStr;

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
      await client.query(
        `INSERT INTO dbo.ConfiguracionConsecutivo (Id, Prefijo, Consecutivo, ModificadoPor, FechaModificacion)
         VALUES (1,$1,$2,$3,(now() at time zone 'utc'))
         ON CONFLICT (Id) DO UPDATE
            SET Prefijo=EXCLUDED.Prefijo, Consecutivo=EXCLUDED.Consecutivo,
                ModificadoPor=EXCLUDED.ModificadoPor, FechaModificacion=EXCLUDED.FechaModificacion`,
        [prefijo, consecutivo, user.name || user.email]);
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
      // Los reemplazos/correcciones se resuelven en Bodega; no se envían a Dynamics.
      const flag = await query(`SELECT EsReemplazo AS es FROM dbo.HojaConsumo WHERE Id=$1`, [hojaId]);
      if (flag.rows.length && flag.rows[0].es) return json(400, { error: 'Los reemplazos/correcciones no se envían a Dynamics; se resuelven en su bandeja.' });
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
         (p.CantidadTotal - p.CantidadEnviada) AS pendiente, p.Estado AS estado,
         EXISTS(SELECT 1 FROM dbo.PedidoPendienteEnvio e WHERE e.PedidoPendienteId = p.Id AND e.Estado = 'Pendiente') AS tiene_pendientes
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
        `SELECT Id AS id, CantidadEnviada AS cantidad_enviada, Lote AS lote, Estado AS estado,
                NumeroTR AS numero_tr, Usuario AS usuario, ${PP_FECHA_LOCAL} AS fecha
         FROM dbo.PedidoPendienteEnvio WHERE PedidoPendienteId=$1 ORDER BY FechaHora, Id`, [id]);
      return json(200, { ...p.rows[0], envios: e.rows });
    } catch (e) { context.error(e); return json(500, { error: 'Error al obtener el pedido', detail: e.message }); }
  }
});

// Recalcula el acumulado del pedido a partir de sus envíos. Cuentan 'Pendiente' y
// 'Procesado'; 'Error' no cuenta. Debe llamarse dentro de una transacción abierta.
async function recalcCantidadEnviada(client, pedidoId) {
  await client.query(
    `UPDATE dbo.PedidoPendiente
        SET CantidadEnviada = COALESCE((
              SELECT SUM(CantidadEnviada) FROM dbo.PedidoPendienteEnvio
               WHERE PedidoPendienteId=$1 AND Estado IN ('Pendiente','Procesado')), 0)
      WHERE Id=$1`, [pedidoId]);
}

/* PUT /api/pedidos/{id}/envios -> GUARDA el conjunto de líneas en estado 'Pendiente'.
   Body: { envios: [{ id?, cantidad, lote }, ...] }  (solo las Pendientes; las nuevas sin id).
   - Lote obligatorio y cantidad entera > 0 en cada línea.
   - La suma de Pendientes + lo ya 'Procesado' no puede superar CantidadTotal.
   - Reemplaza el conjunto Pendiente: conserva las que traen id, inserta las nuevas y
     borra las Pendientes que ya no vengan (ediciones/altas/bajas en una sola operación).
   El Estado y el NumeroTR NUNCA los fija el usuario: las nuevas quedan 'Pendiente' y TR en blanco. */
app.http('pedido-envios-guardar', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'pedidos/{id}/envios',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para registrar envíos' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    const body = await request.json();
    const envios = Array.isArray(body.envios) ? body.envios : [];

    // Validación de cada línea.
    const limpias = [];
    for (const e of envios) {
      const cantidad = toInt(e && e.cantidad);
      const lote = String((e && e.lote != null) ? e.lote : '').trim();
      if (!cantidad || cantidad <= 0) return json(400, { error: 'La cantidad de cada línea debe ser un entero mayor a cero' });
      // El Lote es OPCIONAL: si no viene, se guarda vacío.
      limpias.push({ id: (e && e.id) ? parseInt(e.id, 10) : null, cantidad, lote });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const p = await client.query(`SELECT CantidadTotal AS cantidad_total, ReposicionAnaquel AS reposicion FROM dbo.PedidoPendiente WHERE Id=$1 FOR UPDATE`, [id]);
      if (!p.rows.length) { await client.query('ROLLBACK'); return json(404, { error: 'Pedido no encontrado' }); }
      // El máximo a enviar es lo consumido menos lo que ya repone el anaquel: CantidadTotal - ReposicionAnaquel.
      const tope = Math.max(0, (Number(p.rows[0].cantidad_total) || 0) - (Number(p.rows[0].reposicion) || 0));
      // Lo ya 'Procesado' no se puede editar y sigue contando contra el tope.
      const proc = await client.query(
        `SELECT COALESCE(SUM(CantidadEnviada),0) AS s FROM dbo.PedidoPendienteEnvio WHERE PedidoPendienteId=$1 AND Estado='Procesado'`, [id]);
      const yaProcesado = Number(proc.rows[0].s) || 0;
      const sumaPendientes = limpias.reduce((a, x) => a + x.cantidad, 0);
      if (yaProcesado + sumaPendientes > tope) {
        await client.query('ROLLBACK');
        return json(400, { error: `El total a enviar (${yaProcesado + sumaPendientes}) supera el máximo por enviar del pedido (${tope}).` });
      }

      // Reemplaza el conjunto Pendiente.
      const idsSubmit = limpias.filter(x => x.id).map(x => x.id);
      if (idsSubmit.length) {
        await client.query(
          `DELETE FROM dbo.PedidoPendienteEnvio WHERE PedidoPendienteId=$1 AND Estado='Pendiente' AND Id <> ALL($2::int[])`, [id, idsSubmit]);
      } else {
        await client.query(`DELETE FROM dbo.PedidoPendienteEnvio WHERE PedidoPendienteId=$1 AND Estado='Pendiente'`, [id]);
      }
      for (const x of limpias) {
        if (x.id) {
          // Solo se pueden editar líneas que siguen 'Pendiente' (nunca 'Procesado'/'Error').
          await client.query(
            `UPDATE dbo.PedidoPendienteEnvio SET CantidadEnviada=$2, Lote=$3
              WHERE Id=$1 AND PedidoPendienteId=$4 AND Estado='Pendiente'`, [x.id, x.cantidad, x.lote, id]);
        } else {
          await client.query(
            `INSERT INTO dbo.PedidoPendienteEnvio (PedidoPendienteId, CantidadEnviada, Lote, Estado, Usuario, FechaHora)
             VALUES ($1,$2,$3,'Pendiente',$4,(now() at time zone 'utc'))`, [id, x.cantidad, x.lote, user.name || user.email]);
        }
      }
      await recalcCantidadEnviada(client, id);
      await client.query('COMMIT');
      return json(200, { ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudieron guardar los envíos', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* DELETE /api/pedidos/{id}/envios/pendientes -> CANCELAR: borra todas las líneas en
   estado 'Pendiente' del pedido (las 'Procesado'/'Error' no se tocan) y recalcula. */
app.http('pedido-envios-cancelar', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'pedidos/{id}/envios/pendientes',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para cancelar envíos' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM dbo.PedidoPendienteEnvio WHERE PedidoPendienteId=$1 AND Estado='Pendiente'`, [id]);
      await recalcCantidadEnviada(client, id);
      await client.query('COMMIT');
      return json(200, { ok: true });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo cancelar', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* POST /api/pedidos/{id}/dynamics -> crea el trabajo en Dynamics (flujo "Nutricare al
   Anaquel - Pedido Pendiente") con las líneas del grid en estado 'Pendiente'.
   Consecutivo = "{HojaConsumoId}-{PedidoId}". Detalle: una línea por cada envío
   'Pendiente' (Lote tal cual, puede ir vacío; ReposicionAnaquel = cantidad de esa línea;
   IdProducto/Ubicacion/Descripcion del encabezado del producto).
   Con la respuesta: NumeroTR = IdProceso del primer registro y Estado = 'Procesado' si el
   flujo devolvió "Trabajo Creado", o 'Error' en cualquier otro caso. */
app.http('pedido-dynamics', {
  methods: ['POST'], authLevel: 'anonymous', route: 'pedidos/{id}/dynamics',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para crear trabajos en Dynamics' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      // Encabezado del pedido (producto).
      const p = await query(
        `SELECT p.Id AS id, p.HojaConsumoId AS hoja_id, h.Consecutivo AS consecutivo,
                p.IdProducto AS id_producto, p.Ubicacion AS ubicacion,
                p.Descripcion AS descripcion, p.CantidadTotal AS cantidad_total
           FROM dbo.PedidoPendiente p JOIN dbo.HojaConsumo h ON h.Id = p.HojaConsumoId
          WHERE p.Id=$1`, [id]);
      if (!p.rows.length) return json(404, { error: 'Pedido no encontrado' });
      const cab = p.rows[0];

      // Líneas del grid en estado 'Pendiente' (de aquí salen Lote y ReposicionAnaquel).
      const pend = await query(
        `SELECT Id AS id, CantidadEnviada AS cantidad, Lote AS lote
           FROM dbo.PedidoPendienteEnvio
          WHERE PedidoPendienteId=$1 AND Estado='Pendiente' ORDER BY Id`, [id]);
      if (!pend.rows.length) return json(400, { error: 'No hay líneas en estado Pendiente para crear el trabajo' });

      // Configuración (áreas / origen / destino).
      const cfg = await query(`SELECT Area AS area, Origen AS origen, Destino AS destino FROM dbo.Configuracion ORDER BY Area`);
      const Configuracion = cfg.rows.map(c => ({ area: c.area, origen: c.origen || '', destino: c.destino || '' }));

      // Detalle: una línea por cada envío Pendiente.
      const Detalle = pend.rows.map(e => ({
        IdProducto: cab.id_producto || '',
        Lote: e.lote || '',
        CantidadTotal: (e.cantidad == null ? 0 : e.cantidad),  // = "Cantidad" que el usuario puso en la línea del grid
        ReposicionAnaquel: (e.cantidad == null ? 0 : e.cantidad),
        Ubicacion: '',
        Descripcion: cab.descripcion || ''
      }));

      // Consecutivo = "{Consecutivo de negocio de la hoja}-{Id del pedido}" (ej. 3019-5).
      const consecHoja = (cab.consecutivo != null) ? cab.consecutivo : cab.hoja_id;
      const payload = { Consecutivo: `${consecHoja}-${cab.id}`, Configuracion, Detalle };

      // Dispara el flujo. Usa la App Setting DYNAMICS_PP_API_URL (URL completa con firma SAS).
      const r = await iniciarDynamics(payload, 'DYNAMICS_PP_API_URL');
      if (r.estado === 'en_proceso') {
        // El flujo sigue trabajando (patrón asíncrono 202). Las líneas quedan 'Pendiente';
        // se informa al cliente para reintentar cuando el flujo termine.
        return json(202, { done: false });
      }

      const arr = Array.isArray(r.data) ? r.data : [];
      const first = arr[0] || {};
      const idProceso = (first.IdProceso != null) ? String(first.IdProceso) : null;
      const estadoResp = String(first.Estado || '');
      const nuevoEstado = /trabajo\s*creado/i.test(estadoResp) ? 'Procesado' : 'Error';

      // Actualiza las líneas Pendientes de este pedido con el N° TR y el nuevo estado.
      const client = await getClient();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE dbo.PedidoPendienteEnvio SET NumeroTR=$2, Estado=$3
            WHERE PedidoPendienteId=$1 AND Estado='Pendiente'`, [id, idProceso, nuevoEstado]);
        await recalcCantidadEnviada(client, id);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }

      return json(200, { ok: true, estado: nuevoEstado, idProceso, proceso: first.Proceso || null, estadoResp });
    } catch (e) {
      context.error(e);
      return json(502, { error: 'No se pudo crear el trabajo en Dynamics', detail: e.message });
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
      // Marca los usuarios protegidos para que el frontend bloquee el cambio de rol.
      const rows = r.rows.map(x => ({ ...x, protegido: esProtegido(x.email) }));
      return json(200, rows);
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
      // Usuario protegido: su rol no se puede cambiar (defensa en profundidad, además del bloqueo en el frontend).
      if (esProtegido(email)) return json(403, { error: 'Este usuario está protegido: su rol no se puede cambiar.' });
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
