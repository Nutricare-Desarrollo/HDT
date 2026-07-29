/* Catálogo de productos Nutricare.
   Se obtiene desde un API externo (flujo de Power Automate) cuya URL va en la
   variable de entorno PRODUCTOS_API_URL (nunca en el código). El resultado se
   cachea en memoria unos minutos para no golpear el API en cada request.

   El API debería devolver un arreglo de objetos { Codigo, Descripcion, Bandeja }.
   Aquí se normaliza a { codigo, descripcion, bandeja } (claves en minúscula y
   código sin espacios) y se toleran las variantes de respuesta más comunes de
   Power Automate (JSON doble-codificado, cuerpo como texto, arreglo anidado). */

const TTL_MS = parseInt(process.env.PRODUCTOS_CACHE_MS || String(10 * 60 * 1000), 10);
let cache = { at: 0, data: null };

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

async function fetchCatalogo() {
  const url = process.env.PRODUCTOS_API_URL;
  if (!url) throw new Error('Falta configurar PRODUCTOS_API_URL en el servidor (Application settings del Static Web App).');

  const method = (process.env.PRODUCTOS_API_METHOD || 'POST').toUpperCase();
  const headers = { 'Accept': 'application/json' };
  if (process.env.PRODUCTOS_API_KEY) headers['x-api-key'] = process.env.PRODUCTOS_API_KEY;

  const opt = { method, headers };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    opt.body = process.env.PRODUCTOS_API_BODY || '{}';
  }

  const res = await fetch(url, opt);
  const text = await res.text();

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

// Devuelve el catálogo normalizado (usa caché salvo force=true).
async function getCatalogo(force) {
  const now = Date.now();
  if (!force && cache.data && (now - cache.at) < TTL_MS) return cache.data;

  const raw = await fetchCatalogo();
  const arr = extraerArray(raw);
  const data = normalizarArray(arr);

  // Diagnóstico claro cuando no se obtiene nada (no se cachea para permitir reintentos).
  if (!data.length) {
    if (!arr.length) {
      throw new Error('El API no devolvió un arreglo de productos. Revisá que el flujo responda una lista (o {value:[...]}).');
    }
    const ejemplo = JSON.stringify(arr[0] || {}).slice(0, 200);
    throw new Error(`Se recibieron ${arr.length} filas pero ninguna con "Codigo". Revisá los nombres de campo (se esperan Codigo/Descripcion). Ejemplo de fila: ${ejemplo}`);
  }

  cache = { at: now, data };
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
