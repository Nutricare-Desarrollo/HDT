const { app } = require('@azure/functions');
const { query, getClient } = require('./db');
const { analyzeLayout, parseLayout, toInt } = require('./layout');
const audit = require('./auditoria');
const { getCatalogo, getMapa, normCod } = require('./productos');
const { getLotes } = require('./lotes');
const { iniciarDynamics, consultarDynamics } = require('./dynamics');
const { notificar, cuentasDe, urlSolicitud } = require('./notificar');
const bitacora = require('./bitacora');

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

// Nota libre que escribe Hospital sobre la línea. Opcional: vacío se guarda
// como NULL. Se recorta a 150 (el ancho de la columna) en vez de dejar que el
// INSERT falle con 500: el formulario ya limita, pero la API no puede confiar
// en que todo lo que le llega paso por el formulario.
const DESC_ADIC_MAX = 150;
const descAdicional = (d) => {
  const v = (d && d.descripcion_adicional != null) ? String(d.descripcion_adicional).trim() : '';
  return v === '' ? null : v.slice(0, DESC_ADIC_MAX);
};

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
   Bitacora: se envuelve app.http UNA vez, aca, antes de que se registre
   cualquier endpoint. Desde este punto todo lo que no sea GET queda en la
   bitacora sin que haya que acordarse de llamarla en cada handler.
   Va despues de getUser y getRole porque son sus dependencias, y antes del
   primer app.http porque si no, los de arriba quedarian sin envolver.
   ============================================================ */
const appHttp = app.http.bind(app);
app.http = (nombre, cfg) => appHttp(nombre, bitacora.envolver(cfg, { getUser, getRole, query }));

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
      /* Se le pega el CODIGO SIMA a cada producto. Va acá y no en los endpoints
         de la hoja porque el imprimible lo necesita en los TRES caminos que lo
         generan -el wizard, la vista de Bodega y la de Hospital- y este
         catálogo ya lo carga el navegador en todos los roles, igual que la
         descripción que usa catDesc(). Con esto no hay que tocar ninguna
         consulta de hojas ni preguntarse quién puede ver qué: el código Sima
         va impreso en el documento oficial, así que lo ve quien lo imprima.

         SOLO EL CODIGO. El precio y los demás campos Sima NO se agregan: esos
         son de la pantalla de Mantenimiento, que es solo Bodega/Administrador.

         Si la consulta falla se devuelve el catálogo SIN el código Sima en vez
         de dar error: este endpoint es el que valida los códigos en todas las
         pantallas, y tumbarlo por un dato de impresión sería mucho peor que
         imprimir una columna vacía. */
      let sima = new Map();
      try {
        const r = await query(
          `SELECT ProductoCodigo AS cod, CodigoSima AS sima FROM cat.ProductoSima
            WHERE CodigoSima IS NOT NULL AND BTRIM(CodigoSima) <> ''`);
        sima = new Map(r.rows.map((x) => [normCod(x.cod), x.sima]));
      } catch (e) {
        context.warn('No se pudieron leer los códigos Sima: ' + e.message);
      }
      const conSima = (data || []).map((p) => ({ ...p, codigo_sima: sima.get(normCod(p.codigo)) || '' }));
      return json(200, conSima);
    } catch (e) {
      context.error(e);
      return json(502, { error: 'No se pudo obtener el catálogo de productos', detail: e.message });
    }
  }
});

/* ============================================================
   Códigos Sima del catálogo  (solo Bodega / Administrador)
   ------------------------------------------------------------
   El catálogo de productos es EXTERNO -lo sirve PRODUCTOS_API_URL- así que los
   seis campos Sima viven en cat.ProductoSima, indexados por el código de
   producto, y se unen al catálogo al listarlos. Por eso:

     · NO SE PUEDEN AGREGAR PRODUCTOS. Las filas del grid las manda el
       catálogo. El PUT rechaza con 404 un código que el catálogo no tiene, y
       la importación lo descarta. La regla está acá y no solo en la pantalla.

     · EDITAR e IMPORTAR tienen semánticas DISTINTAS para el campo vacío, a
       propósito:
         - En el PUT (el formulario) el vacío BORRA. El usuario ve los seis
           campos con su valor actual; si limpia uno y guarda, es porque quiere
           dejarlo vacío. Si el vacío no borrara, un valor mal cargado no se
           podría quitar nunca.
         - En la importación el vacío NO TOCA NADA. Es lo pedido: los seis son
           opcionales, y una celda en blanco significa «de este campo no sé
           nada», no «bórralo». Así se puede subir un archivo que solo trae
           precios sin perder los códigos ya cargados.
   ============================================================ */

/* Fecha local de Costa Rica, como en los otros listados. Se define ACA y no
   se reusa FECHA_VALID: esa nombra la columna FechaHora y esta tabla usa
   FechaModificacion. */
