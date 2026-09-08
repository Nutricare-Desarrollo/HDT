/* Comparación de bandejas por el texto impreso.
   ============================================================================
   Aislado de la base y de Azure a propósito: recibe textos y devuelve un
   veredicto, así se puede probar contra los datos reales sin levantar nada.

   QUÉ COMPARA. No las imágenes: el TEXTO impreso en la bandeja. Las de placas
   traen el código de producto de 8 dígitos junto a cada posición; las de
   instrumental traen el nombre en inglés («Plate Holding Instruments»,
   «Cannulated Screwdriver SW3.5»). Los dos sirven, con distinta fuerza.

   CÓMO. Cada texto se parte en palabras y pares de palabras, y aparte se
   extraen los DISCRIMINADORES —calibres y códigos— que pesan doce veces más.
   La razón está medida: las tres bandejas de canulados comparten once de
   trece nombres de instrumento y lo único que las separa es «Ø1.6mm» contra
   «Ø1.2mm» contra «Ø2.5mm». Sin ese peso, el acierto baja de 10 a 9 de 13.

   Después, TF-IDF y coseno. El IDF importa: una etiqueta que aparece en todas
   las bandejas no distingue nada, y una que aparece en una sola vale oro.

   POR QUÉ HAY UN «NO PUEDO DETERMINARLO». Porque no existe un umbral que
   separe limpio. Medido sobre 13 bandejas contra las 118: con el corte en
   0,20 acepta 12 de 13 correctas pero deja pasar 7 ajenas; con 0,30 rechaza 4
   buenas y todavía deja pasar 2. Las distribuciones se solapan. Forzar un
   binario obliga a mentir en uno de los dos sentidos, así que cuando el dato
   no alcanza la respuesta es que no alcanza.
   ========================================================================= */

'use strict';

/* Peso de los discriminadores. Medido: con 0 acierta 9 de 13, con 4 acierta 9,
   con 12 acierta 10. No se sube más porque una lectura equivocada de un
   calibre pesaría lo mismo que doce nombres bien leídos. */
const PESO_DISC = 12;

/* Cortes del veredicto. Con las 118 bandejas fotografiadas y 4 o 5 fotos cada
   una, conviene volver a medirlos: salieron de 13 bandejas con particiones
   finas y algunas quedaron con una sola foto de referencia. */
const MIN_TERMINOS   = 8;     // menos que esto es no haber leído nada útil
const MIN_PUNTAJE    = 0.25;  // por debajo, no se afirma que sea la pedida
const MIN_MARGEN     = 0.10;  // diferencia contra la segunda candidata
const MARGEN_CONTRA  = 0.12;  // cuánto tiene que ganarle otra para decir «Incorrecta»
/* Piso de «esto no es una bandeja». Es OTRA pregunta que la del umbral que no
   se pudo cerrar: no «cual de las 118 es» sino «es alguna». Medido sobre las
   fotos que pasan MIN_TERMINOS: el techo del ranking completo de las fotos
   ajenas llega a 0.058, y la legitima mas floja -una sola foto, la peor de las
   50- arranca en 0.309. El hueco entre las dos es de sobra. Se pone en 0.10,
   pegado al lado de las ajenas, porque equivocarse hacia arriba cambiaria el
   mensaje de una bandeja de verdad. Volver a medirlo cuando el catalogo este
   leido, igual que MIN_PUNTAJE. */
const MIN_PISO       = 0.10;

const RE_MED = /\b(\d{1,2}[.,]\d)\s*mm\b/g;
const RE_SW  = /\bsw\s*(\d{1,2}[.,]?\d?)/g;
const RE_COD = /\b(\d{6,8})\b/g;

/* Sin tildes, en minúscula, y sin nada que no sea letra, dígito, punto o
   barra. La «Ø» se cae acá, y da igual: lo que discrimina es el número. */
