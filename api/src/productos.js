/* Catálogo de productos Nutricare.
   Se obtiene desde un API externo cuya URL va en la variable de entorno
   PRODUCTOS_API_URL (nunca en el código: lleva la firma sig=, que es una
   credencial). El resultado se cachea en memoria unos minutos para no golpear
   el API en cada request.

   EL FLUJO SE LLAMA «HTTPGetObtieneProducto», en Power Automate. Queda escrito
   acá porque la App Setting solo guarda la URL, y desde la URL no hay forma de
   saber a qué flujo pertenece: sin este nombre, ubicarlo es ir abriendo flujos
   hasta dar con el que responde.

   NO HAY TABLA DE PRODUCTOS en la base. De acá salen la Descripción Nutricare y
   la bandeja de cada código; los campos Sima viven en cat.ProductoSima
   (migración 36) y se unen al catálogo al mostrarlo. Un producto nuevo, o una
   descripción corregida, se cambian en la fuente del flujo y no en RIC.

   El API debería devolver un arreglo de objetos { Codigo, Descripcion, Bandeja }.
   Aquí se normaliza a { codigo, descripcion, bandeja } (claves en minúscula y
   código sin espacios) y se toleran las variantes de respuesta más comunes de
   Power Automate (JSON doble-codificado, cuerpo como texto, arreglo anidado).

   ────────────────────────────────────────────────────────────────────────────
   POR QUÉ HAY UN TIMEOUT PROPIO Y UNA CACHÉ QUE SOBREVIVE AL FALLO
   ────────────────────────────────────────────────────────────────────────────
   El 16 de setiembre el catálogo dejó de cargar y el navegador mostraba un
   «Error 500» sin explicación. El flujo NO estaba fallando: el historial de
   Power Automate mostraba todas las corridas en Succeeded, pero tardando entre
   50 y 71 segundos, contra 23-37 que tardaba antes de que se le agregara un
   cruce adentro.

   Azure Static Web Apps corta TODA petición a la API a los 45 segundos. Es un
   límite duro de la plataforma —aplica a Free y a Standard, y a managed
   functions igual que a las propias— y NO se configura. O sea que el gateway
   mataba la petición mientras el flujo seguía trabajando, y el 500 lo generaba
   Azure, no este código: por eso el mensaje no decía nada útil.

   De ahí las dos defensas de abajo, que se necesitan LAS DOS:

   1. TIMEOUT_MS, por debajo del límite del gateway. Sin esto la Function nunca
      alcanza a reaccionar —la matan antes— y la caché vieja no sirve de nada.
      El error, además, sale con un mensaje que se entiende.

   2. La caché buena NO se borra al vencer. Si el origen falla, se sigue
      sirviendo lo último que se obtuvo. Un catálogo de hace media hora es
      muchísimo mejor que ninguno: sin él se pierden las descripciones, el
      autocompletado y los códigos Sima en todas las pantallas.

   ⚠️ Esto es un cinturón de seguridad, no un arreglo. Si el flujo sano tarda 37
   segundos contra un límite de 45, el margen sigue siendo delgado y un día
   lento lo vuelve a tumbar. Lo que baja el tiempo de verdad es sacarle trabajo
   al flujo: el cruce bandeja-producto cuesta 45 ms acá contra ~62 s allá. */

const TTL_MS = parseInt(process.env.PRODUCTOS_CACHE_MS || String(10 * 60 * 1000), 10);

/* Timeout propio, POR DEBAJO de los 45 s del gateway de Static Web Apps, para
   que el que corte sea este código y no Azure. El margen cubre el arranque en
   frío de la Function y el armado de la respuesta. Subirlo de 40000 es pedir
   que vuelva el 500 mudo. */
const TIMEOUT_MS = parseInt(process.env.PRODUCTOS_TIMEOUT_MS || '38000', 10);

/* Tras un fallo del origen no se reintenta en cada request: con el origen
   lento, cada pantalla se quedaría esperando el timeout completo una y otra
   vez. Durante esta ventana se sirve la caché vieja de una vez, y la aplicación
   se siente rápida aunque el flujo esté caído. */
const REINTENTO_MS = parseInt(process.env.PRODUCTOS_RETRY_MS || '60000', 10);

let cache = { at: 0, data: null }; // último catálogo bueno; NO se borra al vencer
let fallo = { at: 0, msg: '' };    // último fallo del origen

// Normaliza un código para comparar/indexar (sin espacios).
const normCod = (c) => String(c == null ? '' : c).replace(/\s+/g, '').trim();

// Toma un valor de un objeto por cualquiera de las claves dadas (case-insensitive).
function pick(obj, keys) {
  for (const k of Object.keys(obj || {})) {
    if (keys.includes(k.toLowerCase())) return obj[k];
  }
  return undefined;
}

// Busca el primer arreglo dentro de `raw` (directo, en una propiedad, o anidado).
function extraerArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    // 1) arreglo en alguna propiedad de primer nivel (value, items, results, etc.)
    for (const k of Object.keys(raw)) {
      if (Array.isArray(raw[k])) return raw[k];
    }
    // 2) búsqueda anidada un nivel más (Power Automate a veces envuelve el body)
    for (const k of Object.keys(raw)) {
      const v = raw[k];
      if (v && typeof v === 'object') {
        const nested = extraerArray(v);
        if (nested.length) return nested;
      }
    }
  }
  return [];
}

