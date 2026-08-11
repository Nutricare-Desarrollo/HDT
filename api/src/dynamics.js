/* Integración con el flujo de Power Automate "Crear Trabajos en Dynamics".

   La URL del flujo (con su firma SAS) va en la App Setting DYNAMICS_API_URL,
   NUNCA en el código ni en el repositorio.

   Procesos largos: si el flujo tarda más de ~2 minutos, Power Automate deja de
   responder 200 y pasa al patrón asíncrono: responde 202 con una cabecera
   "Location" (URL para consultar el avance). Por eso:
     - iniciarDynamics(payload)  -> POST inicial. Devuelve {estado:'ok',data} si
       terminó de una, o {estado:'en_proceso', location} si sigue trabajando.
     - consultarDynamics(location) -> GET a esa URL. Igual: 'ok' con data, o
       'en_proceso' si todavía no termina.
   Así el backend nunca bloquea más de una request corta (Azure corta a ~230s) y
   el navegador va consultando el estado hasta que termina. */

const DEFAULT_TIMEOUT_MS = parseInt(process.env.DYNAMICS_TIMEOUT_MS || '220000', 10);

// fetch con AbortController para no quedar colgados cerca del límite de Azure (~230s).
async function fetchConTimeout(url, opt, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opt, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Interpreta la respuesta del flujo: 202 => en proceso (+Location); 2xx => data.
async function interpretar(res) {
  if (res.status === 202) {
    const location = res.headers.get('location') || res.headers.get('Location') || null;
    const retry = parseInt(res.headers.get('retry-after') || '0', 10) || 0;
    return { estado: 'en_proceso', location, retryAfter: retry };
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`El flujo de Dynamics respondió ${res.status}. ${String(text).slice(0, 300)}`);
  }
  if (!text || !text.trim()) return { estado: 'ok', data: [] };
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('La respuesta del flujo no es JSON válido. Inicio: ' + String(text).slice(0, 200)); }
  // Power Automate a veces devuelve el JSON doble-codificado (un string dentro del body).
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* se deja como string */ } }
  return { estado: 'ok', data };
}

// POST inicial al flujo con el payload {Consecutivo, Detalle, Configuracion}.
// envName permite usar distintas App Settings según el flujo (hoja vs. pedido pendiente).
async function iniciarDynamics(payload, envName = 'DYNAMICS_API_URL') {
  const url = process.env[envName];
  if (!url) throw new Error(`Falta configurar ${envName} en el servidor (Application settings del Static Web App).`);
  const res = await fetchConTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload)
  });
  return interpretar(res);
}

// GET a la URL de seguimiento devuelta por un 202.
async function consultarDynamics(location) {
  if (!location) throw new Error('No hay URL de seguimiento del proceso.');
  const res = await fetchConTimeout(location, { method: 'GET', headers: { 'Accept': 'application/json' } });
  return interpretar(res);
}

module.exports = { iniciarDynamics, consultarDynamics };
