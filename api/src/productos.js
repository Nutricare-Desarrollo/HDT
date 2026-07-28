/* Catálogo de productos Nutricare.
   Se obtiene desde un API externo (flujo de Power Automate) cuya URL va en la
   variable de entorno PRODUCTOS_API_URL (nunca en el código). El resultado se
   cachea en memoria unos minutos para no golpear el API en cada request.

   El API devuelve un arreglo de objetos { Codigo, Descripcion, Bandeja }.
   Aquí se normaliza a { codigo, descripcion, bandeja } (claves en minúscula y
   código sin espacios). */

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

// El API podría devolver el arreglo directo o envuelto ({value:[...]}, etc.).
function extraerArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      if (Array.isArray(raw[k])) return raw[k];
    }
  }
  return [];
}

function normalizar(raw) {
  return extraerArray(raw).map((o) => ({
    codigo: normCod(pick(o, ['codigo', 'código', 'code'])),
    descripcion: String(pick(o, ['descripcion', 'descripción', 'description', 'desc']) ?? '').trim(),
    bandeja: String(pick(o, ['bandeja', 'tray']) ?? '').trim()
  })).filter((p) => p.codigo);
}

async function fetchCatalogo() {
  const url = process.env.PRODUCTOS_API_URL;
  if (!url) throw new Error('Falta configurar PRODUCTOS_API_URL en el servidor');

  const method = (process.env.PRODUCTOS_API_METHOD || 'POST').toUpperCase();
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.PRODUCTOS_API_KEY) headers['x-api-key'] = process.env.PRODUCTOS_API_KEY;

  const opt = { method, headers };
  if (method !== 'GET') opt.body = process.env.PRODUCTOS_API_BODY || '{}';

  const res = await fetch(url, opt);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`El API de productos respondió ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Devuelve el catálogo normalizado (usa caché salvo force=true).
async function getCatalogo(force) {
  const now = Date.now();
  if (!force && cache.data && (now - cache.at) < TTL_MS) return cache.data;
  const data = normalizar(await fetchCatalogo());
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