function normalizar(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Texto -> cuenta de términos. Se queda solo con las líneas que tienen al
   menos cuatro letras seguidas: así se descartan las escalas de la regla y los
   numeritos de las cuadrículas de tornillos, que son ruido puro. */
function terminos(texto) {
  const t = new Map();
  const suma = (k, n) => t.set(k, (t.get(k) || 0) + n);
  for (const cruda of String(texto || '').split('\n')) {
    const l = normalizar(cruda);
    if ((l.match(/[a-z]/g) || []).length < 4) continue;
    const ws = l.split(' ').filter((w) => w.length >= 3);
    for (const w of ws) suma(w, 1);
    for (let i = 0; i + 1 < ws.length; i++) suma(ws[i] + '_' + ws[i + 1], 1);
    let m;
    RE_MED.lastIndex = 0; while ((m = RE_MED.exec(l))) suma('MED:' + m[1].replace(',', '.'), PESO_DISC);
    RE_SW.lastIndex  = 0; while ((m = RE_SW.exec(l)))  suma('SW:'  + m[1].replace(',', '.'), PESO_DISC);
    RE_COD.lastIndex = 0; while ((m = RE_COD.exec(l))) suma('COD:' + m[1], PESO_DISC);
  }
  return t;
}

/* ===========================================================================
   FOTOS QUE NO SON DE UNA BANDEJA
   ---------------------------------------------------------------------------
   Se subieron fotos de la HOJA DE CONSUMO impresa y pantallazos de Dynamics.
   Tienen muchisimo texto, asi que pasan MIN_TERMINOS de sobra y el motor
   contesta como si fueran una bandeja mal fotografiada: «coincide poco,
   compare a ojo y confirme usted». Ese es el problema. Ese camino deja que
   Bodega estampe «Correcta» sobre la foto de un papel.

   COMO SE RECONOCEN. Por los rotulos FIJOS que imprimimos nosotros mismos —
   los encabezados de columna y los pies de firma de imprimirDoc(), la barra de
   Dynamics, los rotulos de esta propia pantalla—. No por el contenido escrito
   a mano, que varia. Son pares de palabras a proposito: «nutricare» sola no
   sirve porque las bandejas llevan la marca, y «cirujano» sola tampoco.

   MEDIDO contra el texto real de las 60 fotos del Paso 0: CERO marcadas por
   error. Una hoja de consumo dispara 5 marcas y un pantallazo de Dynamics 4,
   asi que pedir DOS deja margen de sobra y una coincidencia sola no alcanza.

   OJO CON POR QUE ESTO NO ES UN ADORNO. Hoy una hoja de consumo puntea casi
   cero porque las etiquetas de las bandejas estan en ingles -«locking screws»,
   «plate holding instruments»- y la hoja lleva codigos de articulo. Pero 5790
   de los 6060 productos del catalogo son codigos de 6 a 8 digitos, y este
   motor los pesa DOCE veces como discriminadores. El dia que una bandeja
   tenga sus codigos impresos visibles en las fotos de referencia -ya hay 2 de
   14 asi-, la hoja de consumo de esa cirugia lista exactamente esos codigos y
   va a puntear ALTO contra esa misma bandeja. Ahi el veredicto diria
   «Correcta» sobre un papel. Esto es lo que lo evita.
   ======================================================================== */
const HUELLAS = [
  { tipo: 'hoja', etiqueta: 'una hoja de consumo',
    marcas: ['reposicion_anaquel', 'und._reposicion', 'codigo_numero', 'numero_equipo',
             'firma_cirujano', 'firma_soporte', 'soporte_quirurgico',
             'hospital_del', 'del_trauma', 'trauma_ins'] },
  { tipo: 'dynamics', etiqueta: 'un pantallazo de Dynamics',
    marcas: ['vista_estandar', 'guardar_cerrar', 'numero_articulo', 'articulos_del',
             'inicio_recientes', 'recientes_anclado', 'articulo_nombre', 'cantidad_unidad'] },
  { tipo: 'app', etiqueta: 'un pantallazo de esta misma pantalla',
    marcas: ['corporacion_nutricare', 'validar_bandeja', 'bandeja_alistada',
             'fotos_bandeja', 'elegir_galeria', 'puedo_determinarlo'] }
];
const MIN_HUELLA = 2;

/* Devuelve null si el texto puede ser de una bandeja, o { tipo, etiqueta,
   marcas } si es uno de nuestros propios documentos. Gana la huella con mas
   marcas: una foto de la hoja apoyada sobre la pantalla puede tocar dos. */
function clasificarAjena(texto) {
  const t = terminos(texto);
  let mejor = null;
  for (const h of HUELLAS) {
    const m = h.marcas.filter((k) => t.has(k));
    if (m.length >= MIN_HUELLA && (!mejor || m.length > mejor.marcas.length)) {
      mejor = { tipo: h.tipo, etiqueta: h.etiqueta, marcas: m };
    }
  }
  return mejor;
}

/* Junta los textos de varias fotos en un solo conjunto. Es a propósito: un
   recipiente puede no tener casi texto y otro tenerlo todo, y lo que
   identifica la bandeja es el conjunto, no cada foto por separado. */
function terminosDeVarias(textos) {
  const t = new Map();
  for (const x of textos || []) {
    for (const [k, n] of terminos(x)) t.set(k, (t.get(k) || 0) + n);
  }
  return t;
}

/* IDF sobre TODAS las bandejas con referencia. `refs` es
   { codigo: Map(termino -> cuenta) }. */
function construirIdf(refs) {
  const codigos = Object.keys(refs);
  const N = codigos.length || 1;
  const df = new Map();
  for (const c of codigos) for (const k of refs[c].keys()) df.set(k, (df.get(k) || 0) + 1);
  const idf = new Map();
  for (const [k, n] of df) idf.set(k, Math.log((N + 1) / (n + 0.5)));
  return { idf, faltante: Math.log(N + 1) };
}

/* Vector normalizado, para que el coseno no premie a la bandeja que más texto
   tiene sino a la que mejor coincide. */
function vector(t, idfInfo) {
  const v = new Map();
  let sum2 = 0;
  for (const [k, n] of t) {
    const x = (1 + Math.log(Math.max(n, 1))) * (idfInfo.idf.get(k) ?? idfInfo.faltante);
    v.set(k, x); sum2 += x * x;
  }
  const norma = Math.sqrt(sum2) || 1;
  for (const [k, x] of v) v.set(k, x / norma);
  return v;
}
function coseno(a, b) {
  let s = 0;
  const [chico, grande] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, x] of chico) { const y = grande.get(k); if (y) s += x * y; }
  return s;
}

