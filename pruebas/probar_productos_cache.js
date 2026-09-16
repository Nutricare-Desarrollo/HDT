/* Que el catalogo de productos NO se pierda cuando el origen falla.
 *
 *   node probar_productos_cache.js                  # contra api/src/productos.js
 *   node probar_productos_cache.js /ruta/a/otro.js  # contra otra version
 *
 * EL CASO REAL (16 de setiembre). El catalogo dejo de cargar y el navegador
 * mostraba «Error 500» sin explicacion. El flujo NO estaba fallando: todas las
 * corridas en Succeeded, pero tardando 50-71 s contra 23-37 que tardaba antes.
 * Azure Static Web Apps corta TODA peticion a la API a los 45 s -limite duro,
 * igual en Free que en Standard, y no se configura-, asi que el 500 lo generaba
 * el gateway mientras el flujo seguia trabajando.
 *
 * Esta prueba no levanta navegador: reemplaza `fetch` global por un origen de
 * mentira al que se le puede decir «portate lento», «contesta 500» o «portate
 * bien», y mira que hace el modulo en cada caso.
 *
 * LAS DOS DEFENSAS SE NECESITAN JUNTAS, y por eso se prueban juntas: sin el
 * timeout propio la Function nunca alcanza a devolver la cache vieja -la mata
 * el gateway antes-, y sin la cache el timeout solo cambia un error por otro.
 *
 * CONTRA EL CODIGO ANTERIOR: pasa los dos primeros asertos -normalizar el
 * codigo no cambio- y despues SE CUELGA en el del origen lento, porque el
 * modulo viejo no aborta nunca. El guardia de tiempo lo convierte en un fallo
 * con nombre y salida 1. Ese cuelgue ES el bug: en produccion la peticion sigue
 * viva hasta que Azure la mata a los 45 s.
 *
 * Contra el modulo nuevo pasan los 10. */

const path = require('path');
const ruta = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'api', 'src', 'productos.js');

// Se aprietan los tiempos para que la prueba corra en menos de dos segundos.
process.env.PRODUCTOS_API_URL = 'https://origen-de-mentira/flujo';
process.env.PRODUCTOS_TIMEOUT_MS = '300';
process.env.PRODUCTOS_RETRY_MS = '400';
process.env.PRODUCTOS_CACHE_MS = '150';

const productos = require(ruta);

/* GUARDIA DE TIEMPO. Sin timeout propio, el modulo se queda esperando para
 * siempre al origen lento y la prueba se COLGARIA en vez de fallar -que es
 * justo lo que hace el codigo anterior-. Una prueba que se cuelga no dice
 * nada: este reloj la obliga a dar un veredicto. */
const guardia = setTimeout(() => {
  console.log('\n  FALLA el modulo se quedo esperando al origen lento y nunca corto.');
  console.log('        Es el sintoma exacto del caso real: sin AbortController la');
  console.log('        peticion sigue viva hasta que Azure la mata a los 45 s y');
  console.log('        devuelve un 500 que no explica nada.');
  console.log('\nLa prueba FALLA (se colgo).');
  process.exit(1);
}, 8000);
guardia.unref && guardia.unref();

let fallos = 0, corridos = 0;
function ok(cond, que, detalle) {
  corridos++;
  if (cond) { console.log('  OK   ' + que); return; }
  fallos++;
  console.log('  FALLA ' + que + (detalle ? '\n        ' + detalle : ''));
}

/* El origen de mentira. `modo` decide como se porta:
 *   'bien'  -> contesta el catalogo
 *   'lento' -> no contesta nunca (hay que abortarlo, como el flujo de 71 s)
 *   '500'   -> contesta 500 */
let modo = 'bien';
let llamadas = 0;
const CATALOGO = [
  { Codigo: '35063095', Descripcion: 'Tornillo NEOSUPRA 5.0x90mm', Bandeja: 'NUT-10147' },
  { Codigo: ' 35062035 ', Descripcion: 'Tornillo con espacios en el codigo', Bandeja: 'NUT-10105' },
  { Codigo: '10126', Descripcion: 'Otro', Bandeja: '' }
];

