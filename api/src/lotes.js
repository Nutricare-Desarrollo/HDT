/* Catálogo de lotes por producto (Nutricare).
   Se obtiene desde un flujo de Power Automate (GET) cuya URL va en la variable
   de entorno LOTES_API_URL (nunca en el código). Se cachea en memoria unos
   minutos. Mismo patrón y tolerancias que productos.js.

   El API devuelve un arreglo de objetos { Codigo, Lote }.
   Aquí se normaliza a { codigo, lote } (código sin espacios). */

const TTL_MS = parseInt(process.env.LOTES_CACHE_MS || String(10 * 60 * 1000), 10);
let cache = { at: 0, data: null };

const normCod = (c) => String(c == null ? '' : c).replace(/\s+/g, '').trim();

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
    for (const k of Object.keys(raw)) {
      if (Array.isArray(raw[k])) return raw[k];
    }
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

// Tolera JSON doble-codificado (string JSON dentro del body).
function parseFlexible(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { throw new Error('La respuesta no es JSON válido. Comienzo del cuerpo: ' + text.slice(0, 200)); }
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* se queda como string */ }
  }
  return data;
}

function normalizarArray(arr) {
  return arr.map((o) => ({
    codigo: normCod(pick(o, ['codigo', 'código', 'code'])),
    lote: String(pick(o, ['lote', 'lot', 'batch', 'numerolote', 'numero_lote']) ?? '').trim()
  })).filter((p) => p.codigo && p.lote);
}

async function fetchLotes() {
  const url = process.env.LOTES_API_URL;
  if (!url) throw new Error('Falta configurar LOTES_API_URL en el servidor (Application settings del Static Web App).');

  const method = (process.env.LOTES_API_METHOD || 'GET').toUpperCase();
  const headers = { 'Accept': 'application/json' };
  if (process.env.LOTES_API_KEY) headers['x-api-key'] = process.env.LOTES_API_KEY;

  const opt = { method, headers };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    opt.body = process.env.LOTES_API_BODY || '{}';
  }

  const res = await fetch(url, opt);
  const text = await res.text();

  if (!res.ok) throw new Error(`El API de lotes respondió ${res.status}. Cuerpo: ${text.slice(0, 300)}`);
  if (res.status === 202) throw new Error('El flujo respondió 202 (asincrónico). Agregá una acción "Response" y usá el trigger sincrónico.');
  if (!text || !text.trim()) throw new Error('El API de lotes respondió con cuerpo vacío.');
  return parseFlexible(text);
}

// Devuelve el catálogo de lotes normalizado (usa caché salvo force=true).
async function getLotes(force) {
  const now = Date.now();
  if (!force && cache.data && (now - cache.at) < TTL_MS) return cache.data;

  const raw = await fetchLotes();
  const arr = extraerArray(raw);
  const data = normalizarArray(arr);

  if (!data.length) {
    if (!arr.length) throw new Error('El API no devolvió un arreglo de lotes. Revisá que el flujo responda una lista.');
    const ejemplo = JSON.stringify(arr[0] || {}).slice(0, 200);
    throw new Error(`Se recibieron ${arr.length} filas pero ninguna con "Codigo"/"Lote". Ejemplo de fila: ${ejemplo}`);
  }

  cache = { at: now, data };
  return data;
}

module.exports = { getLotes, normCod };