/* ---------------------------------------------------------------------------
   El veredicto.
     textosEntrega : los textos leídos de las fotos que subió Bodega
     pedida        : código de la bandeja que pide la solicitud
     refs          : { codigo: [textos de sus fotos de referencia] }
     gemelas       : códigos con contenido idéntico al de la pedida
     color         : { observado, catalogo } — opcional
   Devuelve { resultado, motivo, puntaje, candidato, candidato_puntaje, ranking }
   --------------------------------------------------------------------------- */
function veredicto({ textosEntrega, pedida, refs, gemelas = [], color = null }) {
  /* Primero se apartan las fotos que no son de una bandeja. No se descartan en
     silencio: se dice cuales y de que son, porque el que las subio tiene que
     saber cual sacar. */
  const todas = (textosEntrega || []).map((tx, i) => ({ i, tx, ajena: clasificarAjena(tx) }));
  const ajenas = todas.filter((x) => x.ajena)
    .map((x) => ({ indice: x.i + 1, tipo: x.ajena.tipo, etiqueta: x.ajena.etiqueta }));
  const propias = todas.filter((x) => !x.ajena).map((x) => x.tx);
  const listaAjenas = () => ajenas.map((a) => 'la ' + a.indice + ' parece ' + a.etiqueta).join(', ');

  /* Todas ajenas: no hay nada que comparar, y el mensaje NO invita a confirmar
     a mano. Confirmar sobre un papel es justo lo que hay que evitar. */
  if (ajenas.length && !propias.length) {
    return { resultado: 'No puedo determinarlo', puntaje: null, candidato: null, candidato_puntaje: null,
      ranking: [], ajenas,
      motivo: (ajenas.length === 1
          ? 'La foto subida no es de la bandeja: parece ' + ajenas[0].etiqueta + '. '
          : 'Ninguna de las ' + ajenas.length + ' fotos es de la bandeja (' + listaAjenas() + '). ')
        + 'Elimínela' + (ajenas.length === 1 ? '' : 's')
        + ' y fotografíe los recipientes de la bandeja, con las etiquetas a la vista.' };
  }

  const tEnt = terminosDeVarias(propias);
  const nombresRef = Object.keys(refs || {}).filter((c) => (refs[c] || []).some((x) => String(x || '').trim()));

  if (tEnt.size < MIN_TERMINOS) {
    return { resultado: 'No puedo determinarlo', puntaje: null, candidato: null, candidato_puntaje: null, ranking: [], ajenas,
      /* Es el caso mas comun y hay que decir que hacer, no solo que fallo. En la
         NUT-0001330, por ejemplo, las cajas plasticas de tornillos casi no
         tienen texto y el recipiente de instrumental lo tiene todo: fotografiar
         uno u otro cambia el resultado. */
      motivo: 'De estas fotos no se pudo leer texto suficiente para comparar. Tome también una foto del '
        + 'recipiente que tenga las etiquetas impresas —el de instrumental suele ser el que más texto trae— '
        + 'o compare a ojo con la referencia y confirme usted.' };
  }
  if (!nombresRef.includes(pedida)) {
    return { resultado: 'No puedo determinarlo', puntaje: null, candidato: null, candidato_puntaje: null, ranking: [], ajenas,
      motivo: 'Esta bandeja no tiene fotos de referencia leídas en el catálogo, así que no hay contra qué '
        + 'compararla. Súbalas en Mantenimiento → Bandejas.' };
  }

  const refsT = {};
  for (const c of nombresRef) refsT[c] = terminosDeVarias(refs[c]);
  const idfInfo = construirIdf(refsT);
  const vEnt = vector(tEnt, idfInfo);

  const ranking = nombresRef
    .map((c) => ({ codigo: c, puntaje: Math.round(coseno(vEnt, vector(refsT[c], idfInfo)) * 1000) / 1000 }))
    .sort((a, b) => b.puntaje - a.puntaje);

  const mio = ranking.find((r) => r.codigo === pedida) || { puntaje: 0 };
  const otras = ranking.filter((r) => r.codigo !== pedida);
  const mejorOtra = otras[0] || { codigo: null, puntaje: 0 };

  const base = {
    puntaje: mio.puntaje,
    candidato: mejorOtra.codigo,
    candidato_puntaje: mejorOtra.puntaje,
    ranking: ranking.slice(0, 5),
    ajenas
  };

  /* NINGUNA bandeja del catalogo se parece a esto. Es distinto de «no se
     distingue cual es»: el texto que se leyo no parece el de una bandeja. Va
     ANTES de «Incorrecta» a proposito -con todo el ranking en el piso, la
     segunda le puede ganar por centesimas y no significa nada- y devuelve
     candidato en null, porque un candidato de 0.040 no es un candidato: la
     pantalla agregaba «Se parece mas a X» y mandaba a buscar otra bandeja. */
  if (!ranking.length || ranking[0].puntaje < MIN_PISO) {
    return { ...base, resultado: 'No puedo determinarlo', candidato: null, candidato_puntaje: null,
      motivo: 'Se leyó texto, pero no se parece al de NINGUNA de las ' + nombresRef.length
        + ' bandejas del catálogo: la más alta quedó en ' + (ranking.length ? ranking[0].puntaje.toFixed(3) : '0.000')
        + ' y esta bandeja en ' + mio.puntaje.toFixed(3) + '. No es que no se distinga cuál es: es que esto no '
        + 'parece una bandeja. Revise que las fotos sean de los recipientes'
        + (ajenas.length ? ' —' + listaAjenas() + '—' : '') + ' y no de un documento o una pantalla.' };
  }

  /* Otra bandeja le gana por un margen claro -> es otra, y se dice cuál. Es la
     primera pregunta que se hace Bodega frente a un «Incorrecta»: ¿cuál es? */
  if (mejorOtra.codigo && mejorOtra.puntaje - mio.puntaje >= MARGEN_CONTRA) {
    return { ...base, resultado: 'Incorrecta',
      motivo: 'El texto de estas fotos corresponde mejor a otra bandeja. Se parece más a ' + mejorOtra.codigo
        + ' (' + mejorOtra.puntaje.toFixed(3) + ') que a la que pide la solicitud (' + mio.puntaje.toFixed(3)
        + '). Revise si es la bandeja correcta antes de entregarla.' };
  }

  /* Ni gana la pedida con holgura ni pierde con holgura. */
  if (mio.puntaje < MIN_PUNTAJE) {
    return { ...base, resultado: 'No puedo determinarlo',
      motivo: 'Se leyó texto, pero coincide poco con la referencia de esta bandeja (' + mio.puntaje.toFixed(3)
        + '). Puede ser una foto de un recipiente que no está fotografiado en el catálogo, o una toma muy '
        + 'parcial. Compare a ojo y confirme usted.' };
  }
  if (mejorOtra.codigo && mio.puntaje - mejorOtra.puntaje < MIN_MARGEN) {
    return { ...base, resultado: 'No puedo determinarlo',
      motivo: 'Coincide con esta bandeja (' + mio.puntaje.toFixed(3) + ') pero casi igual con ' + mejorOtra.codigo
        + ' (' + mejorOtra.puntaje.toFixed(3) + '): la diferencia es demasiado chica para afirmar cuál es. '
        + 'Compare a ojo y confirme usted.' };
  }

  /* Coincide. Falta el único caso que el texto no puede resolver nunca. */
  if (gemelas && gemelas.length) {
    const obs = normalizar(color && color.observado);
    const cat = normalizar(color && color.catalogo);
    const mismoColor = gemelas.filter((g) => cat && normalizar(g.color) === cat);
    if (mismoColor.length) {
      return { ...base, resultado: 'No puedo determinarlo',
        motivo: 'El texto corresponde, pero ' + mismoColor.map((g) => g.demarcado || g.codigo).join(', ')
          + ' tiene exactamente el mismo contenido —así que imprime el mismo texto— y también es '
          + (color && color.catalogo) + '. Ni la foto ni el color alcanzan: confirme con la etiqueta de '
          + 'fábrica del recipiente.' };
    }
    if (!obs) {
      return { ...base, resultado: 'No puedo determinarlo',
        motivo: 'El texto corresponde a esta familia, pero ' + gemelas.map((g) => g.demarcado || g.codigo).join(', ')
          + ' tiene el mismo contenido y por lo tanto el mismo texto impreso. '
          + 'Registre el color de demarcación: es lo único que las distingue.' };
    }
    if (obs !== cat) {
      return { ...base, resultado: 'Incorrecta',
        motivo: 'El texto corresponde a la familia, pero el catálogo dice que esta bandeja es '
          + (color && color.catalogo) + ' y en la bandeja física se ve ' + (color && color.observado)
          + '. Con este contenido, el color es lo que identifica cuál de las copias es.' };
    }
    return { ...base, resultado: 'Correcta',
      motivo: 'El texto corresponde (' + mio.puntaje.toFixed(3) + ') y el color de demarcación desempata frente a '
        + gemelas.map((g) => g.demarcado || g.codigo).join(', ') + ', que tienen el mismo contenido.' };
  }

  return { ...base, resultado: 'Correcta',
    motivo: 'El texto impreso corresponde a esta bandeja (' + mio.puntaje.toFixed(3)
      + ') y la siguiente candidata queda en ' + (mejorOtra.puntaje || 0).toFixed(3)
      + '. Ninguna otra bandeja del catálogo tiene este contenido.' };
}