global.fetch = async (url, opt) => {
  llamadas++;
  if (modo === 'lento') {
    // Nunca resuelve: solo termina si el modulo lo aborta por timeout.
    return new Promise((_, rechazar) => {
      const t = setTimeout(() => {}, 30000);
      if (opt && opt.signal) {
        opt.signal.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('The operation was aborted');
          e.name = 'AbortError';
          rechazar(e);
        });
      }
    });
  }
  if (modo === '500') return { ok: false, status: 500, text: async () => 'Flow run failed' };
  return { ok: true, status: 200, text: async () => JSON.stringify(CATALOGO) };
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('Catalogo de productos: cache que sobrevive al fallo del origen');
  console.log('Modulo: ' + ruta + '\n');

  // ---- 1. Carga normal --------------------------------------------------
  const inicial = await productos.getCatalogo();
  ok(inicial.length === 3, 'carga inicial: 3 productos');
  ok(inicial[1].codigo === '35062035', 'el codigo se normaliza sin espacios',
     'se obtuvo ' + JSON.stringify(inicial[1] && inicial[1].codigo));

  // ---- 2. Origen lento, carga automatica: NO se queda sin catalogo ------
  modo = 'lento';
  await dormir(200); // vence el TTL
  let sobrevivio = null, errorAutomatico = null;
  try { sobrevivio = await productos.getCatalogo(); }
  catch (e) { errorAutomatico = e; }
  ok(sobrevivio && sobrevivio.length === 3,
     'origen lento: la carga automatica sigue sirviendo el catalogo viejo',
     errorAutomatico ? 'lanzo en vez de servir la cache: ' + errorAutomatico.message
                     : 'devolvio ' + (sobrevivio && sobrevivio.length) + ' productos');

  // ---- 3. El timeout es propio, no del gateway --------------------------
  //   Si el modulo no aborta, este aserto nunca llega: la prueba se cuelga.
  const antes = llamadas;
  const t0 = Date.now();
  try { await productos.getCatalogo(true); } catch (e) { /* se revisa abajo */ }
  const tardo = Date.now() - t0;
  ok(tardo < 1500, 'el modulo corta solo, sin esperar al gateway (' + tardo + ' ms)',
     'tardo ' + tardo + ' ms: no hay AbortController, lo mataria Azure a los 45 s');

  // ---- 4. El boton «Cargar productos» dice la verdad --------------------
  let errorBoton = null;
  try { await productos.getCatalogo(true); } catch (e) { errorBoton = e; }
  ok(errorBoton instanceof Error,
     'refresh=1 lanza el error real en vez de devolver la cache vieja',
     'el boton es la herramienta de diagnostico: devolver cache vieja seria mentir');

  // ---- 5. Y el mensaje se entiende --------------------------------------
  ok(errorBoton && /no respondi/i.test(errorBoton.message) && /45 s/.test(errorBoton.message),
     'el mensaje del timeout nombra el flujo y el limite de los 45 s',
     'se obtuvo: ' + (errorBoton && errorBoton.message || '(ninguno)').slice(0, 120));

  // ---- 6. No se reintenta en cada request durante el fallo --------------
  //   Sin esto, con el origen lento cada pantalla espera el timeout completo.
  const antesDeReintento = llamadas;
  const t1 = Date.now();
  const durante = await productos.getCatalogo();
  const tardoSegunda = Date.now() - t1;
  ok(llamadas === antesDeReintento && tardoSegunda < 50 && durante.length === 3,
     'durante el fallo responde de una vez, sin volver a golpear el origen (' + tardoSegunda + ' ms)',
     'llamadas al origen: ' + (llamadas - antesDeReintento) + ', tardo ' + tardoSegunda + ' ms');

  // ---- 7. Un 500 del origen se distingue de un timeout ------------------
  modo = '500';
  await dormir(450); // se agota la ventana de no-reintentar
  let error500 = null;
  try { await productos.getCatalogo(true); } catch (e) { error500 = e; }
  ok(error500 && /respondió 500/.test(error500.message),
     'un 500 del origen llega con su cuerpo, distinto del timeout',
     'se obtuvo: ' + (error500 && error500.message || '(ninguno)').slice(0, 120));

  // ---- 8. Tambien se sobrevive a un 500 ---------------------------------
  const tras500 = await productos.getCatalogo();
  ok(tras500 && tras500.length === 3,
     'tras el 500, la carga automatica sigue sirviendo el catalogo viejo');

  // ---- Cierre: el origen sano renueva la cache --------------------------
  modo = 'bien';
  await dormir(450);
  const sano = await productos.getCatalogo(true);
  ok(sano.length === 3, 'con el origen sano de nuevo, la cache se renueva');

  console.log('\n' + (fallos ? fallos + ' de ' + corridos + ' asertos FALLARON'
                              : 'Los ' + corridos + ' asertos pasan'));
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('\nLa prueba reviento: ' + e.stack); process.exit(1); });