const FECHA_SIMA = `to_char((FechaModificacion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

/* Los seis campos, con su columna. El orden es el del grid. */
const SIMA_CAMPOS = [
  ['codigo_sima', 'CodigoSima'], ['descripcion_sima', 'DescripcionSima'],
  ['linea_sima', 'LineaSima'], ['partida_sima', 'PartidaSima'],
  ['renglon_sima', 'RenglonSima'], ['precio_sima', 'PrecioSima']
];
const SIMA_SELECT = `SELECT ProductoCodigo AS producto_codigo, CodigoSima AS codigo_sima,
       DescripcionSima AS descripcion_sima, LineaSima AS linea_sima,
       PartidaSima AS partida_sima, RenglonSima AS renglon_sima,
       PrecioSima::float8 AS precio_sima, ModificadoPor AS modificado_por,
       ${FECHA_SIMA} AS fecha_modificacion
  FROM cat.ProductoSima`;

/* Texto o null. `max` recorta en vez de rechazar: un renglón dos caracteres
   más largo no vale perder la fila entera de una importación de 200. */
function simaTexto(v, max) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

/* El precio. Devuelve { ok, valor } y no un número pelado, porque hay que
   distinguir «no vino» de «vino mal escrito»: lo primero se ignora, lo segundo
   tiene que avisarse.

   ACEPTA COMA DECIMAL. En los datos de origen hay precios con punto
   (234.468571428571) y al menos uno con coma (62,5344444444444). Un
   parseFloat directo leería ese último como 62 y guardaría un precio 55 veces
   más chico, sin avisar. También se quitan los separadores de miles y los
   símbolos de moneda, que es lo que aparece cuando el dato pasó por Excel. */
function simaPrecio(v) {
  if (v == null || String(v).trim() === '') return { ok: true, valor: null };
  let t = String(v).trim().replace(/[\s ]/g, '').replace(/^[₡$]/, '');
  /* Con punto Y coma, el ÚLTIMO separador es el decimal y el otro es de miles:
     «1.234,56» y «1,234.56» son el mismo número. */
  const iPunto = t.lastIndexOf('.'), iComa = t.lastIndexOf(',');
  if (iPunto >= 0 && iComa >= 0) {
    const dec = Math.max(iPunto, iComa);
    t = t.slice(0, dec).replace(/[.,]/g, '') + '.' + t.slice(dec + 1);
  } else if (iComa >= 0) {
    t = t.replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { ok: false, valor: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return { ok: false, valor: null };
  return { ok: true, valor: n };
}

/* GET /api/productos/sima -> el catálogo con sus campos Sima. */
app.http('productos-sima-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'productos/sima',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega/Administrador' });
    try {
      const [cat, r] = await Promise.all([getCatalogo(false), query(SIMA_SELECT)]);
      const porCod = new Map(r.rows.map((x) => [normCod(x.producto_codigo), x]));
      /* Se recorre el CATALOGO, no la tabla: la pantalla lista todos los
         productos, con los campos Sima vacíos en los que no tienen. Es lo que
         permite completar uno nuevo sin poder agregar productos. */
      const filas = (cat || []).map((p) => {
        const s = porCod.get(normCod(p.codigo)) || {};
        return {
          codigo: p.codigo, descripcion: p.descripcion || '',
          codigo_sima: s.codigo_sima || '', descripcion_sima: s.descripcion_sima || '',
          linea_sima: s.linea_sima || '', partida_sima: s.partida_sima || '',
          renglon_sima: s.renglon_sima || '',
          precio_sima: (s.precio_sima == null ? '' : s.precio_sima),
          modificado_por: s.modificado_por || '', fecha_modificacion: s.fecha_modificacion || ''
        };
      });
      /* Filas de la tabla cuyo producto ya no está en el catálogo. No se
         muestran -no son productos- pero el conteo se informa para que no
         queden invisibles para siempre. */
      const huerfanas = r.rows.filter((x) => !(cat || []).some((p) => normCod(p.codigo) === normCod(x.producto_codigo))).length;
      return json(200, { productos: filas, con_sima: r.rowCount, huerfanas });
    } catch (e) {
      context.error(e);
      return json(502, { error: 'No se pudo obtener el catálogo con los códigos Sima', detail: e.message });
    }
  }
});

/* PUT /api/productos/sima/{codigo} -> graba los seis campos de UN producto.
   El vacío borra: ver la nota de arriba. */
app.http('productos-sima-save', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'productos/sima/{codigo}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar los códigos Sima' });
    const cod = normCod(decodeURIComponent(request.params.codigo || ''));
    if (!cod) return json(400, { error: 'Código de producto inválido' });
    try {
      /* El producto tiene que existir en el catálogo. Es el candado del «no
         puede agregar productos», y va en el servidor. Si el catálogo no
         responde se rechaza en vez de dejar pasar: crear una fila para un
         código inventado es justo lo que hay que evitar. */
      const mapa = await getMapa();
      if (!mapa || !mapa.size) return json(503, { error: 'El catálogo de productos no está disponible; intente de nuevo en un momento' });
      if (!mapa.has(cod)) return json(404, { error: 'El código ' + cod + ' no está en el catálogo de productos' });

      const b = await request.json().catch(() => ({}));
      const pre = simaPrecio(b.precio_sima);
      if (!pre.ok) return json(400, { error: 'El precio «' + b.precio_sima + '» no es un número válido' });
      const vals = [cod, simaTexto(b.codigo_sima, 60), simaTexto(b.descripcion_sima, 600),
        simaTexto(b.linea_sima, 30), simaTexto(b.partida_sima, 300), simaTexto(b.renglon_sima, 300),
        pre.valor, user.name || user.email];
      await query(
        `INSERT INTO cat.ProductoSima
           (ProductoCodigo, CodigoSima, DescripcionSima, LineaSima, PartidaSima, RenglonSima,
            PrecioSima, ModificadoPor, FechaModificacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(now() at time zone 'utc'))
         ON CONFLICT (ProductoCodigo) DO UPDATE
            SET CodigoSima=EXCLUDED.CodigoSima, DescripcionSima=EXCLUDED.DescripcionSima,
                LineaSima=EXCLUDED.LineaSima, PartidaSima=EXCLUDED.PartidaSima,
                RenglonSima=EXCLUDED.RenglonSima, PrecioSima=EXCLUDED.PrecioSima,
                ModificadoPor=EXCLUDED.ModificadoPor, FechaModificacion=EXCLUDED.FechaModificacion`,
        vals);
      return json(200, { ok: true, codigo: cod });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo guardar', detail: e.message });
    }
  }
});

/* POST /api/productos/sima/importar -> carga masiva desde el Excel.
   Body: { filas: [{ linea, producto_codigo, codigo_sima?, ... }] }
   El vacío NO toca nada: ver la nota de arriba. */
app.http('productos-sima-importar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'productos/sima/importar',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para importar los códigos Sima' });
    const b = await request.json().catch(() => ({}));
    const filas = Array.isArray(b.filas) ? b.filas : [];
    if (!filas.length) return json(400, { error: 'El archivo no trae filas' });
    if (filas.length > 20000) return json(400, { error: 'El archivo trae demasiadas filas (máximo 20000)' });

    try {
      const mapa = await getMapa();
      if (!mapa || !mapa.size) return json(503, { error: 'El catálogo de productos no está disponible; intente de nuevo en un momento' });

      const descartadas = [], sinDatos = [], malPrecio = [];
      const aplicar = [];
      const vistos = new Set();
      for (const f of filas) {
        const linea = f && f.linea;
        const cod = normCod(f && f.producto_codigo);
        if (!cod) { descartadas.push({ linea, codigo: '', motivo: 'sin código de producto' }); continue; }
        if (!mapa.has(cod)) { descartadas.push({ linea, codigo: cod, motivo: 'no está en el catálogo' }); continue; }
        const pre = simaPrecio(f.precio_sima);
        if (!pre.ok) { malPrecio.push({ linea, codigo: cod, valor: String(f.precio_sima) }); continue; }
        const v = {
          codigo_sima: simaTexto(f.codigo_sima, 60), descripcion_sima: simaTexto(f.descripcion_sima, 600),
          linea_sima: simaTexto(f.linea_sima, 30), partida_sima: simaTexto(f.partida_sima, 300),
          renglon_sima: simaTexto(f.renglon_sima, 300), precio_sima: pre.valor
        };
        /* Fila que no trae NINGUNO de los seis: no se toca el registro. Es lo
           pedido, y evita que un archivo con solo la columna de códigos borre
           -o cree- filas vacías. */
        if (SIMA_CAMPOS.every(([k]) => v[k] == null)) { sinDatos.push({ linea, codigo: cod }); continue; }
        /* Si el código se repite en el archivo, gana la última fila: es la
           misma regla que ya usa la carga de componentes de bandeja. */
        if (vistos.has(cod)) { const i = aplicar.findIndex((x) => x.cod === cod); if (i >= 0) aplicar.splice(i, 1); }
        vistos.add(cod);
        aplicar.push({ cod, v });
      }

      let nuevas = 0, actualizadas = 0;
      const client = await getClient();
      try {
        await client.query('BEGIN');
        for (const { cod, v } of aplicar) {
          /* COALESCE(EXCLUDED.x, actual) es lo que hace que el vacío no borre:
             el campo que no vino llega en NULL y se queda el que ya estaba. */
          const r = await client.query(
            `INSERT INTO cat.ProductoSima
               (ProductoCodigo, CodigoSima, DescripcionSima, LineaSima, PartidaSima, RenglonSima,
                PrecioSima, ModificadoPor, FechaModificacion)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(now() at time zone 'utc'))
             ON CONFLICT (ProductoCodigo) DO UPDATE
                SET CodigoSima      = COALESCE(EXCLUDED.CodigoSima,      cat.ProductoSima.CodigoSima),
                    DescripcionSima = COALESCE(EXCLUDED.DescripcionSima, cat.ProductoSima.DescripcionSima),
                    LineaSima       = COALESCE(EXCLUDED.LineaSima,       cat.ProductoSima.LineaSima),
                    PartidaSima     = COALESCE(EXCLUDED.PartidaSima,     cat.ProductoSima.PartidaSima),
                    RenglonSima     = COALESCE(EXCLUDED.RenglonSima,     cat.ProductoSima.RenglonSima),
                    PrecioSima      = COALESCE(EXCLUDED.PrecioSima,      cat.ProductoSima.PrecioSima),
                    ModificadoPor   = EXCLUDED.ModificadoPor,
                    FechaModificacion = EXCLUDED.FechaModificacion
             RETURNING (xmax = 0) AS insertada`,
            [cod, v.codigo_sima, v.descripcion_sima, v.linea_sima, v.partida_sima,
             v.renglon_sima, v.precio_sima, user.name || user.email]);
          if (r.rows[0] && r.rows[0].insertada) nuevas++; else actualizadas++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }

      return json(200, {
        ok: true, leidas: filas.length, aplicadas: aplicar.length, nuevas, actualizadas,
        descartadas: descartadas.slice(0, 200), descartadas_total: descartadas.length,
        sin_datos: sinDatos.slice(0, 200), sin_datos_total: sinDatos.length,
        precio_invalido: malPrecio.slice(0, 200), precio_invalido_total: malPrecio.length
      });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo importar', detail: e.message });
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
      // ?todos=1 -> incluye los desactivados (lo usa la pantalla de catalogo).
      const todos = /^(1|true|si)$/i.test(String(request.query.get('todos') || ''));
      const r = await query(
        `SELECT Id AS id, Nombre AS nombre, Activo AS activo FROM cat.Cirujano
          ${todos ? '' : 'WHERE Activo = TRUE'} ORDER BY Nombre`);
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
    // Se puede mandar solo { nombre }, solo { activo } o los dos.
    const cambiaNombre = !!body && body.nombre !== undefined;
    const cambiaActivo = !!body && body.activo !== undefined;
    if (!cambiaNombre && !cambiaActivo) return json(400, { error: 'No hay nada que actualizar' });
    const nombre = cambiaNombre ? normNombre(body.nombre) : null;
    if (cambiaNombre && !nombre) return json(400, { error: 'El nombre del cirujano es obligatorio' });
    if (cambiaNombre && nombre.length > 200) return json(400, { error: 'El nombre no puede superar los 200 caracteres' });
    try {
      // Sin "AND Activo = TRUE": hay que poder reactivar uno desactivado.
      const r = await query(
        `UPDATE cat.Cirujano
            SET Nombre = COALESCE($1, Nombre),
                Activo = COALESCE($2, Activo),
                ActualizadoPor = $3, FechaActualizacion = (now() at time zone 'utc')
          WHERE Id = $4 RETURNING Id AS id, Nombre AS nombre, Activo AS activo`,
        [nombre, cambiaActivo ? !!body.activo : null, user.name || user.email, id]);
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
      // ?todos=1 -> incluye los desactivados (lo usa la pantalla de catalogo).
      const todos = /^(1|true|si)$/i.test(String(request.query.get('todos') || ''));
      const r = await query(
        `SELECT Id AS id, Nombre AS nombre, Activo AS activo FROM cat.Regimen
          ${todos ? '' : 'WHERE Activo = TRUE'} ORDER BY Nombre`);
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
    // Se puede mandar solo { nombre }, solo { activo } o los dos.
    const cambiaNombre = !!body && body.nombre !== undefined;
    const cambiaActivo = !!body && body.activo !== undefined;
    if (!cambiaNombre && !cambiaActivo) return json(400, { error: 'No hay nada que actualizar' });
    const nombre = cambiaNombre ? normNombre(body.nombre) : null;
    if (cambiaNombre && !nombre) return json(400, { error: 'El nombre del r\u00e9gimen es obligatorio' });
    if (cambiaNombre && nombre.length > 60) return json(400, { error: 'El nombre no puede superar los 60 caracteres' });
    try {
      // Sin "AND Activo = TRUE": hay que poder reactivar uno desactivado.
      const r = await query(
        `UPDATE cat.Regimen
            SET Nombre = COALESCE($1, Nombre),
                Activo = COALESCE($2, Activo),
                ActualizadoPor = $3, FechaActualizacion = (now() at time zone 'utc')
          WHERE Id = $4 RETURNING Id AS id, Nombre AS nombre, Activo AS activo`,
        [nombre, cambiaActivo ? !!body.activo : null, user.name || user.email, id]);
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
      /* Devuelve TAMBIEN las desactivadas, con su bandera. La hoja de consumo
         valida el N° de equipo contra este catalogo (equipoValido), asi que
         filtrarlas aca haria que una bandeja desactivada que aparece en hojas
         viejas se pintara como invalida. Quien no las quiere -el combo de la
         solicitud- filtra por activo. */
      const r = await query(`SELECT Codigo AS codigo, Demarcado AS demarcado, Nombre AS nombre,
                                    Color AS color, Activo AS activo
                               FROM cat.Equipo ORDER BY Codigo`);
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
   Bandejas — catálogo y detalle de productos
   Pantalla visible solo para Administrador y Bodega, así que todos
   estos endpoints piden puedeBodega(), incluso los de lectura.

   Se apoya en cat.Equipo / cat.EquipoProducto: es el mismo catálogo,
   con las columnas Categoria, Completo y Cantidad que agrega la
   migración 21_BandejaCatalogo.sql.
   ============================================================ */

/* Misma normalización que equipos/importar, para que los dos caminos
   produzcan la misma llave: 'NUT- 0001330' -> '0001330'. */
const normBandeja = (v) => String(v == null ? '' : v).replace(/\s+/g, '').replace(/^nut-?/i, '').toUpperCase();

/* Texto limpio o NULL, recortado al ancho de la columna. */
const textoONull = (v, max) => {
  const t = (v == null) ? '' : String(v).replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, max);
};

/* Cantidad de un producto dentro de la bandeja: mayor que cero, con dos
   decimales como máximo. Devuelve null si lo que llegó no sirve. */
function normCantidad(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/* Categorias de bandeja. La lista es cerrada y el formulario la ofrece como
   desplegable, pero la API no la impone: solo corrige la capitalizacion para
   que no entren variantes como 'INSTRUMENTAL' o 'implantes'. Un valor fuera de
   la lista se acepta tal cual, porque hay registros anteriores a la carga y no
   corresponde perderlos en un guardado. */
const BAN_CATEGORIAS = ['Instrumental', 'Implantes'];
function normCategoria(v) {
  const t = textoONull(v, 60);
  if (!t) return null;
  return BAN_CATEGORIAS.find((c) => c.toLowerCase() === t.toLowerCase()) || t;
}

/* El motivo es obligatorio cuando la bandeja se marca incompleta. */
function validarCompleto(completo, motivo) {
  if (completo === false && !motivo) return 'Indique el motivo por el que la bandeja está incompleta';
  return null;
}

/* Descripción oficial del producto. Sale del catálogo (/api/productos) y, si
   ese flujo no responde, de la que quedó guardada en la carga inicial. */
function conDescripcion(rows, mapa) {
  return rows.map((r) => ({
    ...r,
    descripcion: (mapa && mapa.get(normCod(r.producto))) || r.descripcion_guardada || null,
    en_catalogo: !!(mapa && mapa.size && mapa.has(normCod(r.producto)))
  }));
}

/* «Usada» = la bandeja aparece en el detalle de alguna Solicitud de Equipo,
   o como N° de equipo en alguna hoja de consumo. Una bandeja usada NO se
   borra: se desactiva, para que ningun registro historico quede apuntando a
   una bandeja que dejo de existir.
   El numero de equipo de las hojas viene como lo escribio el OCR o Bodega
   ('NUT-10104', 'nut 10104'), asi que se compara normalizado igual que
   normBandeja: sin espacios, sin el prefijo NUT- y en mayusculas. Se define
   una vez y se interpola en las dos consultas para que no se puedan
   desincronizar.
   Los espacios se quitan con la clase POSIX [[:space:]] y no con \s: en una
   cadena SQL con standard_conforming_strings -el default- una barra es
   literal, asi que '\s' buscaria una barra seguida de s en vez de un
   espacio. El parentesis que envuelve todo tambien es necesario: sin el,
   «EXISTS(...) OR EXISTS(...) AS usada» no parsea, el AS se pega al ultimo
   EXISTS. */
const SQL_BANDEJA_USADA = `(EXISTS (
    SELECT 1 FROM dbo.SolicitudEquipoDetalle d
     WHERE UPPER(TRIM(d.EquipoCodigo)) = UPPER(TRIM(e.Codigo))
  ) OR EXISTS (
    SELECT 1 FROM dbo.HojaConsumoDetalle h
     WHERE UPPER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(h.NumeroEquipo,''), '[[:space:]]', '', 'g'),
                                '^[Nn][Uu][Tt]-?', '')) = UPPER(TRIM(e.Codigo))
  ))`;

/* GET /api/bandejas -> listado principal del grid. */
app.http('bandejas-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'bandejas',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para ver el catálogo de bandejas' });
    try {
      const r = await query(
        `SELECT e.Codigo AS codigo, e.Demarcado AS demarcado, e.Nombre AS nombre,
                e.Categoria AS categoria, e.Color AS color, e.Completo AS completo,
                e.MotivoIncompleto AS motivo_incompleto, e.Activo AS activo,
                COALESCE(p.n, 0)::int AS productos,
                ${SQL_BANDEJA_USADA} AS usada
           FROM cat.Equipo e
           LEFT JOIN (SELECT EquipoCodigo, COUNT(*) AS n FROM cat.EquipoProducto GROUP BY EquipoCodigo) p
                  ON p.EquipoCodigo = e.Codigo
          ORDER BY COALESCE(e.Demarcado, e.Codigo)`);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el catálogo de bandejas', detail: e.message });
    }
  }
});

/* GET /api/bandejas/{codigo} -> la bandeja y su listado de componentes. */
app.http('bandeja-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'bandejas/{codigo}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para ver el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!codigo) return json(400, { error: 'Código de bandeja inválido' });
    try {
      const b = await query(
        `SELECT e.Codigo AS codigo, e.Demarcado AS demarcado, e.Nombre AS nombre,
                e.Categoria AS categoria, e.Color AS color, e.Completo AS completo,
                e.MotivoIncompleto AS motivo_incompleto, e.Activo AS activo,
                ${SQL_BANDEJA_USADA} AS usada
           FROM cat.Equipo e WHERE e.Codigo = $1`, [codigo]);
      if (!b.rowCount) return json(404, { error: 'La bandeja no existe' });
      const d = await query(
        `SELECT ProductoCodigo AS producto, Cantidad::float8 AS cantidad, Tipo AS tipo,
                DescripcionProducto AS descripcion_guardada
           FROM cat.EquipoProducto WHERE EquipoCodigo = $1 ORDER BY ProductoCodigo`, [codigo]);
      const mapa = await mapaCatalogo(context);
      return json(200, { ...b.rows[0], productos: conDescripcion(d.rows, mapa) });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la bandeja', detail: e.message });
    }
  }
});

/* POST /api/bandejas -> crea una bandeja.
   Body: { codigo, demarcado, nombre, categoria, color, completo, motivo_incompleto } */
app.http('bandeja-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bandejas',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const body = await request.json();
    /* El usuario escribe el número visible ('NUT-0001330'); de ahí sale la llave. */
    const demarcado = textoONull(body && (body.demarcado != null ? body.demarcado : body.codigo), 60);
    const codigo = normBandeja(body && (body.codigo != null ? body.codigo : body.demarcado));
    if (!codigo) return json(400, { error: 'El número de bandeja es obligatorio' });
    if (codigo.length > 40) return json(400, { error: 'El número de bandeja no puede superar los 40 caracteres' });
    const nombre = textoONull(body && body.nombre, 300);
    if (!nombre) return json(400, { error: 'La descripción de la bandeja es obligatoria' });
    const completo = (body && body.completo !== undefined) ? !!body.completo : true;
    const motivo = textoONull(body && body.motivo_incompleto, 300);
    const errComp = validarCompleto(completo, motivo);
    if (errComp) return json(400, { error: errComp });
    try {
      const r = await query(
        `INSERT INTO cat.Equipo (Codigo, Demarcado, Nombre, Categoria, Color, Completo, MotivoIncompleto,
                                 ActualizadoPor, FechaActualizacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(now() at time zone 'utc'))
         RETURNING Codigo AS codigo, Demarcado AS demarcado, Nombre AS nombre, Categoria AS categoria,
                   Color AS color, Completo AS completo, MotivoIncompleto AS motivo_incompleto`,
        [codigo, demarcado, nombre, normCategoria(body && body.categoria),
         textoONull(body && body.color, 40), completo, completo ? null : motivo,
         user.name || user.email]);
      return json(201, { ...r.rows[0], productos: 0 });
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ya existe una bandeja con ese número' });
      context.error(e);
      return json(500, { error: 'No se pudo crear la bandeja', detail: e.message });
    }
  }
});

/* PUT /api/bandejas/{codigo} -> corrige los datos de la bandeja. El número no
   se cambia: es la llave del detalle. */
app.http('bandeja-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'bandejas/{codigo}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!codigo) return json(400, { error: 'Código de bandeja inválido' });
    const body = await request.json();
    const nombre = textoONull(body && body.nombre, 300);
    if (!nombre) return json(400, { error: 'La descripción de la bandeja es obligatoria' });
    const completo = (body && body.completo !== undefined) ? !!body.completo : true;
    const motivo = textoONull(body && body.motivo_incompleto, 300);
    const errComp = validarCompleto(completo, motivo);
    if (errComp) return json(400, { error: errComp });
    /* Activo es distinto de Completo: Completo dice si a la bandeja le falta
       algo, Activo si la bandeja sigue en uso en el catalogo. Si no viene en
       el body no se toca, para que guardar desde el modal de edicion -que no
       trae el campo- no reactive una bandeja desactivada. */
    const activo = (body && body.activo !== undefined) ? !!body.activo : null;
    try {
      /* Una bandeja sin componentes no se guarda: no hay nada que alistar ni
         que verificar, asi que no deberia poder quedar configurada y lista
         para pedirse.
         La regla aplica SOLO a la edicion del encabezado, no al cambio de
         estado. El discriminador es `activo`: la pantalla de edicion no lo
         manda y el activar/desactivar del listado si. Sin esta distincion,
         una bandeja vacia no se podria DESACTIVAR, que es exactamente lo que
         uno quiere hacer con ella. */
      if (activo === null) {
        const n = await query(
          `SELECT COUNT(*)::int AS n FROM cat.EquipoProducto
            WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($1))`, [codigo]);
        if (!n.rows[0].n) {
          return json(400, { error: 'La bandeja no tiene componentes. Agregue al menos un artículo -o cárguelos con «Subir Excel»- antes de guardar.', sin_componentes: true });
        }
      }
      const r = await query(
        `UPDATE cat.Equipo e
            SET Demarcado = COALESCE($1, e.Demarcado), Nombre = $2, Categoria = $3, Color = $4,
                Completo = $5, MotivoIncompleto = $6, Activo = COALESCE($7, e.Activo),
                ActualizadoPor = $8, FechaActualizacion = (now() at time zone 'utc')
          WHERE e.Codigo = $9
          RETURNING e.Codigo AS codigo, e.Demarcado AS demarcado, e.Nombre AS nombre,
                    e.Categoria AS categoria, e.Color AS color, e.Completo AS completo,
                    e.MotivoIncompleto AS motivo_incompleto, e.Activo AS activo`,
        [textoONull(body && body.demarcado, 60), nombre, normCategoria(body && body.categoria),
         textoONull(body && body.color, 40), completo, completo ? null : motivo, activo,
         user.name || user.email, codigo]);
      if (!r.rowCount) return json(404, { error: 'La bandeja no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo actualizar la bandeja', detail: e.message });
    }
  }
});

/* DELETE /api/bandejas/{codigo} -> borra la bandeja, SOLO si nunca se uso.

   «Usada» es lo que define SQL_BANDEJA_USADA: aparece en el detalle de
   alguna Solicitud de Equipo, o como N° de equipo en alguna hoja de
   consumo. Si se uso, no se borra y se responde 409 diciendo que hay que
   desactivarla: borrarla dejaria registros historicos apuntando a una
   bandeja que ya no existe.
   Los componentes de la bandeja SI se borran con ella: cat.EquipoProducto
   es contenido de la bandeja, no historia de nadie. */
app.http('bandeja-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'bandejas/{codigo}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!codigo) return json(400, { error: 'Código de bandeja inválido' });
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const e = await client.query(
        `SELECT e.Codigo, COALESCE(e.Demarcado, e.Codigo) AS demarcado, ${SQL_BANDEJA_USADA} AS usada
           FROM cat.Equipo e WHERE e.Codigo = $1 FOR UPDATE`, [codigo]);
      if (!e.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'La bandeja no existe' }); }
      if (e.rows[0].usada) {
        await client.query('ROLLBACK');
        return json(409, {
          error: 'La bandeja ' + e.rows[0].demarcado + ' ya se usó en solicitudes u hojas de consumo, así que no se puede eliminar. Desactívela para sacarla del catálogo sin perder el historial.',
          usada: true
        });
      }
      const pr = await client.query(`DELETE FROM cat.EquipoProducto WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($1))`, [codigo]);
      await client.query(`DELETE FROM cat.Equipo WHERE Codigo = $1`, [codigo]);
      await client.query('COMMIT');
      return json(200, { ok: true, codigo, demarcado: e.rows[0].demarcado, productos_borrados: pr.rowCount || 0 });
    } catch (e2) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e2);
      return json(500, { error: 'No se pudo eliminar la bandeja', detail: e2.message });
    } finally {
      client.release();
    }
  }
});

/* POST /api/bandejas/{codigo}/productos -> agrega un producto a la bandeja.
   Body: { producto, cantidad }. La descripción NO se recibe del cliente: sale
   del catálogo, para que nadie la edite desde la pantalla. */
app.http('bandeja-producto-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bandejas/{codigo}/productos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    const body = await request.json();
    const producto = normCod(body && body.producto);
    if (!producto) return json(400, { error: 'El código de producto es obligatorio' });
    if (producto.length > 60) return json(400, { error: 'El código de producto no puede superar los 60 caracteres' });
    const cantidad = normCantidad(body && body.cantidad);
    if (cantidad === null) return json(400, { error: 'La cantidad debe ser un número mayor que cero' });
    try {
      const ex = await query(`SELECT 1 FROM cat.Equipo WHERE Codigo = $1`, [codigo]);
      if (!ex.rowCount) return json(404, { error: 'La bandeja no existe' });
      /* Validación best-effort, igual que en el guardado de hojas: si el
         catálogo de productos no responde, no se bloquea el alta. */
      const mapa = await mapaCatalogo(context);
      if (mapa.size && !mapa.has(producto)) {
        return json(400, { error: 'El código ' + producto + ' no existe en el catálogo de productos' });
      }
      const r = await query(
        `INSERT INTO cat.EquipoProducto (EquipoCodigo, ProductoCodigo, Cantidad, DescripcionProducto,
                                         ActualizadoPor, FechaActualizacion)
         VALUES ($1,$2,$3,$4,$5,(now() at time zone 'utc'))
         RETURNING ProductoCodigo AS producto, Cantidad::float8 AS cantidad, Tipo AS tipo,
                   DescripcionProducto AS descripcion_guardada`,
        [codigo, producto, cantidad, mapa.get(producto) || null, user.name || user.email]);
      return json(201, conDescripcion(r.rows, mapa)[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ese producto ya está en la bandeja. Edite la cantidad en lugar de agregarlo otra vez.' });
      context.error(e);
      return json(500, { error: 'No se pudo agregar el producto', detail: e.message });
    }
  }
});

/* POST /api/bandejas/{codigo}/productos/eliminar
   Body: { productos: ["24259105", ...] } -> borra esos componentes.

   Borrado por seleccion, no «vaciar todo». La lista SIEMPRE es explicita: si
   viene vacia se responde 400 en vez de interpretarla como «todos». Asi
   ningun body mal armado -ni un fetch a medio escribir- puede vaciar una
   bandeja de ochenta y dos lineas por accidente. Marcar todo en la pantalla
   manda los ochenta y dos codigos, que es lo mismo pero dicho.

   No toca el alisto de ninguna solicitud: dbo.SolicitudAlisto guarda el
   codigo del producto, asi que una solicitud ya alistada conserva sus
   marcas; lo que cambia es contra que total se calcula el porcentaje. Es la
   misma consecuencia que borrar un componente suelto, que ya se podia. */
app.http('bandeja-productos-eliminar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bandejas/{codigo}/productos/eliminar',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!codigo) return json(400, { error: 'Código de bandeja inválido' });
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const pedidos = [...new Set((Array.isArray(body && body.productos) ? body.productos : [])
      .map((x) => normCod(x)).filter(Boolean))];
    if (!pedidos.length) return json(400, { error: 'No se indicó ningún componente para eliminar' });
    try {
      const ex = await query(`SELECT 1 FROM cat.Equipo WHERE Codigo = $1`, [codigo]);
      if (!ex.rowCount) return json(404, { error: 'La bandeja no existe' });
      const r = await query(
        `DELETE FROM cat.EquipoProducto
          WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($1))
            AND UPPER(TRIM(ProductoCodigo)) = ANY($2::text[])`,
        [codigo, pedidos.map((x) => x.toUpperCase())]);
      const quedan = await query(
        `SELECT COUNT(*)::int AS n FROM cat.EquipoProducto
          WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($1))`, [codigo]);
      return json(200, {
        codigo, productos_borrados: r.rowCount || 0,
        pedidos: pedidos.length, quedan: quedan.rows[0].n
      });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudieron eliminar los componentes', detail: e.message });
    }
  }
});

/* POST /api/bandejas/{codigo}/productos/importar
   Carga masiva de componentes desde el Excel que arma la pantalla.
   Body: { productos: [ { producto, cantidad, tipo } ] }

   El Excel se lee EN EL NAVEGADOR con SheetJS, que ya venia cargado para
   importar cirugias, y llega aca como JSON. Asi no hay dependencia nueva en
   api/package.json, que sigue con @azure/functions y pg nada mas.

   AGREGA Y ACTUALIZA, NO BORRA: el codigo que no esta se agrega, el que ya
   esta actualiza cantidad y tipo, y lo que no viene en el archivo se queda.
   Decision de Luis, y es la segura: un archivo incompleto no vacia la
   bandeja.

   Cada fila se decide sola. Un codigo que no existe en el catalogo de
   productos, o una cantidad que no es un numero mayor que cero, se rechaza
   y se devuelve en `errores` con su numero de fila para que la pantalla los
   muestre; el resto se carga igual. Rechazar el archivo entero por una fila
   mala obligaria a corregir y volver a subir todo, y estos archivos traen
   ochenta lineas. */
app.http('bandeja-productos-importar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bandejas/{codigo}/productos/importar',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!codigo) return json(400, { error: 'Código de bandeja inválido' });
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const filas = Array.isArray(body && body.productos) ? body.productos : [];
    if (!filas.length) return json(400, { error: 'El archivo no trae ninguna línea para cargar' });
    if (filas.length > 3000) return json(400, { error: 'El archivo trae demasiadas líneas (máximo 3000)' });

    const client = await getClient();
    try {
      const ex = await client.query(`SELECT 1 FROM cat.Equipo WHERE Codigo = $1`, [codigo]);
      if (!ex.rowCount) { client.release(); return json(404, { error: 'La bandeja no existe' }); }
      /* Validacion best-effort, igual que el alta de uno: si el catalogo de
         productos no responde, no se bloquea la carga. */
      const mapa = await mapaCatalogo(context);

      const errores = [];
      const buenas = new Map();   // producto -> { cantidad, tipo }
      filas.forEach((f, i) => {
        const linea = (f && f.linea) || (i + 2);   // +2: fila 1 son los encabezados
        const prod = normCod(f && f.producto);
        if (!prod) { errores.push({ linea, error: 'Sin código de producto' }); return; }
        if (prod.length > 60) { errores.push({ linea, producto: prod, error: 'El código supera los 60 caracteres' }); return; }
        const cant = normCantidad(f && f.cantidad);
        if (cant === null) { errores.push({ linea, producto: prod, error: 'La cantidad debe ser un número mayor que cero' }); return; }
        if (mapa.size && !mapa.has(prod)) {
          errores.push({ linea, producto: prod, error: 'No existe en el catálogo de productos' });
          return;
        }
        /* Un codigo repetido dentro del mismo archivo: gana la ultima fila,
           que es lo que espera quien acaba de corregirla mas abajo. */
        buenas.set(prod, { cantidad: cant, tipo: textoONull(f && f.tipo, 40) });
      });

      let agregados = 0, actualizados = 0;
      await client.query('BEGIN');
      for (const [prod, v] of buenas) {
        const up = await client.query(
          `UPDATE cat.EquipoProducto
              SET Cantidad = $1, Tipo = COALESCE($2, Tipo),
                  ActualizadoPor = $3, FechaActualizacion = (now() at time zone 'utc')
            WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($4))
              AND UPPER(TRIM(ProductoCodigo)) = UPPER(TRIM($5))`,
          [v.cantidad, v.tipo, user.name || user.email, codigo, prod]);
        if (up.rowCount) { actualizados++; continue; }
        await client.query(
          `INSERT INTO cat.EquipoProducto (EquipoCodigo, ProductoCodigo, Cantidad, Tipo,
                                           DescripcionProducto, ActualizadoPor, FechaActualizacion)
           VALUES ($1,$2,$3,$4,$5,$6,(now() at time zone 'utc'))`,
          [codigo, prod, v.cantidad, v.tipo, mapa.get(prod) || null, user.name || user.email]);
        agregados++;
      }
      await client.query('COMMIT');
      return json(200, {
        codigo, agregados, actualizados,
        rechazados: errores.length, leidas: filas.length, errores: errores.slice(0, 100)
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo cargar el archivo', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* PUT /api/bandejas/{codigo}/productos/{producto} -> cambia la cantidad. */
app.http('bandeja-producto-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'bandejas/{codigo}/productos/{producto}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    const producto = normCod(decodeURIComponent(request.params.producto || ''));
    if (!codigo || !producto) return json(400, { error: 'Bandeja o producto inválido' });
    const body = await request.json();
    const cantidad = normCantidad(body && body.cantidad);
    if (cantidad === null) return json(400, { error: 'La cantidad debe ser un número mayor que cero' });
    try {
      const r = await query(
        `UPDATE cat.EquipoProducto
            SET Cantidad = $1, ActualizadoPor = $2, FechaActualizacion = (now() at time zone 'utc')
          WHERE EquipoCodigo = $3 AND ProductoCodigo = $4
          RETURNING ProductoCodigo AS producto, Cantidad::float8 AS cantidad, Tipo AS tipo,
                    DescripcionProducto AS descripcion_guardada`,
        [cantidad, user.name || user.email, codigo, producto]);
      if (!r.rowCount) return json(404, { error: 'Ese producto no está en la bandeja' });
      const mapa = await mapaCatalogo(context);
      return json(200, conDescripcion(r.rows, mapa)[0]);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo actualizar la cantidad', detail: e.message });
    }
  }
});

/* DELETE /api/bandejas/{codigo}/productos/{producto} -> saca el producto. */
app.http('bandeja-producto-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'bandejas/{codigo}/productos/{producto}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const codigo = normBandeja(decodeURIComponent(request.params.codigo || ''));
    const producto = normCod(decodeURIComponent(request.params.producto || ''));
    if (!codigo || !producto) return json(400, { error: 'Bandeja o producto inválido' });
    try {
      const r = await query(
        `DELETE FROM cat.EquipoProducto WHERE EquipoCodigo = $1 AND ProductoCodigo = $2`,
        [codigo, producto]);
      if (!r.rowCount) return json(404, { error: 'Ese producto no está en la bandeja' });
      return json(200, { ok: true });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo eliminar el producto', detail: e.message });
    }
  }
});



/* ============================================================
   Fotografias de referencia de la bandeja
   ------------------------------------------------------------
   Como deberia verse la bandeja. Una bandeja tiene de 2 a 9 recipientes y cada
   uno se fotografia aparte, asi que esto es una galeria, no una foto.

   Dos usos desde el primer dia, sin depender de nada mas:
     - Bodega abre la bandeja en Mantenimiento y ve con que deberia toparse.
     - Quien corrija el catalogo puede mirar la foto al lado del contenido
       registrado. Hay 59 discrepancias medidas entre lo impreso en las
       bandejas y cat.EquipoProducto, y hoy no hay ninguna pantalla donde ver
       las dos cosas juntas.

   El contenido va en base64 en TEXT, igual que las fotos de la hoja sellada:
   sin dependencia nueva y sin cuenta de almacenamiento. Las reglas de imagen
   -SELLADA_TIPOS y SELLADA_MAX_MB, mas abajo en este archivo- son las mismas.

   QUIEN BORRA: cualquiera de Bodega o Administrador. Es distinto de las fotos
   de la hoja sellada y del alisto, donde solo borra quien subio, y la razon es
   que aca la foto NO es evidencia de un acto de nadie: es dato de catalogo
   compartido, como la descripcion o el color. Se corrige como se corrige el
   resto del catalogo.
   ============================================================ */

/* Nueve recipientes tiene la bandeja mas grande que fotografiaron (0001337);
   doce deja aire para las tapas y para repetir una que salio movida. */
const FOTO_BANDEJA_MAX = 12;
const FECHA_EQFOTO = `to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