/* El veredicto de arriba, con la nota de las fotos apartadas pegada al final
   del motivo. Se hace aca y no en cada rama para no repetirla nueve veces, y
   porque el motivo es lo que se graba y lo que sale en el correo: si el
   puntaje se calculo ignorando dos fotos, eso tiene que quedar escrito. */
function veredictoConNota(args) {
  const v = veredicto(args);
  const a = v.ajenas || [];
  if (!a.length) return v;
  const lista = a.map((x) => 'la ' + x.indice + ' parece ' + x.etiqueta).join(', ');
  /* Las dos ramas que ya hablan de las apartadas -todas ajenas, y el piso- las
     nombran en su propio motivo. No se repite. */
  if (v.motivo.indexOf(lista) !== -1) return v;
  if (a.length === 1 && v.motivo.indexOf('parece ' + a[0].etiqueta) !== -1) return v;
  return { ...v, motivo: v.motivo + ' Se ignoró ' + (a.length === 1 ? '1 foto que no es de la bandeja'
    : a.length + ' fotos que no son de la bandeja') + ' (' + lista + '): no cuenta' + (a.length === 1 ? '' : 'n')
    + ' para el puntaje.' };
}

/* Debajo de esto, un parecido entre dos fotos es ruido: dos fotos de
   instrumental cualquiera comparten «screw», «drill» y poco mas. Es a
   proposito mas bajo que MIN_PUNTAJE -0.25-, porque aca la pregunta es otra:
   no «es esta la bandeja», sino «de estas cuatro fotos, cual va con cual». */
