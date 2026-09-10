/* Cómo se ve una línea del detalle cuando el código no pertenece al equipo.

   Son dos reglas visuales, las dos nacidas del mismo caso real: en una hoja de
   consumo se eligió el producto 35062035 y se digitó NUT-10105 encima —que
   pertenece a los equipos 10126 y 10147, no a ese—. La aplicación SÍ lo
   detectó, dejó Guardar apagado y lo explicó en el aviso del pie, pero la
   persona no lo vio.

     1. LA MARCA VA EN ROJO, el mismo de «no existe en el catálogo». Estaba en
        ámbar para distinguir los dos casos, y el ámbar lee como «ojo, quizá»
        cuando en realidad frena el guardado igual que el rojo.
     2. EL FONDO DE DEMARCACIÓN NO SE PINTA cuando la celda va marcada. La
        celda del N° de equipo se pinta con el color de la bandeja —café, negro,
        morado—, y ese fondo se come el borde rojo justo en el momento en que
        hay que verlo.

   SE PRUEBAN LOS DOS CAMINOS, que son código distinto y se rompen por
   separado: el render inicial de la tabla (renderDet arma el `style` inline) y
   el repintado al teclear (markDetRow -> paintEquipoCell toca el.style). Con
   uno solo de los dos arreglado, el color aparece o desaparece según si la
   persona escribió la línea o la abrió ya escrita.

   No usa datos de mentira para la lógica: llama a las funciones REALES del
   index.html —comboBad, renderDet, markDetRow— con los catálogos en memoria,
   y mide con getComputedStyle, que es lo único que dice quién ganó la cascada.

   uso: node probar_marca_equipo.js [ruta al index.html]
*/
const { chromium } = require('playwright');
const path = require('path');

const IDX = path.resolve(process.argv[2] || '/mnt/user-data/uploads/HDT/frontend/index.html');
const CAFE = 'rgb(111, 78, 55)';      // el café del Anexo #2, #6f4e37
const BLANCO = 'rgb(255, 255, 255)';  // el fondo normal de un input
const ROJO = 'rgb(192, 57, 43)';      // var(--danger)

const res = []; const chk = (n, ok, x) => res.push((ok?'  OK  ':'  FALLA ')+n+(x?' — '+x:''));