/* El codigo tal como esta guardado en cat.Equipo, que es la llave primaria y a
   la que apunta la foranea. normBandeja() normaliza lo que llega por la ruta,
   pero la fila tiene que guardar el codigo del catalogo, no el normalizado, o
   la foranea rebota. Devuelve null si la bandeja no existe. */
async function codigoDeBandeja(cod) {
  const r = await query(
    `SELECT Codigo AS codigo, Demarcado AS demarcado FROM cat.Equipo
      WHERE UPPER(TRIM(Codigo)) = UPPER(TRIM($1))`, [cod]);
  return r.rowCount ? r.rows[0] : null;
}

/* GET /api/bandejas/{codigo}/fotos -> la galeria SIN el contenido.
   Traer el base64 aca haria que abrir una bandeja con nueve fotos bajara
   varios MB; cada imagen se pide aparte y solo cuando se va a ver. */
app.http('bandeja-fotos-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'bandejas/{codigo}/fotos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para ver el catálogo de bandejas' });
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!cod) return json(400, { error: 'Código de bandeja inválido' });
    try {
      const b = await codigoDeBandeja(cod);
      if (!b) return json(404, { error: 'Esa bandeja no está en el catálogo' });
      const r = await query(
        `SELECT Id AS id, Rotulo AS rotulo, Orden AS orden, Nombre AS nombre,
                Tipo AS tipo, Bytes AS bytes, Usuario AS usuario, ${FECHA_EQFOTO} AS fecha,
                (TextoOcr IS NOT NULL) AS leida, ErrorOcr AS error_ocr
           FROM cat.EquipoFoto WHERE EquipoCodigo = $1
          ORDER BY Orden, Id`, [b.codigo]);
      /* Sin texto no sirven para validar: la pantalla lo dice y ofrece leerlas.
         `pendientes` = las que un reintento PODRIA arreglar: las que nunca se
         intentaron, y las que fallaron por algo pasajero -un 429 de Azure, una
         caida-. La unica que no cuenta es la que se leyo bien y no traia nada
         que leer: esa no se arregla reintentando, se arregla volviendo a
         fotografiar el recipiente. */
      const sinArreglo = 'No se leyó ningún texto en la imagen';
      return json(200, { codigo: b.codigo, demarcado: b.demarcado, maximo: FOTO_BANDEJA_MAX,
                         fotos: r.rows,
                         leidas: r.rows.filter((x) => x.leida).length,
                         pendientes: r.rows.filter((x) => !x.leida && x.error_ocr !== sinArreglo).length });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudieron obtener las fotos de la bandeja', detail: e.message });
    }
  }
});

/* GET /api/bandejas/{codigo}/fotos/{fid} -> una foto en base64. */
app.http('bandeja-foto-contenido', {
  methods: ['GET'], authLevel: 'anonymous', route: 'bandejas/{codigo}/fotos/{fid}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para ver el catálogo de bandejas' });
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    const fid = parseInt(request.params.fid, 10);
    if (!cod || !fid) return json(400, { error: 'Bandeja o foto inválida' });
    try {
      const r = await query(
        `SELECT f.Nombre AS nombre, f.Tipo AS tipo, f.Rotulo AS rotulo, f.Contenido AS contenido
           FROM cat.EquipoFoto f
          WHERE f.Id = $1 AND UPPER(TRIM(f.EquipoCodigo)) = UPPER(TRIM($2))`, [fid, cod]);
      if (!r.rowCount) return json(404, { error: 'La foto no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la foto', detail: e.message });
    }
  }
});

/* POST /api/bandejas/{codigo}/fotos
   Body: { nombre, tipo, base64, rotulo } — la imagen ya reducida por el
   navegador. El orden se asigna solo: va al final de la galeria. */
app.http('bandeja-foto-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bandejas/{codigo}/fotos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!cod) return json(400, { error: 'Código de bandeja inválido' });

    const body = await request.json().catch(() => ({}));
    const tipo = String((body && body.tipo) || '').toLowerCase().trim();
    const b64 = String((body && body.base64) || '');
    const nombre = String((body && body.nombre) || '').trim().slice(0, 260) || null;
    const rotulo = String((body && body.rotulo) || '').trim().slice(0, 100) || null;

    if (!b64) return json(400, { error: 'No llegó la imagen' });
    if (!SELLADA_TIPOS.has(tipo))
      return json(400, { error: 'Solo se admiten imágenes (JPG, PNG, WEBP, GIF o BMP). Recibido: ' + (tipo || 'sin tipo') });
    // 3 caracteres de base64 = 4 bytes; alcanza para el tope sin decodificar.
    const bytes = Math.floor(b64.length * 3 / 4);
    if (bytes > SELLADA_MAX_MB * 1024 * 1024)
      return json(400, { error: 'La imagen supera los ' + SELLADA_MAX_MB + ' MB' });

    try {
      const b = await codigoDeBandeja(cod);
      if (!b) return json(404, { error: 'Esa bandeja no está en el catálogo' });

      const c = await query(
        `SELECT COUNT(*)::int AS n, COALESCE(MAX(Orden), -1) AS ultimo
           FROM cat.EquipoFoto WHERE EquipoCodigo = $1`, [b.codigo]);
      if (c.rows[0].n >= FOTO_BANDEJA_MAX)
        return json(400, { error: 'Ya hay ' + FOTO_BANDEJA_MAX + ' fotos en esta bandeja, el máximo permitido' });

      /* SE LEE AL SUBIR, igual que la foto de la entrega. Sin esto la foto
         entra al catalogo muda y la bandeja no se puede validar nunca: el
         motor compara TEXTO contra TEXTO. Si Azure falla, la foto se guarda
         igual con el error anotado -sirve para verla- y se puede reintentar
         despues con «Leer texto». */
      let texto = null, errOcr = null;
      try {
        texto = textoDe(await analyzeRead(b64)) || null;
        if (!texto) errOcr = 'No se leyó ningún texto en la imagen';
      } catch (e) {
        errOcr = String(e.message || e).slice(0, 300);
        context.warn('No se pudo leer la foto del catálogo: ' + errOcr);
      }

      const r = await query(
        `INSERT INTO cat.EquipoFoto (EquipoCodigo, Rotulo, Orden, Nombre, Tipo, Bytes, Contenido,
                                     TextoOcr, FechaOcr, ErrorOcr, Usuario, UsuarioEmail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(now() at time zone 'utc'),$9,$10,$11)
         ON CONFLICT (EquipoCodigo, COALESCE(Nombre,''), COALESCE(Bytes,0)) DO NOTHING
         RETURNING Id AS id, Rotulo AS rotulo, Orden AS orden, Nombre AS nombre,
                   Tipo AS tipo, Bytes AS bytes, Usuario AS usuario, ${FECHA_EQFOTO} AS fecha,
                   (TextoOcr IS NOT NULL) AS leida, ErrorOcr AS error_ocr`,
        [b.codigo, rotulo, c.rows[0].ultimo + 1, nombre, tipo, bytes, b64,
         texto, errOcr, user.name || user.email, user.email]);
      /* El corpus cambio: el cache de referencias tiene que rehacerse o la
         validacion seguiria comparando contra lo de hace un minuto. */
      REF_CACHE = null;
      /* Sin filas devueltas es que el indice unico la freno: la misma foto ya
         estaba. Se responde 200 y no un error, porque desde la pantalla eso es
         «ya la tenias», no un fallo. */
      if (!r.rowCount) return json(200, { ok: true, repetida: true, codigo: b.demarcado || b.codigo });
      return json(201, { ...r.rows[0], codigo: b.demarcado || b.codigo });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo guardar la foto', detail: e.message });
    }
  }
});

/* PUT /api/bandejas/{codigo}/fotos/{fid}
   Body: { rotulo, orden } — para nombrar el recipiente y acomodar la galeria.
   Los dos campos son opcionales: se cambia solo lo que venga. */
app.http('bandeja-foto-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'bandejas/{codigo}/fotos/{fid}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    const fid = parseInt(request.params.fid, 10);
    if (!cod || !fid) return json(400, { error: 'Bandeja o foto inválida' });

    const body = await request.json().catch(() => ({}));
    const tieneRotulo = body && body.rotulo !== undefined;
    const tieneOrden = body && body.orden !== undefined;
    if (!tieneRotulo && !tieneOrden) return json(400, { error: 'No hay nada que cambiar' });
    const rotulo = tieneRotulo ? (String(body.rotulo || '').trim().slice(0, 100) || null) : null;
    const orden = tieneOrden ? (parseInt(body.orden, 10) || 0) : null;

    try {
      const r = await query(
        `UPDATE cat.EquipoFoto
            SET Rotulo = CASE WHEN $3 THEN $4 ELSE Rotulo END,
                Orden  = CASE WHEN $5 THEN $6 ELSE Orden  END
          WHERE Id = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))
        RETURNING Id AS id, Rotulo AS rotulo, Orden AS orden, Nombre AS nombre`,
        [fid, cod, tieneRotulo, rotulo, tieneOrden, orden]);
      if (!r.rowCount) return json(404, { error: 'La foto no existe' });
      return json(200, { ...r.rows[0], codigo: cod });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo actualizar la foto', detail: e.message });
    }
  }
});

/* DELETE /api/bandejas/{codigo}/fotos/{fid} */
app.http('bandeja-foto-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'bandejas/{codigo}/fotos/{fid}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    const fid = parseInt(request.params.fid, 10);
    if (!cod || !fid) return json(400, { error: 'Bandeja o foto inválida' });
    try {
      const r = await query(
        `DELETE FROM cat.EquipoFoto
          WHERE Id = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))
        RETURNING Nombre AS nombre`, [fid, cod]);
      if (!r.rowCount) return json(404, { error: 'La foto no existe' });
      REF_CACHE = null;   // el corpus cambio
      return json(200, { ok: true, codigo: cod, nombre: r.rows[0].nombre });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo eliminar la foto', detail: e.message });
    }
  }
});


/* ============================================================
   Hospitales — catálogo
   El mantenimiento es solo para Administrador y Bodega, pero la lista de
   activos la puede leer cualquier usuario autenticado: el formulario de
   Solicitud de Equipo (rol Hospital) la va a necesitar como desplegable.

   No hay DELETE a propósito: un hospital se desactiva. Las solicitudes van
   a referenciar estos registros y borrar uno dejaría huérfano el histórico.
   ============================================================ */

/* Las provincias viven en cat.Provincia: siete filas fijas, de solo lectura.
   No hay endpoints de alta, edicion ni borrado a proposito. Se cachean en
   memoria porque no cambian nunca; antes este listado estaba repetido en el
   CHECK de la tabla, aca y en el frontend. */
let PROV_CACHE = null;
async function provincias() {
  if (!PROV_CACHE) {
    const r = await query(`SELECT Id AS id, Nombre AS nombre FROM cat.Provincia ORDER BY Id`);
    PROV_CACHE = r.rows;
  }
  return PROV_CACHE;
}
const sinTilde = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/* Resuelve la provincia a su Id. Acepta provincia_id (lo que manda la
   pantalla) o el nombre (comodo para otros llamadores y para pruebas).
   id === undefined significa «no la mandaron», distinto de «vacia». */
async function resolverProvincia(body) {
  if (body && body.provincia_id !== undefined) {
    const n = parseInt(body.provincia_id, 10);
    if (!n) return { ok: true, id: null };
    const lista = await provincias();
    return lista.some((p) => p.id === n) ? { ok: true, id: n } : { ok: false, id: null };
  }
  if (body && body.provincia !== undefined) {
    const t = textoONull(body.provincia, 40);
    if (!t) return { ok: true, id: null };
    const lista = await provincias();
    const m = lista.find((p) => sinTilde(p.nombre) === sinTilde(t));
    return m ? { ok: true, id: m.id } : { ok: false, id: null };
  }
  return { ok: true, id: undefined };
}
const errProvincia = async () => 'La provincia debe ser una de: ' + (await provincias()).map((p) => p.nombre).join(', ');

/* GET /api/provincias -> el catalogo. Cualquier usuario autenticado: lo
   necesita el desplegable de Hospitales. Solo lectura. */
app.http('provincias-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'provincias',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    try {
      return json(200, await provincias());
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el catálogo de provincias', detail: e.message });
    }
  }
});

const normNombreHospital = (v) => textoONull(v, 200);

/* GET /api/hospitales -> activos. ?todos=1 incluye los desactivados y es
   solo para la pantalla de mantenimiento. */
app.http('hospitales-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hospitales',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const todos = /^(1|true|si)$/i.test(String(request.query.get('todos') || ''));
    if (todos && !puedeBodega(await getRole(user))) {
      return json(403, { error: 'No tiene permiso para ver los hospitales desactivados' });
    }
    try {
      const r = await query(
        `SELECT h.Id AS id, h.Nombre AS nombre, h.ProvinciaId AS provincia_id,
                p.Nombre AS provincia, h.Activo AS activo
           FROM cat.Hospital h
           LEFT JOIN cat.Provincia p ON p.Id = h.ProvinciaId
          ${todos ? '' : 'WHERE h.Activo = TRUE'}
          ORDER BY h.Nombre`);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el catálogo de hospitales', detail: e.message });
    }
  }
});

/* POST /api/hospitales -> agrega un hospital. Body: { nombre, provincia, activo } */
app.http('hospital-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'hospitales',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de hospitales' });
    const body = await request.json();
    const nombre = normNombreHospital(body && body.nombre);
    if (!nombre) return json(400, { error: 'El nombre del hospital es obligatorio' });
    const prov = await resolverProvincia(body);
    if (!prov.ok) return json(400, { error: await errProvincia() });
    const activo = (body && body.activo !== undefined) ? !!body.activo : true;
    try {
      const r = await query(
        `WITH nuevo AS (
           INSERT INTO cat.Hospital (Nombre, ProvinciaId, Activo, CreadoPor, FechaActualizacion)
           VALUES ($1,$2,$3,$4,(now() at time zone 'utc'))
           RETURNING Id, Nombre, ProvinciaId, Activo)
         SELECT n.Id AS id, n.Nombre AS nombre, n.ProvinciaId AS provincia_id,
                p.Nombre AS provincia, n.Activo AS activo
           FROM nuevo n LEFT JOIN cat.Provincia p ON p.Id = n.ProvinciaId`,
        [nombre, prov.id === undefined ? null : prov.id, activo, user.name || user.email]);
      return json(201, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ya existe un hospital con ese nombre' });
      context.error(e);
      return json(500, { error: 'No se pudo agregar el hospital', detail: e.message });
    }
  }
});

/* PUT /api/hospitales/{id} -> corrige el nombre, la provincia o el estado.
   Se puede mandar solo { activo } para activar o desactivar desde el grid.
   No modifica las solicitudes ya creadas. */