const MIN_PAREO = 0.08;
/* Y ademas tiene que GANARLE a la segunda por este margen. Sin esto el
   emparejado inventa: en la NUT-0001330, cuatro de sus cinco fotos son los
   recipientes plasticos de tornillos y su texto es identico -«locking screws /
   cortex screws», cinco terminos, coseno 1.000 entre las cuatro-. No hay nada
   que las distinga, y elegir una era tirar los dados. Cuando la eleccion no
   es clara se devuelve SIN par y la pantalla cae en el orden posicional, que
   por lo menos es estable y previsible. */
const MARGEN_PAREO = 0.05;

/* Empareja cada foto de la ENTREGA con la foto del CATALOGO que mas se le
   parece por el texto que se leyo en cada una.

   Para que sirve: Bodega no toma las fotos en el mismo orden en que estan
   cargadas en el catalogo -no tiene por que saberlo-, asi que compararlas por
   posicion ponia lado a lado el recipiente de tornillos contra el del
   instrumental. Emparejar por contenido usa el texto que YA se leyo: no
   cuesta una llamada mas a Azure ni le pide nada al usuario.

   El emparejado es GOLOSO y no optimo: se ordenan todos los pares posibles
   por parecido y se van tomando de mayor a menor, saltando los que ya usaron
   una de las dos fotos. Con cuatro o seis fotos por lado la diferencia contra
   un asignamiento optimo -el hungaro- es despreciable, y esto se lee.

   Las fotos sin texto no se emparejan: no hay con que. Quedan sueltas y la
   pantalla las pone al final, que es honesto: nadie sabe con cual van. */