(async () => {
  const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const pg = await (await nav.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  pg.on('pageerror', e => chk('sin errores de JS', false, e.message));
  await pg.goto('file://' + IDX, { waitUntil: 'domcontentloaded' });
  await pg.waitForTimeout(500);

  const r = await pg.evaluate(() => {
    /* Los catálogos son `let` de nivel de script: se asignan SIN `window.` o se
       crea una variable aparte y la pantalla sigue leyendo la original. */
    CATALOGO = new Map([['35042034', 'Clavo intramedular de tibia NEOSUPRA 10X340mm'],
                        ['35062035', 'Tornillo de bloqueo NEOSUPRA 4.5X35mm']]);
    SIMA = new Map();
    EQUIPOS = new Map([['10105', { nombre: 'Clavos de tibia', color: 'café' }]]);
    EQUIPOPROD = new Map([['10105', new Set(['35042034'])],
                          ['10126', new Set(['35062035'])],
                          ['10147', new Set(['35062035'])]]);

    const buena = { codigo: '35042034', numero_equipo: 'NUT-10105', und: 1, reposicion_anaquel: 1 };
    const mala  = { codigo: '35062035', numero_equipo: 'NUT-10105', und: 1, reposicion_anaquel: 1 };
    const out = {
      falta: [],
      comboBuena: typeof comboBad === 'function' ? comboBad(buena) : null,
      comboMala:  typeof comboBad === 'function' ? comboBad(mala)  : null
    };
    for (const f of ['comboBad', 'renderDet', 'markDetRow', 'paintEquipoCell', 'equipoCellCls'])
      if (typeof window[f] !== 'function' && typeof eval('typeof ' + f) !== 'function') out.falta.push(f);

    const inp = (i, k) => document.querySelector(`#detBody input[data-i="${i}"][data-k="${k}"]`);
    const leer = (i, k) => {
      const e = inp(i, k); if (!e) return null;
      const s = getComputedStyle(e);
      return { fondo: s.backgroundColor, borde: s.borderTopColor, clase: e.className.trim(), title: e.title || '' };
    };

    /* ── Camino 1: el render inicial ─────────────────────────────────────── */
    WIZ = { detalle: [buena, mala], baseline: null };
    renderDet();
    out.render = { buenaEq: leer(0, 'numero_equipo'), malaEq: leer(1, 'numero_equipo'),
                   malaCod: leer(1, 'codigo'), buenaCod: leer(0, 'codigo') };

    /* ── Camino 2: el repintado al teclear ───────────────────────────────── */
    /* Se ensucia la celda a mano -como la dejaría un render anterior- y se
       manda a marcar: paintEquipoCell tiene que limpiarla. */
    const e1 = inp(1, 'numero_equipo');
    if (e1) { e1.style.background = '#6f4e37'; e1.style.color = '#fff'; }
    markDetRow('#detBody', 1, mala);
    markDetRow('#detBody', 0, buena);
    out.repintado = { buenaEq: leer(0, 'numero_equipo'), malaEq: leer(1, 'numero_equipo') };

    /* ── Y que al corregir el equipo el color VUELVA ─────────────────────── */
    const corregida = { codigo: '35062035', numero_equipo: 'NUT-10126', und: 1, reposicion_anaquel: 1 };
    EQUIPOS.set('10126', { nombre: 'Tornillos', color: 'café' });
    WIZ.detalle[1] = corregida;
    markDetRow('#detBody', 1, corregida);
    out.corregida = leer(1, 'numero_equipo');
    return out;
  });

  chk('están las funciones reales del detalle', r.falta.length === 0, r.falta.join(', '));
  chk('comboBad reconoce la combinación buena como válida', r.comboBuena === false, String(r.comboBuena));
  chk('y la mala (35062035 con NUT-10105) como inválida', r.comboMala === true, String(r.comboMala));

  /* ── La marca en rojo ─────────────────────────────────────────────────── */
  chk('RENDER · la celda del equipo malo lleva la clase del cruce',
      /combo-invalid/.test((r.render.malaEq || {}).clase || ''), (r.render.malaEq || {}).clase);
  chk('RENDER · y su borde es ROJO, no ámbar',
      (r.render.malaEq || {}).borde === ROJO, (r.render.malaEq || {}).borde);
  chk('RENDER · la celda del código también, que es donde está el error',
      (r.render.malaCod || {}).borde === ROJO, (r.render.malaCod || {}).borde);
  chk('RENDER · y explica el motivo en el title', /no pertenece/i.test((r.render.malaEq || {}).title || ''),
      (r.render.malaEq || {}).title);

  /* ── El fondo blanco cuando hay error ────────────────────────────────── */
  chk('RENDER · la línea BUENA conserva su color de demarcación (café)',
      (r.render.buenaEq || {}).fondo === CAFE, (r.render.buenaEq || {}).fondo);
  chk('RENDER · la línea MALA queda con fondo blanco: el café tapaba el borde rojo',
      (r.render.malaEq || {}).fondo === BLANCO, (r.render.malaEq || {}).fondo);
  chk('REPINTADO · la buena sigue con su café al remarcarla',
      (r.repintado.buenaEq || {}).fondo === CAFE, (r.repintado.buenaEq || {}).fondo);
  chk('REPINTADO · la mala se LIMPIA a blanco aunque venía pintada',
      (r.repintado.malaEq || {}).fondo === BLANCO, (r.repintado.malaEq || {}).fondo);
  chk('REPINTADO · y el borde rojo sigue puesto',
      (r.repintado.malaEq || {}).borde === ROJO, (r.repintado.malaEq || {}).borde);

  /* ── Y se puede volver: no es una vía de un solo sentido ─────────────── */
  chk('al corregir el equipo, el color de demarcación VUELVE',
      (r.corregida || {}).fondo === CAFE, (r.corregida || {}).fondo);
  chk('y la marca de error se va', !/invalid/.test((r.corregida || {}).clase || ''),
      (r.corregida || {}).clase);

  await pg.close();
  await nav.close();
  console.log(res.join('\n'));
  const malas = res.filter(x => x.startsWith('  FALLA'));
  console.log('\n' + res.length + ' asertos, ' + malas.length + ' fallas');
  process.exit(malas.length ? 1 : 0);
})().catch(e => { console.log(res.join('\n')); console.log('\nERROR: ' + e.message + '\n' + e.stack); process.exit(1); });