app.http('hospital-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'hospitales/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de hospitales' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    const body = await request.json();
    /* Se puede mandar solo { nombre }, solo { provincia }, solo { activo } o
       cualquier combinacion. El modal de catalogo compartido manda
       { activo } suelto para desactivar y { nombre } suelto para corregir,
       asi que exigir el nombre siempre romperia esa pantalla. */
    const cambiaNombre    = !!body && body.nombre !== undefined;
    const cambiaProvincia = !!body && (body.provincia !== undefined || body.provincia_id !== undefined);
    const cambiaActivo    = !!body && body.activo !== undefined;
    if (!cambiaNombre && !cambiaProvincia && !cambiaActivo) return json(400, { error: 'No hay nada que actualizar' });

    const nombre = cambiaNombre ? normNombreHospital(body.nombre) : null;
    if (cambiaNombre && !nombre) return json(400, { error: 'El nombre del hospital es obligatorio' });

    /* La provincia se puede vaciar a propósito, así que se distingue entre
       «no la mandaron» y «la mandaron vacía»: por eso el flag aparte. */
    let provinciaId = null;
    if (cambiaProvincia) {
      const pr = await resolverProvincia(body);
      if (!pr.ok) return json(400, { error: await errProvincia() });
      provinciaId = pr.id === undefined ? null : pr.id;
    }
    try {
      const r = await query(
        `WITH upd AS (
           UPDATE cat.Hospital
              SET Nombre      = COALESCE($1::varchar, Nombre),
                  ProvinciaId = CASE WHEN $2::boolean THEN $3::smallint ELSE ProvinciaId END,
                  Activo      = COALESCE($4::boolean, Activo),
                  ActualizadoPor = $5, FechaActualizacion = (now() at time zone 'utc')
            WHERE Id = $6
            RETURNING Id, Nombre, ProvinciaId, Activo)
         SELECT u.Id AS id, u.Nombre AS nombre, u.ProvinciaId AS provincia_id,
                p.Nombre AS provincia, u.Activo AS activo
           FROM upd u LEFT JOIN cat.Provincia p ON p.Id = u.ProvinciaId`,
        [nombre, cambiaProvincia, provinciaId, cambiaActivo ? !!body.activo : null,
         user.name || user.email, id]);
      if (!r.rowCount) return json(404, { error: 'El hospital no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ya hay otro hospital con ese nombre' });
      context.error(e);
      return json(500, { error: 'No se pudo actualizar el hospital', detail: e.message });
    }
  }
});


/* ============================================================
   Notificaciones — cuentas que reciben aviso por evento
   Mantenimiento solo para Administrador y Bodega.
   ============================================================ */

const NOTIF_EVENTOS = ['solicitud', 'alistado', 'devolucion', 'liberado', 'devuelta'];

/* Validacion deliberadamente permisiva: alcanza para atajar el dedazo
   («juan@», «juan.nutricare.co.cr») sin pelear con direcciones raras pero
   validas. Quien manda el correo es Power Automate, no esta API. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normEmail(v) {
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t || t.length > 200 || !EMAIL_RE.test(t)) return null;
  return t;
}

/* Los cuatro eventos vienen como booleanos. Devuelve null si no hay
   ninguno marcado. */
function leerEventos(body) {
  const e = {};
  for (const k of NOTIF_EVENTOS) e[k] = !!(body && body[k]);
  return NOTIF_EVENTOS.some((k) => e[k]) ? e : null;
}

/* GET /api/notificaciones -> listado del mantenimiento. */
app.http('notificaciones-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'notificaciones',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para ver las notificaciones' });
    try {
      const r = await query(
        `SELECT Id AS id, Email AS email, Solicitud AS solicitud, Alistado AS alistado,
                Devolucion AS devolucion, Liberado AS liberado, Devuelta AS devuelta
           FROM cat.Notificacion ORDER BY Email`);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener las notificaciones', detail: e.message });
    }
  }
});

/* POST /api/notificaciones -> agrega una cuenta.
   Body: { email, solicitud, alistado, devolucion, liberado } */
app.http('notificacion-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'notificaciones',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar las notificaciones' });
    const body = await request.json();
    const email = normEmail(body && body.email);
    if (!email) return json(400, { error: 'Escriba un correo electrónico válido' });
    const ev = leerEventos(body);
    if (!ev) return json(400, { error: 'Marque al menos un evento' });
    try {
      const r = await query(
        `INSERT INTO cat.Notificacion (Email, Solicitud, Alistado, Devolucion, Liberado, Devuelta, CreadoPor, FechaActualizacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,(now() at time zone 'utc'))
         RETURNING Id AS id, Email AS email, Solicitud AS solicitud, Alistado AS alistado,
                   Devolucion AS devolucion, Liberado AS liberado, Devuelta AS devuelta`,
        [email, ev.solicitud, ev.alistado, ev.devolucion, ev.liberado, ev.devuelta,
         user.name || user.email]);
      return json(201, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Esa cuenta ya está en el listado' });
      context.error(e);
      return json(500, { error: 'No se pudo agregar la cuenta', detail: e.message });
    }
  }
});

/* PUT /api/notificaciones/{id} -> corrige el correo o los eventos. */
app.http('notificacion-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'notificaciones/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar las notificaciones' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    const body = await request.json();
    const email = normEmail(body && body.email);
    if (!email) return json(400, { error: 'Escriba un correo electrónico válido' });
    const ev = leerEventos(body);
    if (!ev) return json(400, { error: 'Marque al menos un evento' });
    try {
      const r = await query(
        `UPDATE cat.Notificacion
            SET Email = $1, Solicitud = $2, Alistado = $3, Devolucion = $4, Liberado = $5,
                Devuelta = $6, ActualizadoPor = $7, FechaActualizacion = (now() at time zone 'utc')
          WHERE Id = $8
          RETURNING Id AS id, Email AS email, Solicitud AS solicitud, Alistado AS alistado,
                    Devolucion AS devolucion, Liberado AS liberado, Devuelta AS devuelta`,
        [email, ev.solicitud, ev.alistado, ev.devolucion, ev.liberado, ev.devuelta,
         user.name || user.email, id]);
      if (!r.rowCount) return json(404, { error: 'La cuenta no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return json(400, { error: 'Ya hay otra cuenta con ese correo' });
      context.error(e);
      return json(500, { error: 'No se pudo actualizar la cuenta', detail: e.message });
    }
  }
});

/* DELETE /api/notificaciones/{id} -> saca la cuenta del listado.
   Aquí sí se borra: una preferencia de aviso no la referencia nada, así que
   no hay histórico que proteger. */
app.http('notificacion-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'notificaciones/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar las notificaciones' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const r = await query(`DELETE FROM cat.Notificacion WHERE Id = $1`, [id]);
      if (!r.rowCount) return json(404, { error: 'La cuenta no existe' });
      return json(200, { ok: true });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo eliminar la cuenta', detail: e.message });
    }
  }
});


/* ============================================================
   Solicitud de Equipo
   Rol Hospital (y Administrador). Dos estados: Borrador y Enviada.

   Guardar y enviar son operaciones distintas a proposito. Si un solo
   boton validara y enviara siempre, el estado Borrador no existiria: cada
   guardado saltaria a Enviada y la cejilla de borradores quedaria muerta.
   Asi que guardar admite datos incompletos y enviar exige todo.

   Una vez Enviada la solicitud no se edita ni se borra: ya salio el aviso
   a Bodega y el registro es el respaldo de lo que se pidio.
   ============================================================ */

const SOL_ESTADOS = ['Borrador', 'Enviada', 'En Preparación', 'Enviado a Hospital'];
/* Estados en los que Bodega todavia puede marcar el alisto. Despachada la
   solicitud, el check list queda de solo lectura: es el registro de con que
   salio el equipo. */
const SOL_ALISTABLES = ['Enviada', 'En Preparación'];
const SOL_DESPACHADA = 'Enviado a Hospital';

/* Fecha y hora actuales en Costa Rica, tomadas de la BASE y no del reloj del
   proceso. Azure corre en UTC: a las 6pm de Costa Rica ya es el dia siguiente
   en UTC, asi que comparar contra UTC rechazaria cirugias validas de la tarde
   y aceptaria horas ya pasadas. */
async function ahoraCR() {
  const r = await query(
    `SELECT (now() AT TIME ZONE 'America/Costa_Rica')::date::text AS fecha,
            to_char((now() AT TIME ZONE 'America/Costa_Rica'), 'HH24:MI') AS hora`);
  return r.rows[0];
}

const solTexto = (v, max) => {
  const t = (v == null) ? '' : String(v).replace(/\s+/g, ' ').trim();
  return t === '' ? null : t.slice(0, max);
};
/* 'YYYY-MM-DD' o null. Cualquier otra cosa es null: no se adivina el formato. */
const solFecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : null);
/* 'HH:MM' en 24 horas, o null. */
const solHora  = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim()) ? String(v).trim() : null);

/* Normaliza el detalle: quita repetidos por codigo de bandeja y recorta. */
function solDetalle(body) {
  const arr = Array.isArray(body && body.detalle) ? body.detalle : [];
  const vistos = new Map();
  for (const d of arr) {
    const cod = normBandeja(d && (d.equipo_codigo != null ? d.equipo_codigo : d.codigo));
    if (!cod || vistos.has(cod)) continue;
    vistos.set(cod, {
      codigo: cod,
      demarcado: solTexto(d && d.demarcado, 60),
      descripcion: solTexto(d && d.descripcion, 300),
      color: solTexto(d && d.color, 40)
    });
  }
  return [...vistos.values()];
}

/* Las validaciones del enunciado, todas juntas. Devuelve [] si esta lista
   para enviarse. */
function validarParaEnviar(sol, detalle, hoy) {
  const faltan = [];
  if (!sol.hospital)      faltan.push('Nombre del hospital');
  if (!sol.cirugia)       faltan.push('Cirugía');
  if (!sol.fecha_cirugia) faltan.push('Fecha de la cirugía');
  if (!sol.hora_cirugia)  faltan.push('Hora de la cirugía');
  if (!sol.cirujano)      faltan.push('Cirujano');
  const errs = [];
  if (faltan.length) errs.push('Complete los campos obligatorios: ' + faltan.join(', ') + '.');
  if (!detalle.length) errs.push('Agregue al menos una bandeja al detalle.');
  if (sol.fecha_cirugia) {
    if (sol.fecha_cirugia < hoy.fecha) {
      errs.push('La fecha de la cirugía no puede ser anterior a hoy.');
    } else if (sol.fecha_cirugia === hoy.fecha && sol.hora_cirugia && sol.hora_cirugia < hoy.hora) {
      /* La hora solo se compara cuando la cirugia es HOY: para una fecha
         futura cualquier hora es valida. */
      errs.push('La cirugía es hoy, así que la hora no puede ser anterior a la hora actual (' + hoy.hora + ').');
    }
  }
  return errs;
}

/* Texto del campo Descripcion del aviso. Lo arma la API para que el correo
   llegue con contexto sin que nadie lo escriba. */
function resumenSolicitud(sol, detalle) {
  const partes = [sol.codigo];
  if (sol.hospital) partes.push(sol.hospital);
  if (sol.fecha_cirugia) {
    const [a, m, d] = sol.fecha_cirugia.split('-');
    partes.push('cirugía del ' + d + '/' + m + '/' + a + (sol.hora_cirugia ? ' ' + sol.hora_cirugia : ''));
  }
  partes.push(detalle.length === 1 ? '1 bandeja' : detalle.length + ' bandejas');
  return partes.join(' — ');
}

const SOL_SELECT = `SELECT s.Id AS id, s.Codigo AS codigo, s.Estado AS estado,
       s.HospitalId AS hospital_id, s.Hospital AS hospital, s.Cirugia AS cirugia,
       s.FechaCirugia::text AS fecha_cirugia, s.HoraCirugia AS hora_cirugia,
       s.Cirujano AS cirujano, s.PacienteCedula AS paciente_cedula,
       s.PacienteNombre AS paciente_nombre,
       s.FechaEntrega::text AS fecha_entrega, s.HoraEntrega AS hora_entrega,
       s.Observaciones AS observaciones,
       /* Como salio la validacion de bandejas, estampado al despachar. */
       s.ValidacionBandejas AS validacion_bandejas,
       s.CreadoPor AS creado_por, s.CreadoPorEmail AS creado_por_email,
       to_char(s.FechaCreacion, 'YYYY-MM-DD HH24:MI') AS fecha_registro,
       to_char(s.FechaEnvio, 'YYYY-MM-DD HH24:MI') AS fecha_envio,
       /* Ultimo movimiento. Con el estado 'Enviado a Hospital' es la fecha en
          que Bodega despacho: no hace falta columna nueva -ni migracion- para
          poder mostrarla. */
       to_char(s.FechaActualizacion, 'YYYY-MM-DD HH24:MI') AS fecha_actualizacion
  FROM dbo.SolicitudEquipo s`;

/* Como va la validacion de bandejas de cada solicitud, para el listado.
   Cuenta bandejas, cuales tienen foto y como salio cada veredicto VIGENTE
   -uno cuya firma ya no calza con las fotos de ahora no cuenta como
   validado, igual que en la pantalla de la bandeja-. */
const SQL_VALIDACION = `
  WITH b AS (
    SELECT d.SolicitudId AS sid,
           (SELECT COUNT(*) FROM dbo.SolicitudFoto f
             WHERE f.SolicitudId = d.SolicitudId
               AND UPPER(TRIM(f.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))) AS nfotos,
           v.Resultado AS res,
           (v.FotosFirma IS NOT NULL AND v.FotosFirma IS DISTINCT FROM
             (SELECT md5(string_agg(f.Id::text, ',' ORDER BY f.Id))
                FROM dbo.SolicitudFoto f
               WHERE f.SolicitudId = d.SolicitudId
                 AND UPPER(TRIM(f.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo)))) AS viejo
      FROM dbo.SolicitudEquipoDetalle d
      LEFT JOIN dbo.SolicitudVerificacion v
        ON v.SolicitudId = d.SolicitudId
       AND UPPER(TRIM(v.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))
     WHERE d.SolicitudId = ANY($1::int[])
  )
  SELECT sid AS id,
         COUNT(*)::int                                                        AS bandejas,
         COUNT(*) FILTER (WHERE nfotos > 0)::int                              AS con_fotos,
         COUNT(*) FILTER (WHERE res IS NOT NULL AND NOT viejo)::int           AS validadas,
         COUNT(*) FILTER (WHERE res = 'Correcta' AND NOT viejo)::int          AS correctas,
         COUNT(*) FILTER (WHERE res = 'Incorrecta' AND NOT viejo)::int        AS incorrectas,
         COUNT(*) FILTER (WHERE res = 'No puedo determinarlo' AND NOT viejo)::int AS dudosas
    FROM b GROUP BY sid`;

/* De los conteos al rotulo de la columna. El orden de las preguntas es el
   orden de importancia: lo que hay que atender primero, primero.
   Se calcula en la API y no en la pantalla para que el imprimible, un correo
   o cualquier otro consumidor digan exactamente lo mismo. */
function estadoValidacion(c) {
  if (!c || !c.bandejas) return { estado: 'Sin validar', detalle: 'La solicitud no tiene bandejas.' };
  const partes = [];
  if (c.correctas)   partes.push(c.correctas + (c.correctas === 1 ? ' correcta' : ' correctas'));
  if (c.incorrectas) partes.push(c.incorrectas + (c.incorrectas === 1 ? ' incorrecta' : ' incorrectas'));
  if (c.dudosas)     partes.push(c.dudosas + ' sin determinar');
  const sinFoto = c.bandejas - c.con_fotos;
  if (sinFoto)       partes.push(sinFoto + (sinFoto === 1 ? ' sin fotos' : ' sin fotos'));
  /* Con fotos pero sin veredicto vigente: se subieron y no se valido, o se
     valido y despues cambiaron las fotos. */
  const pendientes = c.con_fotos - c.validadas;
  if (pendientes)    partes.push(pendientes + (pendientes === 1 ? ' sin validar' : ' sin validar'));

  const detalle = c.validadas + ' de ' + c.bandejas + (c.bandejas === 1 ? ' bandeja validada' : ' bandejas validadas')
    + (partes.length ? ' — ' + partes.join(', ') : '') + '.';

  let estado;
  if (c.incorrectas)                 estado = 'Incorrecta';
  else if (!c.con_fotos)             estado = 'Sin validar';
  else if (pendientes || sinFoto)    estado = 'Falta validar';
  else if (c.dudosas)                estado = 'Sin determinar';
  else                               estado = 'Correcta';
  return { estado, detalle, ...c };
}

/* GET /api/solicitudes?estado=Borrador -> listado de una cejilla. */
app.http('solicitudes-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'solicitudes',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol) && !puedeBodega(rol)) return json(403, { error: 'Su rol no tiene acceso a las solicitudes' });
    const estado = SOL_ESTADOS.find((e) => e.toLowerCase() === String(request.query.get('estado') || '').toLowerCase());
    try {
      const r = await query(
        `${SOL_SELECT}
          ${estado ? 'WHERE s.Estado = $1' : ''}
          ORDER BY s.Id DESC`, estado ? [estado] : []);
      /* Cuantas bandejas lleva cada una, para mostrarlo en el grid sin
         pedir el detalle de cada fila. */
      const ids = r.rows.map((x) => x.id);
      let conteo = {}, avance = {}, valid = {};
      if (ids.length) {
        const c = await query(
          `SELECT SolicitudId AS id, COUNT(*)::int AS n FROM dbo.SolicitudEquipoDetalle
            WHERE SolicitudId = ANY($1::int[]) GROUP BY SolicitudId`, [ids]);
        c.rows.forEach((x) => { conteo[x.id] = x.n; });
        const a = await query(SQL_AVANCE, [ids]);
        a.rows.forEach((x) => { avance[x.id] = x; });
        const vv = await query(SQL_VALIDACION, [ids]);
        vv.rows.forEach((x) => { valid[x.id] = x; });
      }
      return json(200, r.rows.map((x) => {
        const av = avance[x.id] || { total: 0, alistados: 0 };
        const vd = estadoValidacion(valid[x.id]);
        return { ...x, bandejas: conteo[x.id] || 0,
                 articulos: av.total, alistados: av.alistados,
                 porcentaje: pct(av.alistados, av.total),
                 validacion: vd.estado, validacion_detalle: vd.detalle };
      }));
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener las solicitudes', detail: e.message });
    }
  }
});

/* GET /api/solicitudes/{id} -> encabezado + detalle. */
app.http('solicitud-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'solicitudes/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol) && !puedeBodega(rol)) return json(403, { error: 'Su rol no tiene acceso a las solicitudes' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const s = await query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      if (!s.rowCount) return json(404, { error: 'La solicitud no existe' });
      const d = await query(
        `SELECT EquipoCodigo AS equipo_codigo, Demarcado AS demarcado, Descripcion AS descripcion,
                Color AS color
           FROM dbo.SolicitudEquipoDetalle WHERE SolicitudId = $1 ORDER BY Id`, [id]);
      return json(200, { ...s.rows[0], detalle: d.rows });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la solicitud', detail: e.message });
    }
  }
});

/* Lee el encabezado del body y, si mandaron hospital_id, toma el nombre del
   catalogo en vez de confiar en el que venga del cliente. */
async function leerEncabezado(body) {
  const hospitalId = parseInt(body && body.hospital_id, 10) || null;
  let hospital = solTexto(body && body.hospital, 200);
  if (hospitalId) {
    const h = await query(`SELECT Nombre FROM cat.Hospital WHERE Id = $1`, [hospitalId]);
    if (h.rowCount) hospital = h.rows[0].nombre;
  }
  return {
    hospital_id: hospitalId,
    hospital,
    cirugia: solTexto(body && body.cirugia, 400),
    fecha_cirugia: solFecha(body && body.fecha_cirugia),
    hora_cirugia: solHora(body && body.hora_cirugia),
    cirujano: solTexto(body && body.cirujano, 200),
    paciente_cedula: solTexto(body && body.paciente_cedula, 60),
    paciente_nombre: solTexto(body && body.paciente_nombre, 200),
    fecha_entrega: solFecha(body && body.fecha_entrega),
    hora_entrega: solHora(body && body.hora_entrega),
    observaciones: solTexto(body && body.observaciones, 1000)
  };
}

