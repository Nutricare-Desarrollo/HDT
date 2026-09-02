/* ============================================================================
   HDT · Auditoría de cambios de la hoja de consumo
   ----------------------------------------------------------------------------
   Compara el estado ANTERIOR de una hoja contra el que llega en el PUT y
   devuelve una fila por campo cambiado. No toca la base: el que llama decide
   cuándo grabar (dentro de su transacción) con grabarCambios().
   ============================================================================ */

// Etiquetas del encabezado. Son las mismas que ve el usuario en el formulario:
// la auditoría se lee, no se interpreta, así que no van nombres de columna.
const ETIQUETAS_ENC = {
  numero_hoja: 'N° de hoja',
  numero_documento: 'N° de documento',
  regimen: 'Régimen',
  paciente: 'Paciente',
  identificacion: 'Identificación',
  tipo: 'Tipo',
  fecha_accidente: 'Fecha de accidente',
  fecha_cirugia: 'Fecha de cirugía',
  fecha_hoja: 'Fecha de la hoja',
  cirujano: 'Cirujano',
  instrumentista: 'Instrumentista',
  diagnostico: 'Diagnóstico',
  procedimiento: 'Procedimiento'
};

/* Campos del detalle que se auditan. Quedan fuera a propósito:
   - descripcion            -> es lo que leyó el OCR, no lo escribe el usuario
   - descripcion_nutricare  -> se deriva del código; auditar el código ya lo cubre
   descripcion_adicional SI se audita: es texto libre que escribe el usuario, no
   se deriva de nada, y es justo el tipo de campo por el que despues se pregunta
   quien lo escribio y cuando. */
const CAMPOS_DET = [
  ['codigo', 'Código'],
  ['numero_equipo', 'N° equipo'],
  ['und', 'Und'],
  ['reposicion_anaquel', 'Reposición anaquel'],
  ['numero_lote', 'N° Lote'],
  ['descripcion_adicional', 'Descripción adicional']
];

// Todo se compara como texto recortado: '' y null son lo mismo (vacío), y
// 2 (número) y "2" (texto del formulario) también.
const txt = (v) => (v === undefined || v === null) ? '' : String(v).trim();

// Clave para emparejar líneas: el par código + n° de equipo, sin distinguir
// mayúsculas ni espacios. Emparejar por posición daría falsos cambios en toda
// la tabla al insertar o borrar una línea en el medio.
const claveLinea = (d) =>
  txt(d && d.codigo).toUpperCase().replace(/\s+/g, '') + '|' +
  txt(d && d.numero_equipo).toUpperCase().replace(/\s+/g, '').replace(/^NUT-?/, '');

// Resumen de una línea, para las filas de "Línea agregada" / "Línea eliminada".
function resumenLinea(d) {
  const p = [];
  if (txt(d.codigo)) p.push(txt(d.codigo));
  if (txt(d.numero_equipo)) p.push(txt(d.numero_equipo));
  if (txt(d.und)) p.push(txt(d.und) + ' und');
  if (txt(d.reposicion_anaquel)) p.push('rep. ' + txt(d.reposicion_anaquel));
  if (txt(d.numero_lote)) p.push('lote ' + txt(d.numero_lote));
  if (txt(d.descripcion_adicional)) p.push('«' + txt(d.descripcion_adicional) + '»');
  return p.length ? p.join(' · ') : '(línea vacía)';
}

const fila = (seccion, linea, campo, anterior, nuevo) => ({
  seccion, linea,
  campo,
  anterior: txt(anterior) === '' ? null : txt(anterior),
  nuevo: txt(nuevo) === '' ? null : txt(nuevo)
});

/* ---------------------------------------------------------------------------
   Encabezado: una fila por campo que cambió.
   --------------------------------------------------------------------------- */
function diffEncabezado(antes, despues) {
  const out = [];
  for (const k of Object.keys(ETIQUETAS_ENC)) {
    // Un campo que el cliente no manda no se considera borrado.
    if (!despues || !(k in despues)) continue;
    const a = txt(antes && antes[k]);
    const b = txt(despues[k]);
    if (a !== b) out.push(fila('Encabezado', null, ETIQUETAS_ENC[k], a, b));
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Detalle: se emparejan las líneas por código + n° de equipo. Si un código
   aparece varias veces, se emparejan en orden de aparición. Lo que no encuentra
   pareja es una línea agregada (en el nuevo) o eliminada (en el anterior).
   --------------------------------------------------------------------------- */
function diffDetalle(antes, despues) {
  const viejas = Array.isArray(antes) ? antes.slice() : [];
  const nuevas = Array.isArray(despues) ? despues.slice() : [];
  const out = [];

  // Índice de las líneas anteriores por clave, conservando su posición original.
  const porClave = new Map();
  viejas.forEach((d, i) => {
    const k = claveLinea(d);
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push({ d, linea: i + 1 });
  });

  nuevas.forEach((nd, i) => {
    const linea = i + 1;
    const cola = porClave.get(claveLinea(nd));
    if (cola && cola.length) {
      const { d: vd } = cola.shift();
      for (const [k, etiqueta] of CAMPOS_DET) {
        const a = txt(vd[k]), b = txt(nd[k]);
        if (a !== b) out.push(fila('Detalle', linea, etiqueta, a, b));
      }
    } else {
      out.push(fila('Detalle', linea, 'Línea agregada', '', resumenLinea(nd)));
    }
  });

  // Lo que quedó sin emparejar en el anterior: líneas eliminadas.
  const borradas = [];
  porClave.forEach(cola => cola.forEach(x => borradas.push(x)));
  borradas.sort((x, y) => x.linea - y.linea);
  borradas.forEach(({ d, linea }) => {
    out.push(fila('Detalle', linea, 'Línea eliminada', resumenLinea(d), ''));
  });

  return out;
}

/* ---------------------------------------------------------------------------
   Estado: solo si de verdad cambia.
   --------------------------------------------------------------------------- */
function diffEstado(antes, despues) {
  const a = txt(antes), b = txt(despues);
  if (!b || a === b) return [];
  return [fila('Estado', null, 'Estado', a, b)];
}

/* Diff completo. `antes` y `despues` son { encabezado, detalle, estado }. */
function diffHoja(antes, despues) {
  return [
    ...diffEncabezado(antes.encabezado, despues.encabezado),
    ...diffDetalle(antes.detalle, despues.detalle),
    ...diffEstado(antes.estado, despues.estado)
  ];
}

/* ---------------------------------------------------------------------------
   Graba los cambios. Recibe el `client` de la transacción en curso, así que si
   el UPDATE se revierte, la auditoría también. Sin cambios no escribe nada.
   --------------------------------------------------------------------------- */
async function grabarCambios(client, ctx, cambios) {
  if (!cambios || !cambios.length) return 0;
  for (const c of cambios) {
    await client.query(
      `INSERT INTO dbo.HojaConsumoAuditoria
         (IdHojaConsumo, NumeroHoja, Usuario, UsuarioEmail, Rol, Seccion, Linea, Campo, ValorAnterior, ValorNuevo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.id, ctx.numeroHoja || null, ctx.usuario || '(desconocido)', ctx.email || null,
        ctx.rol || null, c.seccion, c.linea, c.campo, c.anterior, c.nuevo]);
  }
  return cambios.length;
}

module.exports = {
  ETIQUETAS_ENC, CAMPOS_DET,
  diffEncabezado, diffDetalle, diffEstado, diffHoja,
  grabarCambios, resumenLinea, claveLinea
};