// Convierte texto en objeto/arreglo tolerando JSON doble-codificado
// (un string JSON dentro del body, típico de Power Automate).
function parseFlexible(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('La respuesta no es JSON válido. Comienzo del cuerpo: ' + text.slice(0, 200)); }
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* se queda como string; extraerArray devolverá [] */ }
  }
  return data;
}

function normalizarArray(arr) {
  return arr.map((o) => ({
    codigo: normCod(pick(o, ['codigo', 'código', 'code'])),
    descripcion: String(pick(o, ['descripcion', 'descripción', 'description', 'desc']) ?? '').trim(),
    bandeja: String(pick(o, ['bandeja', 'tray']) ?? '').trim()
  })).filter((p) => p.codigo);
}

// Minutos transcurridos desde `t`, para los mensajes.
const minutosDesde = (t) => Math.round((Date.now() - t) / 60000);

async function fetchCatalogo() {
  const url = process.env.PRODUCTOS_API_URL;
  if (!url) throw new Error('Falta configurar PRODUCTOS_API_URL en el servidor (Application settings del Static Web App).');

  // El flujo de Power Automate se invoca por GET (la firma SAS es para GET).
  // Se puede sobreescribir con PRODUCTOS_API_METHOD si algún día cambia.
  const method = (process.env.PRODUCTOS_API_METHOD || 'GET').toUpperCase();
  const headers = { 'Accept': 'application/json' };
  if (process.env.PRODUCTOS_API_KEY) headers['x-api-key'] = process.env.PRODUCTOS_API_KEY;

  const opt = { method, headers };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    opt.body = process.env.PRODUCTOS_API_BODY || '{}';
  }

  /* El timeout cubre la conexión Y la lectura del cuerpo: un origen que contesta
     los encabezados rápido y después gotea el cuerpo agota el presupuesto igual. */
  const ctl = new AbortController();
  let vencio = false;
  const reloj = setTimeout(() => { vencio = true; ctl.abort(); }, TIMEOUT_MS);

  let res, text;
  try {
    res = await fetch(url, { ...opt, signal: ctl.signal });
    text = await res.text();
  } catch (e) {
    if (vencio) {
      throw new Error(
        `El API de productos no respondió en ${Math.round(TIMEOUT_MS / 1000)} s. ` +
        'El flujo «HTTPGetObtieneProducto» probablemente está tardando de más: revisá el ' +
        'historial de ejecuciones en Power Automate y la duración de cada acción. ' +
        'Static Web Apps corta a los 45 s y ese límite no se puede subir.');
    }
    throw e;
  } finally {
    clearTimeout(reloj);
  }

  if (!res.ok) {
    throw new Error(`El API de productos respondió ${res.status}. Cuerpo: ${text.slice(0, 300)}`);
  }
  if (res.status === 202) {
    throw new Error('El flujo respondió 202 (asincrónico). Agregá una acción "Response" en el flujo y usá el trigger sincrónico.');
  }
  if (!text || !text.trim()) {
    throw new Error('El API de productos respondió con cuerpo vacío.');
  }
  return parseFlexible(text);
}

// Trae y normaliza el catálogo desde el origen. Lanza si no se obtiene nada usable.
async function traerYNormalizar() {
  const raw = await fetchCatalogo();
  const arr = extraerArray(raw);
  const data = normalizarArray(arr);

  // Diagnóstico claro cuando no se obtiene nada.
  if (!data.length) {
    if (!arr.length) {
      throw new Error('El API no devolvió un arreglo de productos. Revisá que el flujo responda una lista (o {value:[...]}).');
    }
    const ejemplo = JSON.stringify(arr[0] || {}).slice(0, 200);
    throw new Error(`Se recibieron ${arr.length} filas pero ninguna con "Codigo". Revisá los nombres de campo (se esperan Codigo/Descripcion). Ejemplo de fila: ${ejemplo}`);
  }
  return data;
}

/* Devuelve el catálogo normalizado.

   force=true es el botón «Cargar productos» (refresh=1). Ese botón es la
   herramienta de diagnóstico: TIENE que decir la verdad. Si el origen falla,
   revienta con el error real en vez de devolver la caché vieja y anunciar
   «Catálogo cargado: 9.555 productos», que sería mentira y mandaría a buscar el
   problema al lugar equivocado.

   Sin force -la carga automática de las pantallas- manda no dejar a nadie sin
   catálogo: si el origen falla se sirve lo último bueno que se tenga. */
async function getCatalogo(force) {
  const now = Date.now();
  if (!force && cache.data && (now - cache.at) < TTL_MS) return cache.data;

  // Origen caído hace poco y hay catálogo viejo: se sirve sin reintentar.
  if (!force && cache.data && fallo.at && (now - fallo.at) < REINTENTO_MS) return cache.data;

  let data;
  try {
    data = await traerYNormalizar();
  } catch (e) {
    fallo = { at: Date.now(), msg: e.message };
    if (force || !cache.data) throw e;
    console.warn(
      `[productos] El origen falló (${e.message}). Se sigue sirviendo el catálogo ` +
      `de hace ${minutosDesde(cache.at)} min: ${cache.data.length} productos.`);
    return cache.data;
  }

  cache = { at: Date.now(), data };
  fallo = { at: 0, msg: '' };
  return data;
}

// Devuelve un Map(codigo -> descripcion) para validar/completar rápido.
async function getMapa() {
  const arr = await getCatalogo();
  const m = new Map();
  arr.forEach((p) => m.set(p.codigo, p.descripcion));
  return m;
}

module.exports = { getCatalogo, getMapa, normCod };