/* El detalle tal como lo lee TODA la aplicacion: con `equipo_codigo`.
   Existe porque POST y PUT devolvian el detalle recien normalizado, que usa
   `codigo`, y la pantalla se lo guardaba en SOL_ACT.detalle: el guardado
   siguiente mandaba equipo_codigo: undefined y la API descartaba las lineas
   por venir sin codigo. Releer de la base cuesta una consulta y ademas
   devuelve el color que resolvio el COALESCE contra cat.Equipo, que el objeto
   normalizado no tenia. */
async function detalleDeSolicitud(id) {
  const d = await query(
    `SELECT EquipoCodigo AS equipo_codigo, Demarcado AS demarcado, Descripcion AS descripcion,
            Color AS color
       FROM dbo.SolicitudEquipoDetalle WHERE SolicitudId = $1 ORDER BY Id`, [id]);
  return d.rows;
}

/* POST /api/bandejas/{codigo}/fotos/leer
   Lee el texto de las fotos del catalogo que todavia no lo tienen.

   Hace falta porque durante un tiempo la subida NO leia: las fotos que se
   cargaron por la pantalla quedaron mudas, y sin texto la bandeja no se puede
   validar. Borrarlas y volverlas a subir tambien serviria, pero perderia el
   rotulo, el orden y quien las subio.

   Reintenta tambien las que quedaron con error -un 429 de Azure, una caida-.
   Devuelve cuantas leyo y cuantas siguen sin texto, con el motivo. */
app.http('bandeja-fotos-leer', {
  methods: ['POST'], authLevel: 'anonymous', route: 'bandejas/{codigo}/fotos/leer',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'No tiene permiso para editar el catálogo de bandejas' });
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!cod) return json(400, { error: 'Código de bandeja inválido' });
    try {
      const b = await codigoDeBandeja(cod);
      if (!b) return json(404, { error: 'Esa bandeja no está en el catálogo' });
      const r = await query(
        `SELECT Id AS id, Rotulo AS rotulo, Nombre AS nombre, Contenido AS contenido
           FROM cat.EquipoFoto
          WHERE EquipoCodigo = $1 AND TextoOcr IS NULL
          ORDER BY Orden, Id`, [b.codigo]);
      if (!r.rowCount) return json(200, { leidas: 0, sinTexto: 0, ya: true });

      let leidas = 0; const sinTexto = [];
      for (const f of r.rows) {
        let texto = null, err = null;
        try {
          texto = textoDe(await analyzeRead(f.contenido)) || null;
          if (!texto) err = 'No se leyó ningún texto en la imagen';
        } catch (e) {
          err = String(e.message || e).slice(0, 300);
          context.warn('No se pudo leer la foto ' + f.id + ': ' + err);
        }
        await query(
          `UPDATE cat.EquipoFoto
              SET TextoOcr = $1, FechaOcr = (now() at time zone 'utc'), ErrorOcr = $2
            WHERE Id = $3`, [texto, err, f.id]);
        if (texto) leidas++;
        else sinTexto.push({ id: f.id, nombre: f.rotulo || f.nombre || ('foto ' + f.id), error: err });
      }
      REF_CACHE = null;   // el corpus cambio
      return json(200, { leidas, sinTexto: sinTexto.length, detalle: sinTexto,
                         codigo: b.demarcado || b.codigo });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo leer el texto de las fotos', detail: e.message });
    }
  }
});

/* Reescribe el detalle completo dentro de la transaccion abierta. */
async function guardarDetalle(client, id, detalle) {
  await client.query(`DELETE FROM dbo.SolicitudEquipoDetalle WHERE SolicitudId = $1`, [id]);
  for (const d of detalle) {
    /* El color se toma del catálogo cuando el cliente no lo manda: la fuente
       de verdad es cat.Equipo, no el navegador. Queda grabado en la línea
       para que una solicitud enviada conserve el color con que se pidió. */
    /* El codigo va como $2 y otra vez como $6 a proposito. Reusar $2 dentro de
       UPPER(TRIM(...)) hacia que Postgres dedujera dos tipos para el mismo
       parametro -varchar por la columna, text por TRIM- y fallara con
       «inconsistent types deduced for parameter $2». */
    await client.query(
      `INSERT INTO dbo.SolicitudEquipoDetalle (SolicitudId, EquipoCodigo, Demarcado, Descripcion, Color)
       VALUES ($1,$2,$3,$4,
               COALESCE($5, (SELECT e.Color FROM cat.Equipo e
                              WHERE UPPER(TRIM(e.Codigo)) = UPPER(TRIM($6)))))`,
      [id, d.codigo, d.demarcado, d.descripcion, d.color, d.codigo]);
  }
}

/* POST /api/solicitudes -> crea el borrador. Guardar no exige nada mas que
   existir: las validaciones son del envio. */
app.http('solicitud-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'solicitudes',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para crear solicitudes' });
    const body = await request.json();
    const enc = await leerEncabezado(body);
    const detalle = solDetalle(body);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const cod = await client.query(
        `SELECT 'ORT-' || lpad(nextval('dbo.SolicitudEquipoSeq')::text, 6, '0') AS codigo`);
      const r = await client.query(
        `INSERT INTO dbo.SolicitudEquipo
           (Codigo, Estado, HospitalId, Hospital, Cirugia, FechaCirugia, HoraCirugia, Cirujano,
            PacienteCedula, PacienteNombre, FechaEntrega, HoraEntrega, Observaciones,
            CreadoPor, CreadoPorEmail)
         VALUES ($1,'Borrador',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING Id`,
        [cod.rows[0].codigo, enc.hospital_id, enc.hospital, enc.cirugia, enc.fecha_cirugia,
         enc.hora_cirugia, enc.cirujano, enc.paciente_cedula, enc.paciente_nombre,
         enc.fecha_entrega, enc.hora_entrega, enc.observaciones,
         user.name || user.email, user.email]);
      const id = r.rows[0].id;
      await guardarDetalle(client, id, detalle);
      await client.query('COMMIT');
      const out = await query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      return json(201, { ...out.rows[0], bandejas: detalle.length, detalle: await detalleDeSolicitud(id) });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo crear la solicitud', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* PUT /api/solicitudes/{id} -> actualiza el borrador. Una Enviada no se toca. */
app.http('solicitud-update', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'solicitudes/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para editar solicitudes' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    const body = await request.json();
    const enc = await leerEncabezado(body);
    const detalle = solDetalle(body);
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const act = await client.query(`SELECT Estado FROM dbo.SolicitudEquipo WHERE Id = $1 FOR UPDATE`, [id]);
      if (!act.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'La solicitud no existe' }); }
      if (act.rows[0].estado !== 'Borrador') {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud ya fue enviada y no se puede modificar' });
      }
      await client.query(
        `UPDATE dbo.SolicitudEquipo
            SET HospitalId=$1, Hospital=$2, Cirugia=$3, FechaCirugia=$4, HoraCirugia=$5, Cirujano=$6,
                PacienteCedula=$7, PacienteNombre=$8, FechaEntrega=$9, HoraEntrega=$10, Observaciones=$11,
                ActualizadoPor=$12, FechaActualizacion=(now() at time zone 'utc')
          WHERE Id=$13`,
        [enc.hospital_id, enc.hospital, enc.cirugia, enc.fecha_cirugia, enc.hora_cirugia, enc.cirujano,
         enc.paciente_cedula, enc.paciente_nombre, enc.fecha_entrega, enc.hora_entrega, enc.observaciones,
         user.name || user.email, id]);
      await guardarDetalle(client, id, detalle);
      await client.query('COMMIT');
      const out = await query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      return json(200, { ...out.rows[0], bandejas: detalle.length, detalle: await detalleDeSolicitud(id) });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo actualizar la solicitud', detail: e.message });
    } finally {
      client.release();
    }
  }
});

/* DELETE /api/solicitudes/{id} -> borra el borrador (el detalle se va en
   cascada). Una Enviada no se borra. */
app.http('solicitud-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'solicitudes/{id}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para eliminar solicitudes' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const r = await query(`DELETE FROM dbo.SolicitudEquipo WHERE Id = $1 AND Estado = 'Borrador'`, [id]);
      if (!r.rowCount) {
        const ex = await query(`SELECT Estado FROM dbo.SolicitudEquipo WHERE Id = $1`, [id]);
        if (!ex.rowCount) return json(404, { error: 'La solicitud no existe' });
        return json(409, { error: 'La solicitud ya fue enviada y no se puede eliminar' });
      }
      return json(200, { ok: true });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo eliminar la solicitud', detail: e.message });
    }
  }
});

/* POST /api/solicitudes/{id}/enviar -> valida, pasa a Enviada y avisa.
   Body opcional: el encabezado y el detalle, para guardar antes de enviar y
   que el usuario no tenga que dar dos botones. */
app.http('solicitud-enviar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'solicitudes/{id}/enviar',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeSubir(await getRole(user))) return json(403, { error: 'No tiene permiso para enviar solicitudes' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const traeEncabezado = body && Object.keys(body).length > 0;

    const client = await getClient();
    let sol, detalle;
    try {
      await client.query('BEGIN');
      const act = await client.query(`SELECT Estado FROM dbo.SolicitudEquipo WHERE Id = $1 FOR UPDATE`, [id]);
      if (!act.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'La solicitud no existe' }); }
      if (act.rows[0].estado !== 'Borrador') {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud ya fue enviada' });
      }
      if (traeEncabezado) {
        const enc = await leerEncabezado(body);
        await client.query(
          `UPDATE dbo.SolicitudEquipo
              SET HospitalId=$1, Hospital=$2, Cirugia=$3, FechaCirugia=$4, HoraCirugia=$5, Cirujano=$6,
                  PacienteCedula=$7, PacienteNombre=$8, FechaEntrega=$9, HoraEntrega=$10, Observaciones=$11,
                  ActualizadoPor=$12, FechaActualizacion=(now() at time zone 'utc')
            WHERE Id=$13`,
          [enc.hospital_id, enc.hospital, enc.cirugia, enc.fecha_cirugia, enc.hora_cirugia, enc.cirujano,
           enc.paciente_cedula, enc.paciente_nombre, enc.fecha_entrega, enc.hora_entrega, enc.observaciones,
           user.name || user.email, id]);
        await guardarDetalle(client, id, solDetalle(body));
      }
      const s = await client.query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      const d = await client.query(
        `SELECT EquipoCodigo AS equipo_codigo, Demarcado AS demarcado, Descripcion AS descripcion,
                Color AS color
           FROM dbo.SolicitudEquipoDetalle WHERE SolicitudId = $1 ORDER BY Id`, [id]);
      sol = s.rows[0]; detalle = d.rows;

      const hoy = await ahoraCR();
      const errs = validarParaEnviar(sol, detalle, hoy);
      if (errs.length) {
        await client.query('ROLLBACK');
        return json(400, { error: errs[0], errores: errs });
      }
      await client.query(
        `UPDATE dbo.SolicitudEquipo
            SET Estado='Enviada', FechaEnvio=(now() at time zone 'utc'),
                ActualizadoPor=$1, FechaActualizacion=(now() at time zone 'utc')
          WHERE Id=$2`, [user.name || user.email, id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo enviar la solicitud', detail: e.message });
    } finally {
      client.release();
    }

    /* El aviso va DESPUES del commit y no puede tumbar el envio: la solicitud
       ya quedo Enviada. Si el flujo falla, el usuario se lleva el aviso para
       coordinar con Bodega por otro medio. */
    let notif = { enviado: false, cuentas: 0, aviso: null };
    try {
      const cuentas = await cuentasDe(query, 'solicitud');
      notif = await notificar({
        descripcion: resumenSolicitud(sol, detalle),
        solicitadoPor: user.email,
        url: urlSolicitud(request, id),
        cuentas
      }, context);
    } catch (e) {
      context.error('Fallo al preparar la notificación: ' + e.message);
      notif = { enviado: false, cuentas: 0, aviso: 'No se pudo preparar el aviso; la solicitud quedó enviada.' };
    }
    const out = await query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
    return json(200, { ...out.rows[0], bandejas: detalle.length, detalle, notificacion: notif });
  }
});


/* ============================================================
   Despacho al hospital
   Bodega cierra el alisto y el equipo sale. Es la transicion que la
   Tabla 6 del documento de requerimientos llama «Equipo Alistado»:
   avisa a las cuentas configuradas para ese evento.
   ============================================================ */

/* Avance por bandeja de una solicitud, para validar el despacho. Devuelve una
   fila por bandeja pedida, con cuantos componentes tiene y cuantos van
   marcados. Un LEFT JOIN, no un JOIN: la bandeja sin componentes en el
   catalogo tiene que aparecer igual, con articulos = 0. */
const SQL_AVANCE_BANDEJA = `
  SELECT d.EquipoCodigo AS codigo,
         COALESCE(d.Demarcado, d.EquipoCodigo) AS demarcado,
         COUNT(ep.ProductoCodigo)::int AS articulos,
         COUNT(a.Id)::int              AS alistados
    FROM dbo.SolicitudEquipoDetalle d
    LEFT JOIN cat.EquipoProducto ep
      ON UPPER(TRIM(ep.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))
    LEFT JOIN dbo.SolicitudAlisto a
      ON a.SolicitudId = d.SolicitudId
     AND UPPER(TRIM(a.EquipoCodigo))   = UPPER(TRIM(d.EquipoCodigo))
     AND UPPER(TRIM(a.ProductoCodigo)) = UPPER(TRIM(ep.ProductoCodigo))
   WHERE d.SolicitudId = $1
   GROUP BY d.Id, d.EquipoCodigo, d.Demarcado
   ORDER BY d.Id`;

/* POST /api/solicitudes/{id}/despachar
   Cierra el alisto y pasa la solicitud a «Enviado a Hospital».

   La regla: toda bandeja QUE TENGA componentes en el catalogo necesita al
   menos uno marcado. Una bandeja sin componentes registrados no se puede
   alistar -no hay nada que marcar-, asi que no bloquea: sale en `avisos`
   para que la pantalla lo advierta antes de despachar. Bloquearla dejaria la
   solicitud trabada hasta que alguien complete el catalogo. */
app.http('solicitud-despachar', {
  methods: ['POST'], authLevel: 'anonymous', route: 'solicitudes/{id}/despachar',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega puede enviar el equipo al hospital' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });

    const client = await getClient();
    let sol, detalle, avisos = [], avisosValid = [], validacion = 'Sin validar';
    try {
      await client.query('BEGIN');
      const est = await client.query(`SELECT Estado FROM dbo.SolicitudEquipo WHERE Id = $1 FOR UPDATE`, [id]);
      if (!est.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'La solicitud no existe' }); }
      const estado = est.rows[0].estado;
      if (estado === SOL_DESPACHADA) {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud ya se envió al hospital' });
      }
      if (!SOL_ALISTABLES.includes(estado)) {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud está en estado ' + estado + ': el hospital todavía no la envió' });
      }

      const av = await client.query(SQL_AVANCE_BANDEJA, [id]);
      if (!av.rowCount) {
        await client.query('ROLLBACK');
        return json(400, { error: 'La solicitud no tiene bandejas' });
      }
      const sinAlistar = av.rows.filter((b) => b.articulos > 0 && b.alistados === 0);
      if (sinAlistar.length) {
        await client.query('ROLLBACK');
        const nombres = sinAlistar.map((b) => b.demarcado).join(', ');
        return json(400, {
          error: sinAlistar.length === 1
            ? 'La bandeja ' + nombres + ' no tiene ningún componente alistado.'
            : 'Estas bandejas no tienen ningún componente alistado: ' + nombres + '.',
          bandejas: sinAlistar.map((b) => b.demarcado)
        });
      }
      avisos = av.rows.filter((b) => b.articulos === 0).map((b) => b.demarcado);

      /* Validacion: ESTAMPA y AVISA, nunca bloquea. Es la seccion 8.5 -ninguna
         verificacion automatica aprueba una entrega, y tampoco la impide- y
         esta medido: con el veredicto como candado, 4 de las 12 bandejas del
         Paso 0 no se podrian despachar hoy, todas por errores del catalogo.
         Validada = la bandeja tiene foto. El veredicto -del sistema o de una
         persona- se avisa aparte cuando dice «Incorrecta». */
      const vv = await client.query(
        `SELECT COALESCE(d.Demarcado, d.EquipoCodigo) AS demarcado,
                v.Resultado AS veredicto, v.Origen AS origen,
                (SELECT COUNT(*)::int FROM dbo.SolicitudFoto f
                  WHERE f.SolicitudId = d.SolicitudId
                    AND UPPER(TRIM(f.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))) AS fotos
           FROM dbo.SolicitudEquipoDetalle d
           LEFT JOIN dbo.SolicitudVerificacion v
             ON v.SolicitudId = d.SolicitudId
            AND UPPER(TRIM(v.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))
          WHERE d.SolicitudId = $1
          ORDER BY d.Id`, [id]);
      const conFoto = vv.rows.filter((b) => b.fotos > 0).length;
      validacion = conFoto === 0 ? 'Sin validar'
                 : conFoto === vv.rowCount ? 'Validada' : 'Parcial';
      avisosValid = vv.rows
        .filter((b) => !b.fotos || b.veredicto === 'Incorrecta')
        .map((b) => b.demarcado + (!b.fotos ? ' (sin foto)'
              : ' (⚠ INCORRECTA' + (b.origen === 'Persona' ? ', dicho por Bodega' : '') + ')'));

      await client.query(
        `UPDATE dbo.SolicitudEquipo
            SET Estado = $1, ActualizadoPor = $2, ValidacionBandejas = $4,
                FechaActualizacion = (now() at time zone 'utc')
          WHERE Id = $3`, [SOL_DESPACHADA, user.name || user.email, id, validacion]);

      const s = await client.query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      const d = await client.query(
        `SELECT EquipoCodigo AS equipo_codigo, Demarcado AS demarcado, Descripcion AS descripcion,
                Color AS color
           FROM dbo.SolicitudEquipoDetalle WHERE SolicitudId = $1 ORDER BY Id`, [id]);
      sol = s.rows[0]; detalle = d.rows;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo enviar la solicitud al hospital', detail: e.message });
    } finally {
      client.release();
    }

    /* El aviso va DESPUES del commit y no puede tumbar el despacho, igual que
       en el envio del hospital: el equipo ya salio. */
    let notif = { enviado: false, cuentas: 0, aviso: null };
    try {
      const cuentas = await cuentasDe(query, 'alistado');
      notif = await notificar({
        /* Las bandejas que salieron sin check list van en la descripcion: es
           el dato que Bodega y el hospital necesitan ver en el aviso, no en
           el log. El flujo es generico y solo pinta este texto. */
        descripcion: 'Equipo alistado — ' + resumenSolicitud(sol, detalle)
          + ((avisos && avisos.length) ? ' — sin check list: ' + avisos.join(', ') : '')
          /* Lo que no se valido va en el aviso y no solo en el log: es lo que
             el hospital necesita saber cuando reciba la bandeja. */
          + ((avisosValid && avisosValid.length) ? ' — validación: ' + avisosValid.join(', ') : ''),
        solicitadoPor: user.email,
        url: urlSolicitud(request, id),
        cuentas
      }, context);
    } catch (e) {
      context.error('Fallo al preparar la notificación de alistado: ' + e.message);
      notif = { enviado: false, cuentas: 0, aviso: 'No se pudo preparar el aviso; el equipo quedó enviado al hospital.' };
    }
    return json(200, { ...sol, bandejas: detalle.length, detalle, avisos,
                       validacion_bandejas: validacion, avisos_validacion: avisosValid, notificacion: notif });
  }
});

