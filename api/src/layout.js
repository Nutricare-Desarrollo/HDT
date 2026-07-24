/* Extracción con Azure AI Document Intelligence (Layout) y parseo a {encabezado, detalle}.
   Aislado de la base de datos para poder probarlo sin dependencias. */

// Normaliza texto para comparar encabezados (sin acentos, minúsculas).
function norm(s) {
  return (s == null ? '' : String(s)).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function toInt(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// Llama a Document Intelligence (prebuilt-layout v4.0) y devuelve el analyzeResult.
async function analyzeLayout(base64) {
  const endpoint = (process.env.DOCINTEL_ENDPOINT || '').replace(/\/+$/, '');
  const key = process.env.DOCINTEL_KEY;
  const model = process.env.DOCINTEL_MODEL || 'prebuilt-layout';
  if (!endpoint || !key) throw new Error('Falta configurar DOCINTEL_ENDPOINT/DOCINTEL_KEY en el servidor');

  const url = `${endpoint}/documentintelligence/documentModels/${model}:analyze?api-version=2024-11-30`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Source: base64 })
  });
  if (res.status !== 202) {
    const t = await res.text();
    throw new Error(`Document Intelligence respondió ${res.status}: ${t.slice(0, 300)}`);
  }
  const opLoc = res.headers.get('operation-location');
  if (!opLoc) throw new Error('No se recibió operation-location de Document Intelligence');

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const p = await fetch(opLoc, { headers: { 'Ocp-Apim-Subscription-Key': key } });
    const body = await p.json();
    if (body.status === 'succeeded') return body.analyzeResult || {};
    if (body.status === 'failed') throw new Error('El análisis falló: ' + JSON.stringify(body.error || {}).slice(0, 300));
  }
  throw new Error('Tiempo de espera agotado analizando el documento');
}

// Convierte el analyzeResult de Layout en {encabezado, detalle}.
// El detalle (la tabla) se mapea por columnas; el encabezado es best-effort
// (el usuario lo revisa/corrige en el paso 2 del wizard).
function parseLayout(analyzeResult) {
  const tables = (analyzeResult && analyzeResult.tables) || [];
  const encabezado = {
    numero_hoja: '', numero_documento: '', regimen: '', paciente: '', identificacion: '',
    tipo: '', fecha_accidente: '', fecha_cirugia: '', fecha_hoja: '',
    cirujano: '', instrumentista: '', diagnostico: '', procedimiento: ''
  };
  const detalle = [];

  const DET = {
    codigo: ['codigo'],
    numero_equipo: ['numero de equipo', 'n de equipo', 'no de equipo', 'equipo'],
    descripcion: ['descripcion'],
    und: ['und', 'unidad', 'unidades'],
    reposicion_anaquel: ['reposicion anaquel', 'reposicion', 'anaquel']
  };

  for (const t of tables) {
    const cells = t.cells || [];
    const header = {};
    cells.filter(c => c.rowIndex === 0).forEach(c => { header[c.columnIndex] = norm(c.content); });
    const colField = {};
    Object.keys(header).forEach(ci => {
      const h = header[ci];
      for (const f in DET) { if (DET[f].some(k => h.includes(k))) { colField[ci] = f; break; } }
    });
    const mapped = new Set(Object.values(colField));
    const esDetalle = mapped.has('codigo') && mapped.has('descripcion');

    if (esDetalle) {
      const rows = {};
      cells.filter(c => c.rowIndex > 0).forEach(c => {
        const f = colField[c.columnIndex]; if (!f) return;
        (rows[c.rowIndex] = rows[c.rowIndex] || {})[f] = (c.content || '').trim();
      });
      Object.keys(rows).map(Number).sort((a, b) => a - b).forEach(ri => {
        const r = rows[ri];
        const codigo = (r.codigo || '').trim();
        const desc = (r.descripcion || '').trim();
        if (!codigo && !desc) return;
        detalle.push({
          linea: detalle.length + 1,
          codigo: codigo.replace(/\s+/g, ''),
          numero_equipo: (r.numero_equipo || '').replace(/\s+/g, ''),
          descripcion: desc,
          und: toInt(r.und),
          reposicion_anaquel: toInt(r.reposicion_anaquel)
        });
      });
      continue;
    }

    // Tabla clave-valor: mapear etiquetas del encabezado.
    const rmap = {};
    cells.forEach(c => { (rmap[c.rowIndex] = rmap[c.rowIndex] || {})[c.columnIndex] = (c.content || '').trim(); });
    Object.values(rmap).forEach(row => {
      const k = norm(row[0]);
      const v = (row[1] || '').trim();
      if (!k || !v) return;
      if (k.includes('cirujano') && !encabezado.cirujano) encabezado.cirujano = v;
      else if (k.includes('instrumentista') && !encabezado.instrumentista) encabezado.instrumentista = v;
      else if (k.includes('diagnostico') && !encabezado.diagnostico) encabezado.diagnostico = v;
      else if (k.includes('regimen') && !encabezado.regimen) encabezado.regimen = v;
    });
  }
  return { encabezado, detalle };
}

module.exports = { norm, toInt, analyzeLayout, parseLayout };