function parear(refs, entrega) {
  const docs = {};
  const tr = new Map(), te = new Map();
  for (const f of refs)    { const t = terminos(f.texto); tr.set(String(f.id), t); docs['r' + f.id] = t; }
  for (const f of entrega) { const t = terminos(f.texto); te.set(String(f.id), t); docs['e' + f.id] = t; }
  const idf = construirIdf(docs);

  /* El margen se mide contra TODAS las referencias, antes de repartir nada:
     la pregunta es si esta foto de la entrega es distinguible de por si, y esa
     respuesta no puede depender de a quien le tocaron las otras. */
  const cand = [];
  for (const [ide, t1] of te) {
    if (!t1.size) continue;
    const v1 = vector(t1, idf);
    const fila = [];
    for (const [idr, t2] of tr) {
      if (!t2.size) continue;
      fila.push({ e: ide, r: idr, s: coseno(v1, vector(t2, idf)) });
    }
    fila.sort((a, b) => b.s - a.s);
    if (!fila.length || fila[0].s < MIN_PAREO) continue;
    const segunda = fila.length > 1 ? fila[1].s : 0;
    if (fila[0].s - segunda < MARGEN_PAREO) continue;   // empate: no se adivina
    cand.push(fila[0]);
  }
  cand.sort((a, b) => b.s - a.s);

  /* Reparto goloso: dos fotos de la entrega pueden querer la misma referencia
     y solo una se la lleva. La otra queda sin par y cae en el orden
     posicional, que es mejor que darle una que ya se sabe que no es suya. */
  const usadaR = new Set(), par = {};
  for (const c of cand) {
    if (usadaR.has(c.r)) continue;
    usadaR.add(c.r);
    par[c.e] = { referencia: c.r, puntaje: Number(c.s.toFixed(3)) };
  }
  return par;
}

module.exports = { veredicto: veredictoConNota, veredictoCrudo: veredicto,
                   clasificarAjena, parear, terminos, terminosDeVarias, normalizar,
                   construirIdf, vector, coseno, HUELLAS,
                   PESO_DISC, MIN_TERMINOS, MIN_PUNTAJE, MIN_MARGEN, MARGEN_CONTRA,
                   MIN_PISO, MIN_HUELLA, MIN_PAREO, MARGEN_PAREO };