/* POST /api/solicitudes/{id}/devolver
   Bodega regresa la solicitud al hospital para que le haga cambios. Es el
   caso que la seccion 5.4 del documento de requerimientos dejaba por
   definir: que pasa cuando una solicitud ya enviada tiene que modificarse.

   Vuelve a 'Borrador', que es el UNICO estado que el hospital puede editar,
   y con eso reaparece en su cejilla Borrador.

   EL ALISTO SE DESCARTA. Decision de Luis, y es la que calza con volver a
   Borrador: el hospital puede cambiar las bandejas, y unas marcas puestas
   contra un pedido distinto no son un dato, son un dato equivocado. Bodega
   vuelve a marcar desde cero cuando la solicitud regrese.

   FechaEnvio se limpia: un Borrador con fecha de envio se contradice, y el
   reenvio la vuelve a poner. */
app.http('solicitud-devolver', {
  methods: ['POST'], authLevel: 'anonymous', route: 'solicitudes/{id}/devolver',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega puede devolver la solicitud al hospital' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });

    const client = await getClient();
    let sol, detalle, borradas = 0;
    try {
      await client.query('BEGIN');
      const est = await client.query(`SELECT Estado FROM dbo.SolicitudEquipo WHERE Id = $1 FOR UPDATE`, [id]);
      if (!est.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'La solicitud no existe' }); }
      const estado = est.rows[0].estado;
      if (estado === 'Borrador') {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud ya está en Borrador: el hospital la puede editar' });
      }
      /* Despachada NO se devuelve: el equipo ya salio del almacen. Para eso
         esta «Reabrir alisto», que la trae de vuelta a En Preparación. */
      if (!SOL_ALISTABLES.includes(estado)) {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud está en ' + estado + '. Use «Reabrir alisto» antes de devolverla al hospital.' });
      }

      const del = await client.query(`DELETE FROM dbo.SolicitudAlisto WHERE SolicitudId = $1`, [id]);
      borradas = del.rowCount || 0;
      await client.query(
        `UPDATE dbo.SolicitudEquipo
            SET Estado = 'Borrador', FechaEnvio = NULL, ActualizadoPor = $1,
                FechaActualizacion = (now() at time zone 'utc')
          WHERE Id = $2`, [user.name || user.email, id]);

      const s = await client.query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      const d = await client.query(
        `SELECT EquipoCodigo AS equipo_codigo, Demarcado AS demarcado, Descripcion AS descripcion,
                Color AS color
           FROM dbo.SolicitudEquipoDetalle WHERE SolicitudId = $1 ORDER BY Id`, [id]);
      sol = s.rows[0]; detalle = d.rows;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo devolver la solicitud al hospital', detail: e.message });
    } finally {
      client.release();
    }

    /* Despues del commit y sin poder tumbarlo, igual que los otros avisos. */
    let notif = { enviado: false, cuentas: 0, aviso: null };
    try {
      const cuentas = await cuentasDe(query, 'devuelta');
      notif = await notificar({
        descripcion: 'Solicitud devuelta al hospital para cambios — ' + resumenSolicitud(sol, detalle)
          + (borradas ? ' — se descartaron ' + borradas + (borradas === 1 ? ' marca' : ' marcas') + ' del alisto' : ''),
        solicitadoPor: user.email,
        url: urlSolicitud(request, id),
        cuentas
      }, context);
    } catch (e) {
      context.error('Fallo al preparar la notificación de devolución: ' + e.message);
      notif = { enviado: false, cuentas: 0, aviso: 'No se pudo preparar el aviso; la solicitud quedó en Borrador.' };
    }
    return json(200, { ...sol, bandejas: detalle.length, detalle, alisto_borrado: borradas, notificacion: notif });
  }
});

/* POST /api/solicitudes/{id}/reabrir
   Devuelve una solicitud despachada a «En Preparación» para corregir el
   alisto. No se avisa a nadie: el aviso de alistado ya salio y un segundo
   correo diciendo lo contrario confunde mas que ayuda. Queda el registro en
   ActualizadoPor. */
app.http('solicitud-reabrir', {
  methods: ['POST'], authLevel: 'anonymous', route: 'solicitudes/{id}/reabrir',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega puede reabrir el alisto' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const r = await query(
        `UPDATE dbo.SolicitudEquipo
            SET Estado = 'En Preparación', ActualizadoPor = $1,
                FechaActualizacion = (now() at time zone 'utc')
          WHERE Id = $2 AND Estado = $3
          RETURNING Id`, [user.name || user.email, id, SOL_DESPACHADA]);
      if (!r.rowCount) {
        return json(409, { error: 'Solo se puede reabrir una solicitud que ya se envió al hospital' });
      }
      const out = await query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      return json(200, out.rows[0]);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo reabrir el alisto', detail: e.message });
    }
  }
});

/* ============================================================
   Alistado de Bodega
   Bodega ve las solicitudes que ya salieron del hospital y va marcando
   los componentes de cada bandeja. El porcentaje se calcula por
   componente: uno vale uno, sin ponderar por cantidad.

   Los totales salen de cat.EquipoProducto, que es el contenido real de
   la bandeja. Si una bandeja no tiene componentes registrados, su
   porcentaje es null y no arrastra el de la solicitud hacia abajo.
   ============================================================ */

/* Estados en los que la solicitud ya salio del hospital. La cejilla
   «Enviado» los muestra juntos: para el hospital sigue estando enviada
   aunque Bodega ya la este alistando. */
const SOL_ENVIADAS = ['Enviada', 'En Preparación'];

/* Avance por solicitud: componentes marcados sobre el total de las
   bandejas pedidas. */
const SQL_AVANCE = `
  SELECT d.SolicitudId AS id,
         COUNT(ep.ProductoCodigo)::int AS total,
         COUNT(a.Id)::int              AS alistados
    FROM dbo.SolicitudEquipoDetalle d
    JOIN cat.EquipoProducto ep
      ON UPPER(TRIM(ep.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))
    LEFT JOIN dbo.SolicitudAlisto a
      ON a.SolicitudId = d.SolicitudId
     AND UPPER(TRIM(a.EquipoCodigo))   = UPPER(TRIM(d.EquipoCodigo))
     AND UPPER(TRIM(a.ProductoCodigo)) = UPPER(TRIM(ep.ProductoCodigo))
   WHERE d.SolicitudId = ANY($1::int[])
   GROUP BY d.SolicitudId`;

const pct = (alistados, total) => (total > 0 ? Math.round((alistados * 100) / total) : null);

/* GET /api/solicitudes/{id}/bandejas -> bandejas de la solicitud con su
   avance y cuantos articulos tiene cada una. */
app.http('solicitud-bandejas', {
  methods: ['GET'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol) && !puedeBodega(rol)) return json(403, { error: 'Su rol no tiene acceso a las solicitudes' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const r = await query(
        /* El veredicto entra por LEFT JOIN -una fila por bandeja como maximo,
           no multiplica- y las fotos por subconsulta: un segundo JOIN a
           SolicitudFoto duplicaria las filas del GROUP BY y el porcentaje del
           alisto saldria inflado. */
        `SELECT d.EquipoCodigo AS equipo_codigo, d.Demarcado AS demarcado,
                d.Descripcion AS descripcion, d.Color AS color,
                COUNT(ep.ProductoCodigo)::int AS articulos,
                COUNT(a.Id)::int              AS alistados,
                v.Resultado AS veredicto, v.Origen AS veredicto_origen,
                (SELECT COUNT(*)::int FROM dbo.SolicitudFoto f
                  WHERE f.SolicitudId = d.SolicitudId
                    AND UPPER(TRIM(f.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))) AS fotos,
                /* El veredicto habla de las fotos que vio. Si las de ahora son
                   otras, la fila no puede seguir diciendo «Correcta». */
                (v.FotosFirma IS NOT NULL AND v.FotosFirma IS DISTINCT FROM
                  (SELECT md5(string_agg(f.Id::text, ',' ORDER BY f.Id))
                     FROM dbo.SolicitudFoto f
                    WHERE f.SolicitudId = d.SolicitudId
                      AND UPPER(TRIM(f.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo)))) AS veredicto_viejo
           FROM dbo.SolicitudEquipoDetalle d
           LEFT JOIN cat.EquipoProducto ep
             ON UPPER(TRIM(ep.EquipoCodigo)) = UPPER(TRIM(d.EquipoCodigo))
           LEFT JOIN dbo.SolicitudAlisto a
             ON a.SolicitudId = d.SolicitudId
            AND UPPER(TRIM(a.EquipoCodigo))   = UPPER(TRIM(d.EquipoCodigo))
            AND UPPER(TRIM(a.ProductoCodigo)) = UPPER(TRIM(ep.ProductoCodigo))
           LEFT JOIN dbo.SolicitudVerificacion v
             ON v.SolicitudId = d.SolicitudId
            AND UPPER(TRIM(v.EquipoCodigo))   = UPPER(TRIM(d.EquipoCodigo))
          WHERE d.SolicitudId = $1
          GROUP BY d.Id, d.EquipoCodigo, d.Demarcado, d.Descripcion, d.Color, v.Resultado, v.Origen, v.FotosFirma
          ORDER BY d.Id`, [id]);
      return json(200, r.rows.map((x) => ({ ...x, porcentaje: pct(x.alistados, x.articulos) })));
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener las bandejas de la solicitud', detail: e.message });
    }
  }
});

/* GET /api/solicitudes/{id}/bandejas/{codigo}/checklist
   -> encabezado de la solicitud, datos de la bandeja y sus componentes
      con el check puesto. Todo lo que necesita la pantalla y tambien el
      documento para imprimir. */
app.http('solicitud-checklist', {
  methods: ['GET'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/checklist',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol) && !puedeBodega(rol)) return json(403, { error: 'Su rol no tiene acceso a las solicitudes' });
    const id = parseInt(request.params.id, 10);
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!id || !cod) return json(400, { error: 'Solicitud o bandeja inválida' });
    try {
      const s = await query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      if (!s.rowCount) return json(404, { error: 'La solicitud no existe' });
      const b = await query(
        `SELECT d.EquipoCodigo AS equipo_codigo, d.Demarcado AS demarcado,
                d.Descripcion AS descripcion, d.Color AS color,
                e.Categoria AS categoria
           FROM dbo.SolicitudEquipoDetalle d
           LEFT JOIN cat.Equipo e ON UPPER(TRIM(e.Codigo)) = UPPER(TRIM(d.EquipoCodigo))
          WHERE d.SolicitudId = $1 AND UPPER(TRIM(d.EquipoCodigo)) = UPPER(TRIM($2))`, [id, cod]);
      if (!b.rowCount) return json(404, { error: 'Esa bandeja no está en la solicitud' });
      /* El Tipo viene de cat.EquipoProducto: es lo que separa las dos
         secciones del documento, Instrumental e Implantes. */
      /* La descripcion se pide como descripcion_guardada a proposito: la
         oficial la pone conDescripcion() desde el catalogo de productos, y
         esta queda de respaldo. Leerla directo dejaba en blanco todo
         componente que entro por 10_EquipoProducto.sql y no venia en el
         export de SharePoint de la 21: en la bandeja NUT-10104 salian con
         un «—» por descripcion, en pantalla y en el documento impreso. */
      const d = await query(
        `SELECT ep.ProductoCodigo AS producto, ep.DescripcionProducto AS descripcion_guardada,
                ep.Cantidad::float8 AS cantidad, COALESCE(ep.Tipo, 'SIN TIPO') AS tipo,
                (a.Id IS NOT NULL) AS alistado
           FROM cat.EquipoProducto ep
           LEFT JOIN dbo.SolicitudAlisto a
             ON a.SolicitudId = $1
            AND UPPER(TRIM(a.EquipoCodigo))   = UPPER(TRIM($2))
            AND UPPER(TRIM(a.ProductoCodigo)) = UPPER(TRIM(ep.ProductoCodigo))
          WHERE UPPER(TRIM(ep.EquipoCodigo)) = UPPER(TRIM($2))
          ORDER BY COALESCE(ep.Tipo,'SIN TIPO'), ep.ProductoCodigo`, [id, cod]);
      const alistados = d.rows.filter((x) => x.alistado).length;
      /* Mismo camino que la pantalla de Bandejas: si el flujo de productos no
         responde, mapaCatalogo() devuelve un Map vacio y conDescripcion() cae
         en la guardada. El check list nunca se queda sin abrir por eso. */
      const mapa = await mapaCatalogo(context);
      return json(200, {
        solicitud: s.rows[0],
        bandeja: { ...b.rows[0], articulos: d.rowCount, alistados, porcentaje: pct(alistados, d.rowCount) },
        componentes: conDescripcion(d.rows, mapa)
      });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener el check list', detail: e.message });
    }
  }
});

/* PUT /api/solicitudes/{id}/bandejas/{codigo}/checklist
   Body: { productos: ["24267004", ...],
           cantidades: { "24267004": 12, ... } }
   `productos` son los que quedan marcados: se reescribe el alistado de esa
   bandeja y lo que no venga se desmarca.

   `cantidades` corrige cuantas piezas LLEVA la bandeja, en
   cat.EquipoProducto. OJO CON EL ALCANCE: eso es el CATALOGO de la bandeja,
   compartido por todas las solicitudes, no un dato de esta. Bodega esta
   corrigiendo el contenido de la NUT, y la correccion vale para las
   solicitudes futuras de esa bandeja. Es a proposito: nueve lineas vinieron
   en cero desde SharePoint y esta es otra via para arreglarlas sin ir a la
   pantalla de Bandejas.
   Solo se aceptan cantidades mayores que cero, igual que la pantalla de
   Bandejas: la API no crea ceros nuevos aunque la base los permita para los
   que ya venian asi. */
app.http('solicitud-checklist-guardar', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/checklist',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega puede alistar el equipo' });
    const id = parseInt(request.params.id, 10);
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!id || !cod) return json(400, { error: 'Solicitud o bandeja inválida' });
    const body = await request.json();
    /* Se acepta solo lo que de verdad pertenece a la bandeja: el navegador
       no decide que es un componente valido. */
    const pedidos = [...new Set((Array.isArray(body && body.productos) ? body.productos : [])
      .map((x) => normCod(x)).filter(Boolean))];
    /* Cantidades a corregir: se normaliza la llave igual que el codigo y se
       descarta lo que no sea un numero mayor que cero. Un valor invalido se
       ignora en silencio en vez de tumbar el guardado: perder las marcas por
       un dedazo en una cantidad seria peor. */
    const cants = new Map();
    const cantBody = (body && body.cantidades && typeof body.cantidades === 'object') ? body.cantidades : {};
    for (const k of Object.keys(cantBody)) {
      const c = normCod(k);
      const v = Number(cantBody[k]);
      if (c && Number.isFinite(v) && v > 0) cants.set(c, Math.round(v * 100) / 100);
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const est = await client.query(`SELECT Estado FROM dbo.SolicitudEquipo WHERE Id = $1 FOR UPDATE`, [id]);
      if (!est.rowCount) { await client.query('ROLLBACK'); return json(404, { error: 'La solicitud no existe' }); }
      if (est.rows[0].estado === 'Borrador') {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud todavía es un borrador; el hospital no la ha enviado' });
      }
      /* El check list de una solicitud ya despachada es solo lectura. La
         pantalla tambien lo impide, pero la regla vive aca: es el registro de
         con que salio el equipo del almacen. */
      if (est.rows[0].estado === SOL_DESPACHADA) {
        await client.query('ROLLBACK');
        return json(409, { error: 'La solicitud ya se envió al hospital: el check list quedó cerrado. Use «Reabrir alisto» si necesita corregirlo.' });
      }
      const enBandeja = await client.query(
        `SELECT ProductoCodigo AS producto FROM cat.EquipoProducto
          WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($1))`, [cod]);
      const validos = new Set(enBandeja.rows.map((x) => normCod(x.producto)));
      const marcar = pedidos.filter((x) => validos.has(x));

      await client.query(
        `DELETE FROM dbo.SolicitudAlisto
          WHERE SolicitudId = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))`, [id, cod]);
      for (const prod of marcar) {
        await client.query(
          `INSERT INTO dbo.SolicitudAlisto (SolicitudId, EquipoCodigo, ProductoCodigo, AlistadoPor)
           VALUES ($1,$2,$3,$4)`, [id, cod, prod, user.name || user.email]);
      }
      /* Las cantidades corregidas, solo para los productos que de verdad
         estan en esta bandeja y solo cuando el valor cambia: asi la bitacora
         y FechaActualizacion no se mueven por guardar sin tocar nada. */
      let cantCambiadas = 0;
      for (const [prod, val] of cants) {
        if (!validos.has(prod)) continue;
        const up = await client.query(
          `UPDATE cat.EquipoProducto
              SET Cantidad = $1, ActualizadoPor = $2,
                  FechaActualizacion = (now() at time zone 'utc')
            WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($3))
              AND UPPER(TRIM(ProductoCodigo)) = UPPER(TRIM($4))
              AND Cantidad <> $1`,
          [val, user.name || user.email, cod, prod]);
        cantCambiadas += up.rowCount || 0;
      }

      /* El primer guardado marca que Bodega empezo. No se revierte sola si
         despues se desmarca todo: el trabajo ya arranco. */
      let estado = est.rows[0].estado;
      if (estado === 'Enviada') {
        await client.query(
          `UPDATE dbo.SolicitudEquipo
              SET Estado = 'En Preparación', ActualizadoPor = $1,
                  FechaActualizacion = (now() at time zone 'utc')
            WHERE Id = $2`, [user.name || user.email, id]);
        estado = 'En Preparación';
      }
      await client.query('COMMIT');
      const total = validos.size;
      return json(200, {
        estado, alistados: marcar.length, articulos: total, porcentaje: pct(marcar.length, total),
        ignorados: pedidos.length - marcar.length, cantidades_cambiadas: cantCambiadas
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      context.error(e);
      return json(500, { error: 'No se pudo guardar el alistado', detail: e.message });
    } finally {
      client.release();
    }
  }
});


/* ============================================================
   Validacion de la bandeja alistada — veredicto automatico
   ------------------------------------------------------------
   Bodega sube las fotos de la bandeja que alisto y toca «Validar». La API lee
   el texto impreso con Document Intelligence, lo compara contra el de las
   fotos de referencia del catalogo (cat.EquipoFoto, migracion 32) y contesta
   una de tres cosas: Correcta, Incorrecta -diciendo a que se parece mas- o No
   puedo determinarlo.

   El OCR corre AL SUBIR cada foto, no al validar. Asi el boton contesta al
   instante en vez de hacer esperar cuarenta segundos frente a la estanteria.
   Si la lectura falla, la foto se guarda igual con el error anotado: la foto
   vale como evidencia aunque no se haya podido leer.

   Cualquiera de los tres veredictos lo puede confirmar o desmentir una
   persona desde la comparacion a pantalla completa, y eso queda registrado
   con nombre y hora. La marca manual es DISTINTA de la automatica: dentro de
   tres meses tiene que poder saberse si la bandeja la aprobo el sistema o la
   aprobo alguien mirando.

   NADA BLOQUEA EL DESPACHO. Ver la migracion 33 y la seccion 8.5.
   ============================================================ */

const comparar = require('./comparar');
const { analyzeRead, textoDe } = require('./layout');

const FOTO_ENTREGA_MAX = 6;
const COLOR_ILEGIBLE = 'No se distingue';
const COLORES_DEMARCACION = ['Amarillo', 'Azul', 'Blanco', 'Café', 'Gris', 'Morado', 'Naranja', 'Negro', 'Rojo', 'Verde'];
const FECHA_VALID = `to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;

const colorKey = (v) => comparar.normalizar(v);

/* Bandejas con EXACTAMENTE el mismo contenido. Son el unico caso que el texto
   no puede resolver nunca: imprimen los mismos codigos y los mismos nombres.
   74 de 118 bandejas tienen al menos una. */
const SQL_GEMELAS = `
  WITH huella AS (
    SELECT UPPER(TRIM(EquipoCodigo)) AS cod,
           md5(string_agg(UPPER(TRIM(ProductoCodigo)), '|'
                          ORDER BY UPPER(TRIM(ProductoCodigo)))) AS h
      FROM cat.EquipoProducto GROUP BY 1)
  SELECT g.cod AS codigo, e.Demarcado AS demarcado, e.Nombre AS nombre, e.Color AS color
    FROM huella g
    JOIN huella yo ON yo.cod = UPPER(TRIM($1))
    JOIN cat.Equipo e ON UPPER(TRIM(e.Codigo)) = g.cod
   WHERE g.h = yo.h AND g.cod <> yo.cod
   ORDER BY g.cod`;

async function bandejaDeSolicitud(id, cod) {
  const r = await query(
    `SELECT d.EquipoCodigo AS equipo_codigo, d.Demarcado AS demarcado,
            d.Descripcion AS descripcion, d.Color AS color_solicitud,
            e.Color AS color_catalogo, e.Nombre AS nombre
       FROM dbo.SolicitudEquipoDetalle d
       LEFT JOIN cat.Equipo e ON UPPER(TRIM(e.Codigo)) = UPPER(TRIM(d.EquipoCodigo))
      WHERE d.SolicitudId = $1 AND UPPER(TRIM(d.EquipoCodigo)) = UPPER(TRIM($2))`, [id, cod]);
  return r.rowCount ? r.rows[0] : null;
}

/* La firma de las fotos que hay AHORA en la entrega de esta bandeja: el md5
   de sus Id, en orden. Es lo que permite saber despues si el veredicto
   guardado sigue hablando de estas fotos o de otras.
   Sin fotos devuelve null, que nunca coincide con una firma guardada. */
const SQL_FIRMA_FOTOS = `
  SELECT md5(string_agg(Id::text, ',' ORDER BY Id)) AS firma
    FROM dbo.SolicitudFoto
   WHERE SolicitudId = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))`;
async function firmaFotos(id, cod, client) {
  const q = client ? client.query.bind(client) : query;
  const r = await q(SQL_FIRMA_FOTOS, [id, cod]);
  return r.rows[0] ? r.rows[0].firma : null;
}

async function veredictoDe(id, cod) {
  const r = await query(
    `SELECT Resultado AS resultado, Origen AS origen, Motivo AS motivo,
            Puntaje::float8 AS puntaje, CandidatoCodigo AS candidato,
            CandidatoPuntaje::float8 AS candidato_puntaje,
            ColorObservado AS color_observado, ColorCatalogo AS color_catalogo,
            Nota AS nota, Usuario AS usuario, FotosFirma AS fotos_firma,
            ${FECHA_VALID} AS fecha
       FROM dbo.SolicitudVerificacion
      WHERE SolicitudId = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))`, [id, cod]);
  if (!r.rowCount) return null;
  const v = r.rows[0];
  /* Un veredicto habla de UN conjunto de fotos. Si el de ahora no es el mismo,
     lo que dice ya no aplica y la pantalla tiene que pedir otra validacion.
     FotosFirma en NULL es un veredicto anterior a la migracion 34: no se sabe
     que fotos vio, asi que no se le reclama nada. */
  const actual = await firmaFotos(id, cod);
  v.desactualizado = v.fotos_firma != null && v.fotos_firma !== actual;
  return v;
}

/* Las referencias de TODAS las bandejas que tengan texto leido. Hacen falta
   completas y no solo la de la pedida: el IDF necesita el corpus, y sin el
   una etiqueta que esta en las 118 pesaria igual que una unica.
   Se cachea un minuto: son 118 filas de texto y la pantalla las pide por cada
   validacion, pero cambian solo cuando alguien sube una foto al catalogo. */
/* Se pone en null desde los handlers del catalogo -subir, borrar y leer una
   foto- para que la validacion no siga comparando contra el corpus de hace un
   minuto. Es `let` de modulo: se asigna desde cualquier handler del archivo. */
let REF_CACHE = null, REF_CACHE_T = 0;
const REF_CACHE_MS = 60000;
async function referencias(context) {
  if (REF_CACHE && (Date.now() - REF_CACHE_T) < REF_CACHE_MS) return REF_CACHE;
  const r = await query(
    `SELECT UPPER(TRIM(EquipoCodigo)) AS codigo, TextoOcr AS texto
       FROM cat.EquipoFoto WHERE TextoOcr IS NOT NULL AND BTRIM(TextoOcr) <> ''`);
  const refs = {};
  for (const f of r.rows) (refs[f.codigo] = refs[f.codigo] || []).push(f.texto);
  REF_CACHE = refs; REF_CACHE_T = Date.now();
  if (context) context.log('Referencias de bandeja en cache: ' + Object.keys(refs).length);
  return refs;
}

/* GET /api/solicitudes/{id}/bandejas/{codigo}/validacion */
app.http('solicitud-validacion-get', {
  methods: ['GET'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/validacion',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol) && !puedeBodega(rol)) return json(403, { error: 'Su rol no tiene acceso a las solicitudes' });
    const id = parseInt(request.params.id, 10);
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!id || !cod) return json(400, { error: 'Solicitud o bandeja inválida' });
    try {
      const s = await query(`${SOL_SELECT} WHERE s.Id = $1`, [id]);
      if (!s.rowCount) return json(404, { error: 'La solicitud no existe' });
      const b = await bandejaDeSolicitud(id, cod);
      if (!b) return json(404, { error: 'Esa bandeja no está en la solicitud' });

      const abierta = SOL_ALISTABLES.includes(s.rows[0].estado);
      const puede = abierta && puedeBodega(rol);

      const [g, ref, ent] = await Promise.all([
        query(SQL_GEMELAS, [cod]),
        query(`SELECT Id AS id, Rotulo AS rotulo, Orden AS orden,
                      (TextoOcr IS NOT NULL) AS leida, TextoOcr AS texto
                 FROM cat.EquipoFoto WHERE UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($1))
                ORDER BY Orden, Id`, [cod]),
        query(`SELECT Id AS id, Nombre AS nombre, Bytes AS bytes, Usuario AS usuario,
                      UsuarioEmail AS usuario_email, ErrorOcr AS error_ocr,
                      (TextoOcr IS NOT NULL) AS leida, TextoOcr AS texto, ${FECHA_VALID} AS fecha
                 FROM dbo.SolicitudFoto
                WHERE SolicitudId = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))
                ORDER BY Id`, [id, cod])
      ]);

      /* Que foto de la entrega va con que foto del catalogo. Se calcula con el
         texto que ya se leyo -no cuesta nada- y es lo que permite que el
         comparador las ponga lado a lado aunque Bodega las haya tomado en otro
         orden. El texto NO se manda a la pantalla: pesa y no se muestra. */
      const pareo = comparar.parear(
        ref.rows.filter((x) => x.texto).map((x) => ({ id: x.id, texto: x.texto })),
        ent.rows.filter((x) => x.texto).map((x) => ({ id: x.id, texto: x.texto })));

      return json(200, {
        solicitud: s.rows[0],
        bandeja: { equipo_codigo: b.equipo_codigo, demarcado: b.demarcado, descripcion: b.descripcion,
                   nombre: b.nombre, color_catalogo: b.color_catalogo },
        gemelas: g.rows,
        gemelas_mismo_color: g.rows.filter((x) => colorKey(b.color_catalogo) && colorKey(x.color) === colorKey(b.color_catalogo)).length,
        referencia: ref.rows.map(({ texto, ...x }) => x),
        referencia_leidas: ref.rows.filter((x) => x.leida).length,
        pareo,
        /* `ajena` sale del MISMO clasificador que usa el veredicto, para que la
           pantalla y el motivo nunca digan cosas distintas de la misma foto.
           Se calcula al vuelo con el texto que ya esta en la fila: no hace
           falta columna nueva ni migracion. */
        fotos: ent.rows.map(({ texto, ...x }) => {
          const aj = texto ? comparar.clasificarAjena(texto) : null;
          return {
            ...x,
            ajena: aj ? { tipo: aj.tipo, etiqueta: aj.etiqueta } : null,
            puede_eliminar: puede && String(x.usuario_email || '').toLowerCase() === String(user.email || '').toLowerCase()
          };
        }),
        veredicto: await veredictoDe(id, cod),
        /* Se puede validar en cuanto haya una foto. */
        puede_validar: puede,
        tiene_fotos: ent.rowCount > 0,
        maximo: FOTO_ENTREGA_MAX,
        colores: COLORES_DEMARCACION
      });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la validación', detail: e.message });
    }
  }
});

/* GET .../validacion/fotos/{fid} -> una foto de la entrega. */
app.http('solicitud-validacion-foto', {
  methods: ['GET'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/validacion/fotos/{fid}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const rol = await getRole(user);
    if (!puedeSubir(rol) && !puedeBodega(rol)) return json(403, { error: 'Su rol no tiene acceso a las solicitudes' });
    const id = parseInt(request.params.id, 10);
    const fid = parseInt(request.params.fid, 10);
    if (!id || !fid) return json(400, { error: 'Id inválido' });
    try {
      const r = await query(
        `SELECT Nombre AS nombre, Tipo AS tipo, Contenido AS contenido
           FROM dbo.SolicitudFoto WHERE Id = $1 AND SolicitudId = $2`, [fid, id]);
      if (!r.rowCount) return json(404, { error: 'La foto no existe' });
      return json(200, r.rows[0]);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la foto', detail: e.message });
    }
  }
});

/* POST .../validacion/fotos -> sube una foto de la entrega Y LA LEE.
   El OCR va acá y no en «Validar» para que el boton conteste al instante.
   Si Azure falla, la foto se guarda igual con el error anotado: vale como
   evidencia aunque no se haya podido leer. */
app.http('solicitud-validacion-foto-create', {
  methods: ['POST'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/validacion/fotos',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega valida el equipo alistado' });
    const id = parseInt(request.params.id, 10);
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!id || !cod) return json(400, { error: 'Solicitud o bandeja inválida' });

    const body = await request.json().catch(() => ({}));
    const tipo = String((body && body.tipo) || '').toLowerCase().trim();
    const b64 = String((body && body.base64) || '');
    const nombre = String((body && body.nombre) || '').trim().slice(0, 260) || null;

    if (!b64) return json(400, { error: 'No llegó la imagen' });
    if (!SELLADA_TIPOS.has(tipo))
      return json(400, { error: 'Solo se admiten imágenes (JPG, PNG, WEBP, GIF o BMP). Recibido: ' + (tipo || 'sin tipo') });
    const bytes = Math.floor(b64.length * 3 / 4);
    if (bytes > SELLADA_MAX_MB * 1024 * 1024)
      return json(400, { error: 'La imagen supera los ' + SELLADA_MAX_MB + ' MB' });

    try {
      const s = await query(`SELECT Estado AS estado FROM dbo.SolicitudEquipo WHERE Id = $1`, [id]);
      if (!s.rowCount) return json(404, { error: 'La solicitud no existe' });
      if (!SOL_ALISTABLES.includes(s.rows[0].estado))
        return json(409, { error: 'La solicitud está en estado ' + s.rows[0].estado + ': la validación ya está cerrada' });
      const b = await bandejaDeSolicitud(id, cod);
      if (!b) return json(404, { error: 'Esa bandeja no está en la solicitud' });

      const c = await query(
        `SELECT COUNT(*)::int AS n FROM dbo.SolicitudFoto
          WHERE SolicitudId = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))`, [id, cod]);
      if (c.rows[0].n >= FOTO_ENTREGA_MAX)
        return json(400, { error: 'Ya hay ' + FOTO_ENTREGA_MAX + ' fotos en esta bandeja, el máximo permitido' });

      /* La lectura NO puede tumbar la subida: si Azure no contesta, la foto se
         guarda con el error y la validacion dira que no pudo determinarlo. */
      let texto = null, errOcr = null;
      try {
        texto = textoDe(await analyzeRead(b64)) || null;
        if (!texto) errOcr = 'No se leyó ningún texto en la imagen';
      } catch (e) {
        errOcr = String(e.message || e).slice(0, 300);
        context.warn('No se pudo leer la foto de la entrega: ' + errOcr);
      }

      const r = await query(
        `INSERT INTO dbo.SolicitudFoto (SolicitudId, EquipoCodigo, Nombre, Tipo, Bytes, Contenido, TextoOcr, ErrorOcr, Usuario, UsuarioEmail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING Id AS id, Nombre AS nombre, Bytes AS bytes, Usuario AS usuario,
                   ErrorOcr AS error_ocr, (TextoOcr IS NOT NULL) AS leida, ${FECHA_VALID} AS fecha`,
        [id, b.equipo_codigo, nombre, tipo, bytes, b64, texto, errOcr,
         user.name || user.email, user.email]);
      return json(201, { ...r.rows[0], codigo: b.demarcado || b.equipo_codigo });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo guardar la foto', detail: e.message });
    }
  }
});

/* DELETE .../validacion/fotos/{fid}
   Solo la borra QUIEN LA SUBIO, y solo durante el alisto. Aca la foto SI es
   evidencia de un acto -de esta entrega, por esta persona-, al reves que las
   de referencia del catalogo, que son dato compartido. */
app.http('solicitud-validacion-foto-delete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/validacion/fotos/{fid}',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Su rol no puede eliminar las fotos de la entrega' });
    const id = parseInt(request.params.id, 10);
    const fid = parseInt(request.params.fid, 10);
    if (!id || !fid) return json(400, { error: 'Id inválido' });
    try {
      const s = await query(`SELECT Estado AS estado FROM dbo.SolicitudEquipo WHERE Id = $1`, [id]);
      if (!s.rowCount) return json(404, { error: 'La solicitud no existe' });
      if (!SOL_ALISTABLES.includes(s.rows[0].estado))
        return json(409, { error: 'El equipo ya se envió al hospital: sus fotos no se pueden eliminar' });
      const f = await query(
        `SELECT UsuarioEmail AS email, EquipoCodigo AS equipo_codigo
           FROM dbo.SolicitudFoto WHERE Id = $1 AND SolicitudId = $2`, [fid, id]);
      if (!f.rowCount) return json(404, { error: 'La foto no existe' });
      if (String(f.rows[0].email || '').toLowerCase() !== String(user.email || '').toLowerCase())
        return json(403, { error: 'Solo puede eliminar las fotos que subió usted' });
      await query(`DELETE FROM dbo.SolicitudFoto WHERE Id = $1 AND SolicitudId = $2`, [fid, id]);
      return json(200, { ok: true, codigo: f.rows[0].equipo_codigo });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo eliminar la foto', detail: e.message });
    }
  }
});

/* POST .../validacion -> EL BOTON «VALIDAR».
   Body opcional: { color_observado, nota }
   Compara el texto ya leido y graba el veredicto. Instantaneo: el OCR ya se
   hizo al subir cada foto. */
app.http('solicitud-validacion-run', {
  methods: ['POST'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/validacion',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega valida el equipo alistado' });
    const id = parseInt(request.params.id, 10);
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!id || !cod) return json(400, { error: 'Solicitud o bandeja inválida' });

    const body = await request.json().catch(() => ({}));
    const obsCrudo = solTexto(body && body.color_observado, 60);
    const nota = solTexto(body && body.nota, 400);
    let colorObs = null;
    if (obsCrudo) {
      colorObs = [...COLORES_DEMARCACION, COLOR_ILEGIBLE].find((c) => colorKey(c) === colorKey(obsCrudo));
      if (!colorObs) return json(400, { error: 'El color «' + obsCrudo + '» no está en el catálogo de demarcación' });
      if (colorKey(colorObs) === colorKey(COLOR_ILEGIBLE)) colorObs = COLOR_ILEGIBLE;
    }

    try {
      const s = await query(`SELECT Estado AS estado FROM dbo.SolicitudEquipo WHERE Id = $1`, [id]);
      if (!s.rowCount) return json(404, { error: 'La solicitud no existe' });
      if (!SOL_ALISTABLES.includes(s.rows[0].estado))
        return json(409, { error: 'La solicitud está en estado ' + s.rows[0].estado + ': la validación ya está cerrada' });
      const b = await bandejaDeSolicitud(id, cod);
      if (!b) return json(404, { error: 'Esa bandeja no está en la solicitud' });

      const f = await query(
        `SELECT TextoOcr AS texto FROM dbo.SolicitudFoto
          WHERE SolicitudId = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))
            AND TextoOcr IS NOT NULL`, [id, cod]);
      const nf = await query(
        `SELECT COUNT(*)::int AS n FROM dbo.SolicitudFoto
          WHERE SolicitudId = $1 AND UPPER(TRIM(EquipoCodigo)) = UPPER(TRIM($2))`, [id, cod]);
      if (!nf.rows[0].n) return json(400, { error: 'Adjunte al menos una foto de la bandeja antes de validar' });

      const [g, refs] = await Promise.all([query(SQL_GEMELAS, [cod]), referencias(context)]);
      const v = comparar.veredicto({
        textosEntrega: f.rows.map((x) => x.texto),
        pedida: String(b.equipo_codigo).toUpperCase().trim(),
        refs,
        gemelas: g.rows,
        color: colorObs ? { observado: colorObs, catalogo: b.color_catalogo } : { observado: null, catalogo: b.color_catalogo }
      });

      /* El codigo del candidato se guarda con su demarcado para que el motivo
         se pueda leer dentro de un ano sin ir a buscar la tabla. */
      const cand = v.candidato
        ? (await query(`SELECT Demarcado AS d FROM cat.Equipo WHERE UPPER(TRIM(Codigo)) = UPPER(TRIM($1))`, [v.candidato])).rows[0]
        : null;
      const motivo = cand && cand.d ? v.motivo.split(v.candidato).join(cand.d) : v.motivo;

      const r = await query(
        `INSERT INTO dbo.SolicitudVerificacion
           (SolicitudId, EquipoCodigo, Resultado, Origen, Motivo, Puntaje,
            CandidatoCodigo, CandidatoPuntaje, ColorObservado, ColorCatalogo, Nota, Usuario, UsuarioEmail,
            FotosFirma)
         VALUES ($1,$2,$3,'Automatico',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (SolicitudId, UPPER(TRIM(EquipoCodigo))) DO UPDATE
            SET Resultado = EXCLUDED.Resultado, Origen = EXCLUDED.Origen, Motivo = EXCLUDED.Motivo,
                Puntaje = EXCLUDED.Puntaje, CandidatoCodigo = EXCLUDED.CandidatoCodigo,
                CandidatoPuntaje = EXCLUDED.CandidatoPuntaje, ColorObservado = EXCLUDED.ColorObservado,
                ColorCatalogo = EXCLUDED.ColorCatalogo, Nota = EXCLUDED.Nota,
                Usuario = EXCLUDED.Usuario, UsuarioEmail = EXCLUDED.UsuarioEmail,
                FotosFirma = EXCLUDED.FotosFirma,
                FechaHora = (now() at time zone 'utc')
         RETURNING Resultado AS resultado, Origen AS origen, Motivo AS motivo,
                   Puntaje::float8 AS puntaje, CandidatoCodigo AS candidato,
                   CandidatoPuntaje::float8 AS candidato_puntaje,
                   ColorObservado AS color_observado, ColorCatalogo AS color_catalogo,
                   Nota AS nota, Usuario AS usuario, ${FECHA_VALID} AS fecha`,
        [id, b.equipo_codigo, v.resultado, motivo, v.puntaje, v.candidato, v.candidato_puntaje,
         colorObs, b.color_catalogo, nota, user.name || user.email, user.email,
         await firmaFotos(id, cod)]);
      return json(200, { ...r.rows[0], codigo: b.demarcado || b.equipo_codigo,
                         candidato_demarcado: cand ? cand.d : null, ranking: v.ranking });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo validar la bandeja', detail: e.message });
    }
  }
});

/* PUT .../validacion/confirmar -> LO QUE DICE LA PERSONA.
   Body: { resultado: 'Correcta' | 'Incorrecta', nota }
   Disponible sobre CUALQUIERA de los tres veredictos automaticos, en los dos
   sentidos: confirmar que si es, o desmentir un «Correcta» que no lo era.
   Queda con Origen='Persona' para que despues se sepa quien decidio. */
app.http('solicitud-validacion-confirmar', {
  methods: ['PUT'], authLevel: 'anonymous', route: 'solicitudes/{id}/bandejas/{codigo}/validacion/confirmar',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    if (!puedeBodega(await getRole(user))) return json(403, { error: 'Solo Bodega confirma la validación' });
    const id = parseInt(request.params.id, 10);
    const cod = normBandeja(decodeURIComponent(request.params.codigo || ''));
    if (!id || !cod) return json(400, { error: 'Solicitud o bandeja inválida' });

    const body = await request.json().catch(() => ({}));
    const res = String((body && body.resultado) || '').trim();
    if (res !== 'Correcta' && res !== 'Incorrecta')
      return json(400, { error: 'La confirmación solo puede ser «Correcta» o «Incorrecta»' });
    const nota = solTexto(body && body.nota, 400);

    try {
      const s = await query(`SELECT Estado AS estado FROM dbo.SolicitudEquipo WHERE Id = $1`, [id]);
      if (!s.rowCount) return json(404, { error: 'La solicitud no existe' });
      if (!SOL_ALISTABLES.includes(s.rows[0].estado))
        return json(409, { error: 'La solicitud está en estado ' + s.rows[0].estado + ': la validación ya está cerrada' });
      const b = await bandejaDeSolicitud(id, cod);
      if (!b) return json(404, { error: 'Esa bandeja no está en la solicitud' });

      /* No se confirma sobre un veredicto que ya no habla de estas fotos. El
         boton esta escondido en ese caso, pero la regla vive aca: la pantalla
         no es la que manda. */
      const vig = await veredictoDe(id, cod);
      if (!vig) return json(409, { error: 'Valide la bandeja antes de confirmar el resultado' });
      if (vig.desactualizado)
        return json(409, { error: 'Las fotos cambiaron desde la última validación. Vuelva a validar la bandeja.' });

      /* Se conserva lo que habia dicho el sistema: el motivo nuevo lo cuenta.
         Sin eso se perderia el dato de que la maquina opinaba distinto, que es
         justo lo que interesa revisar despues. */
      const prev = vig;
      const antes = prev ? (prev.origen === 'Automatico' ? prev.resultado : null) : null;
      const motivo = 'Lo confirmó ' + (user.name || user.email) + ' comparando las fotos.'
        + (antes ? ' El sistema había dicho «' + antes + '»'
                 + (prev.puntaje != null ? ' (puntaje ' + Number(prev.puntaje).toFixed(3) + ')' : '') + '.' : '');

      const r = await query(
        `INSERT INTO dbo.SolicitudVerificacion
           (SolicitudId, EquipoCodigo, Resultado, Origen, Motivo, Puntaje,
            CandidatoCodigo, CandidatoPuntaje, ColorObservado, ColorCatalogo, Nota, Usuario, UsuarioEmail,
            FotosFirma)
         VALUES ($1,$2,$3,'Persona',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (SolicitudId, UPPER(TRIM(EquipoCodigo))) DO UPDATE
            SET Resultado = EXCLUDED.Resultado, Origen = 'Persona', Motivo = EXCLUDED.Motivo,
                Nota = EXCLUDED.Nota, Usuario = EXCLUDED.Usuario, UsuarioEmail = EXCLUDED.UsuarioEmail,
                FotosFirma = EXCLUDED.FotosFirma,
                FechaHora = (now() at time zone 'utc')
         RETURNING Resultado AS resultado, Origen AS origen, Motivo AS motivo,
                   Puntaje::float8 AS puntaje, CandidatoCodigo AS candidato,
                   CandidatoPuntaje::float8 AS candidato_puntaje,
                   ColorObservado AS color_observado, ColorCatalogo AS color_catalogo,
                   Nota AS nota, Usuario AS usuario, ${FECHA_VALID} AS fecha`,
        [id, b.equipo_codigo, res, motivo,
         prev ? prev.puntaje : null, prev ? prev.candidato : null, prev ? prev.candidato_puntaje : null,
         prev ? prev.color_observado : null, b.color_catalogo, nota,
         user.name || user.email, user.email, await firmaFotos(id, cod)]);
      return json(200, { ...r.rows[0], codigo: b.demarcado || b.equipo_codigo });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo registrar la confirmación', detail: e.message });
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

/* ============================================================
   Tipo de cirugía (HDT / Transitoria)
   ------------------------------------------------------------
   NO va en ENC_FIELDS a propósito. Ese arreglo se recorre entero en el POST y
   en el PUT y escribe TODAS sus columnas: si el tipo estuviera ahí, un PUT de
   Hospital -que no ve el campo y por lo tanto no lo manda- lo pisaría con
   NULL en cada guardado. Se maneja aparte y con candado de rol.

   La regla es la misma en las dos puntas: el tipo lo tocan Bodega y
   Administrador. Hospital no lo ve en la pantalla, y aunque alguien armara el
   pedido a mano, acá no pasa: tipoCirugiaDe() devuelve null y la columna no
   se toca. En el POST, null significa dejar que el DEFAULT de la base lo
   ponga en 'HDT' -que es lo pedido para todo lo que crea Hospital-.
   ============================================================ */
const TIPOS_CIRUGIA = ['HDT', 'Transitoria'];

/* Devuelve el valor a grabar, o null si no corresponde tocar la columna. */
function tipoCirugiaDe(enc, rol) {
  if (!puedeBodega(rol)) return null;
  const v = String((enc && enc.tipo_cirugia) == null ? '' : enc.tipo_cirugia).trim();
  if (!v) return null;
  /* Se compara sin distinguir mayúsculas pero se graba el valor del catálogo:
     el CHECK de la base es sensible a la caja y «transitoria» lo violaría. */
  return TIPOS_CIRUGIA.find((t) => t.toLowerCase() === v.toLowerCase()) || null;
}

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
    /* Tipo de cirugía: solo si lo manda Bodega/Administrador. Si no, la columna
       NO se nombra en el INSERT y el DEFAULT de la base la pone en 'HDT', que
       es lo pedido para todo lo que crea Hospital. */
    const tipoCir = tipoCirugiaDe(enc, await getRole(user));
    if (tipoCir) { cols.push('TipoCirugia'); vals.push(tipoCir); ph.push('$' + (++i)); }

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
          `INSERT INTO dbo.HojaConsumoDetalle (HojaConsumoId, Linea, Codigo, NumeroEquipo, Descripcion, DescripcionNutricare, DescripcionAdicional, Und, ReposicionAnaquel)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id, d.linea || linea, d.codigo || null, equipoConPrefijo(d.numero_equipo), d.descripcion || null,
            descNutricare(mapa, d), descAdicional(d), toInt(d.und), toInt(d.reposicion_anaquel)]);
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
                h.Diagnostico AS diagnostico, h.TipoCirugia AS tipo_cirugia,
                h.Estado AS estado, h.CreadoPor AS usuario,
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
                Procedimiento AS procedimiento, TipoCirugia AS tipo_cirugia,
                ImagenBase64 AS imagen_base64, ImagenTipo AS imagen_tipo,
                Estado AS estado, CreadoPor AS usuario, CreadoPorEmail AS usuario_email,
                EsReemplazo AS es_reemplazo, HojaOrigenId AS hoja_origen_id, CirugiaId AS cirugia_id,
                ObservacionResolucion AS observacion_resolucion, ResueltoPor AS resuelto_por,
                to_char((FechaResolucion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica',
                        'YYYY-MM-DD HH24:MI') AS fecha_resolucion,
                (SELECT o.NumeroHoja FROM dbo.HojaConsumo o WHERE o.Id = HojaConsumo.HojaOrigenId) AS origen_numero_hoja,
                ${FECHA_LOCAL} AS fecha, ResultadoTR AS resultado_tr
         FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      if (!h.rows.length) return json(404, { error: 'No encontrada' });
      const d = await query(
        `SELECT Id AS id, Linea AS linea, Codigo AS codigo, NumeroEquipo AS numero_equipo,
                Descripcion AS descripcion, DescripcionNutricare AS descripcion_nutricare,
                DescripcionAdicional AS descripcion_adicional,
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
                Diagnostico AS diagnostico, Procedimiento AS procedimiento,
                TipoCirugia AS tipo_cirugia, Estado AS estado
           FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      const ad = await query(
        `SELECT Codigo AS codigo, NumeroEquipo AS numero_equipo, Und AS und,
                ReposicionAnaquel AS reposicion_anaquel, NumeroLote AS numero_lote,
                DescripcionAdicional AS descripcion_adicional
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
    /* Tipo de cirugía: si el rol no puede o no vino, NO se agrega el SET y la
       columna queda como estaba. Es lo que evita que un guardado de Hospital
       -que no manda el campo- borre lo que puso Bodega. */
    const tipoCirUp = tipoCirugiaDe(enc, rolEditor);
    if (tipoCirUp) { i++; sets.push(`TipoCirugia=$${i}`); vals.push(tipoCirUp); }
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
          `INSERT INTO dbo.HojaConsumoDetalle (HojaConsumoId, Linea, Codigo, NumeroEquipo, Descripcion, DescripcionNutricare, DescripcionAdicional, Und, ReposicionAnaquel, NumeroLote)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, d.linea || linea, d.codigo || null, equipoConPrefijo(d.numero_equipo), d.descripcion || null,
            descNutricare(mapa, d), descAdicional(d), toInt(d.und), toInt(d.reposicion_anaquel),
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
          numero_lote: (d.numero_lote === undefined || d.numero_lote === '') ? null : d.numero_lote,
          descripcion_adicional: descAdicional(d)
        }));
        const cambios = audit.diffHoja(antes, {
          /* El tipo de cirugía va con el valor EFECTIVO, no con el que trajo el
             body: si el rol no puede tocarlo -Hospital- la columna no se
             escribió, y comparar contra un campo que no vino inventaría un
             cambio «Tipo de Cirugía: HDT -> (vacío)» en cada guardado. */
          encabezado: { ...enc, tipo_cirugia: tipoCirUp || (antes.encabezado || {}).tipo_cirugia || null },
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
   Reemplazos / correcciones: consecutivo y diferencias
   ============================================================ */

/* GET /api/hojas/{id}/siguiente-reemplazo -> N° sugerido para un reemplazo.
   Del original HDT-3001 sale HDT-3001-R-1; el siguiente reemplazo de esa misma
   hoja es -R-2, y así. La R es de Reposición.
   El número se busca probando: si el -R-1 ya existe (por ejemplo porque hubo
   uno que se eliminó y se recreó), se pasa al siguiente libre. Contar los
   reemplazos existentes no alcanza — un borrado dejaría el contador pisando un
   número ya usado, y el índice único de NumeroHoja rechazaría el guardado. */
const REEMPLAZO_MAX_INTENTOS = 99;

app.http('hoja-siguiente-reemplazo', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hojas/{id}/siguiente-reemplazo',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });
    try {
      const h = await query(`SELECT NumeroHoja AS numero FROM dbo.HojaConsumo WHERE Id=$1`, [id]);
      if (!h.rows.length) return json(404, { error: 'La hoja no existe' });
      const base = String(h.rows[0].numero || '').trim();
      if (!base) return json(200, { numero: null });   // el original no tiene N°: el frontend usa el consecutivo normal
      for (let n = 1; n <= REEMPLAZO_MAX_INTENTOS; n++) {
        const cand = base + '-R-' + n;
        if (!(await numeroHojaEnUso(cand))) return json(200, { numero: cand, secuencia: n });
      }
      return json(200, { numero: null });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo calcular el consecutivo del reemplazo', detail: e.message });
    }
  }
});

/* GET /api/hojas/{id}/diferencias -> qué cambió el reemplazo respecto del original.
   Reutiliza el mismo motor de comparación de la auditoría, así que un cambio se
   describe igual acá que en el historial: una fila por campo, con el valor de la
   hoja original y el del reemplazo.
   El estado NO se compara: son dos hojas distintas y sus estados no tienen por
   qué coincidir. */
app.http('hoja-diferencias', {
  methods: ['GET'], authLevel: 'anonymous', route: 'hojas/{id}/diferencias',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    const id = parseInt(request.params.id, 10);
    if (!id) return json(400, { error: 'Id inválido' });

    const SEL_ENC = `SELECT Id AS id, NumeroHoja AS numero_hoja, NumeroDocumento AS numero_documento, Regimen AS regimen,
              Paciente AS paciente, Identificacion AS identificacion, Tipo AS tipo,
              to_char(FechaAccidente,'YYYY-MM-DD') AS fecha_accidente,
              to_char(FechaCirugia,'YYYY-MM-DD')   AS fecha_cirugia,
              to_char(FechaHoja,'YYYY-MM-DD')      AS fecha_hoja,
              Cirujano AS cirujano, Instrumentista AS instrumentista,
              Diagnostico AS diagnostico, Procedimiento AS procedimiento,
              TipoCirugia AS tipo_cirugia, HojaOrigenId AS hoja_origen_id
         FROM dbo.HojaConsumo WHERE Id=$1`;
    const SEL_DET = `SELECT Codigo AS codigo, NumeroEquipo AS numero_equipo, Und AS und,
              ReposicionAnaquel AS reposicion_anaquel, NumeroLote AS numero_lote,
              DescripcionAdicional AS descripcion_adicional
         FROM dbo.HojaConsumoDetalle WHERE HojaConsumoId=$1 ORDER BY Linea, Id`;

    try {
      const nueva = await query(SEL_ENC, [id]);
      if (!nueva.rows.length) return json(404, { error: 'La hoja no existe' });
      const origenId = nueva.rows[0].hoja_origen_id;
      if (!origenId) return json(200, { origen: null, cambios: [] });   // no viene de otra hoja: no hay con qué comparar

      const orig = await query(SEL_ENC, [origenId]);
      if (!orig.rows.length) return json(200, { origen: null, cambios: [] });  // la original ya no existe

      const [dOrig, dNueva] = await Promise.all([query(SEL_DET, [origenId]), query(SEL_DET, [id])]);
      /* El N° de hoja se deja fuera: en un reemplazo SIEMPRE difiere (lleva el
         sufijo -R-n), así que listarlo como "cambio" sería ruido en todas las
         comparaciones. */
      const cambios = [
        ...audit.diffEncabezado(orig.rows[0], nueva.rows[0])
             .filter(c => c.campo !== audit.ETIQUETAS_ENC.numero_hoja),
        ...audit.diffDetalle(dOrig.rows, dNueva.rows)
      ];
      return json(200, {
        origen: { id: origenId, numero_hoja: orig.rows[0].numero_hoja },
        cambios
      });
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudieron calcular las diferencias', detail: e.message });
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
   Bitacora de actividad — solo Administrador
   El registro lo escribe el envoltorio de app.http (ver bitacora.js).
   Aca solo se lee.
   ============================================================ */
app.http('bitacora-list', {
  methods: ['GET'], authLevel: 'anonymous', route: 'bitacora',
  handler: async (request, context) => {
    const user = getUser(request);
    if (!user) return json(401, { error: 'No autenticado' });
    /* Solo el Administrador. La auditoria de hojas la ve Bodega porque es
       una herramienta de su trabajo; la bitacora es supervision. */
    if ((await getRole(user)) !== 'Administrador')
      return json(403, { error: 'Solo el Administrador puede ver la bitácora' });
    let limite = parseInt(request.query.get('limite') || '1000', 10);
    if (!Number.isFinite(limite) || limite <= 0) limite = 1000;
    if (limite > 5000) limite = 5000;
    try {
      const r = await query(
        `SELECT Id AS id,
                to_char((FechaHora AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica',
                        'DD/MM/YYYY HH24:MI') AS fecha,
                Usuario AS usuario, UsuarioEmail AS usuario_email, Rol AS rol,
                Pantalla AS pantalla, Accion AS accion, Registro AS registro,
                Detalle AS detalle, Estado AS http
           FROM dbo.Bitacora
          ORDER BY Id DESC LIMIT $1`, [limite]);
      return json(200, r.rows);
    } catch (e) {
      context.error(e);
      return json(500, { error: 'No se pudo obtener la bitácora', detail: e.message });
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

    /* La observación es obligatoria. Se valida acá y no solo en la pantalla:
       resolver es el cierre del reemplazo y sin el motivo escrito el registro
       no dice nada de por qué se cerró. */
    const body = await request.json().catch(() => ({}));
    const obs = String((body && body.observacion) || '').trim();
    if (!obs) return json(400, { error: 'Escriba la observación para poder marcar el reemplazo como resuelto' });
    if (obs.length > 2000) return json(400, { error: 'La observación no puede superar los 2000 caracteres' });

    try {
      const r = await query(
        `UPDATE dbo.HojaConsumo
            SET Estado='Resuelto', ObservacionResolucion=$2, ResueltoPor=$3,
                FechaResolucion=(now() at time zone 'utc')
          WHERE Id=$1 AND EsReemplazo=TRUE RETURNING Id`,
        [id, obs, user.name || user.email]);
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
/* 'transitoria' es el panel «Cirugía Transitoria». Es una AREA más de la
   misma tabla: lo que pide -Origen y Destino- es exactamente lo que
   dbo.Configuracion ya guarda por área, así que no hay tabla nueva.
   Ojo: a diferencia de las otras tres, la pantalla NO la exige. */
const CONFIG_AREAS = ['anaquel', 'nutricare', 'facturacion', 'transitoria'];

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

/* Arma el objeto que espera el flujo: { Consecutivo, Cirugia, Detalle, Configuracion }.

   `Cirugia` es el Tipo de Cirugía que eligió Bodega en el encabezado -'HDT' o
   'Transitoria'-. Va como campo propio y no dentro de Configuracion porque es
   un dato DE ESTA HOJA, no de la configuración del sistema: dice qué cirugía
   se hizo, mientras Configuracion dice a dónde mover el inventario.

   `Configuracion` sale de dbo.Configuracion SIN filtrar áreas, así que desde la
   migración 35 -que sembró la fila- ya viaja el área «transitoria» con el
   Origen y el Destino del panel «Cirugía Transitoria», sin que haya que
   nombrarla acá. El área va en MINÚSCULA, igual que las otras tres y tal como
   está en la base. */
async function construirPayloadDynamics(hojaId) {
  const h = await query(
    `SELECT Id AS id, Consecutivo AS consecutivo, TipoCirugia AS tipo_cirugia
       FROM dbo.HojaConsumo WHERE Id=$1`, [hojaId]);
  if (!h.rows.length) throw new Error('Hoja de consumo no encontrada');
  const consecutivo = h.rows[0].consecutivo;
  /* La columna es NOT NULL con DEFAULT 'HDT', así que en la práctica siempre
     trae valor. El respaldo está por si algún día se le quita el default: es
     mejor mandar 'HDT' que una cadena vacía, que el flujo no sabría interpretar. */
  const Cirugia = h.rows[0].tipo_cirugia || 'HDT';

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

  return { Consecutivo: consecutivo, Cirugia, Detalle, Configuracion };
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
