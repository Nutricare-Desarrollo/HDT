/* Rol 'Impresión': el kiosco del hospital. Tres partes, y ninguna reescribe la
   regla que prueba.

   PARTE 1 — EL CANDADO, y es la que importa. No comprueba «estos endpoints
   devuelven 403»: ENUMERA todos los app.http() del api/src/index.js real y
   exige 403 en cada uno que no esté en la lista blanca. Un endpoint nuevo que
   alguien agregue en marzo entra solo en esta prueba, y si por alguna razón
   quedara abierto al kiosco, esta prueba se cae. Eso es lo que hace que el
   candado sea deny-by-default y no una lista de buenas intenciones.

   PARTE 2 — EL ALCANCE, contra un PostgreSQL de verdad con las migraciones
   aplicadas. La condición SQL y el SELECT del listado se EXTRAEN del index.js
   y se corren contra columnas que existen: si alguien renombra EsReemplazo o
   FechaCreacion, esta prueba se cae. Cubre el caso que motivó la ventana de
   días —la hoja que nace enviada y nunca pasa por 'Pendiente reposición'— y
   los dos bordes de los 7 días.

   PARTE 3 — LA PANTALLA. El menú de los cuatro roles, la cola de impresión, y
   que imprimir siga imprimiendo aunque la marca falle.

   uso: node probar_rol_impresion.js <socket-pg> <puerto> [index.js] [index.html] [dir-migraciones]
*/
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { chromium } = require('playwright');

const SOCK = process.argv[2] || '/tmp/pgtest/run';
const PORT = Number(process.argv[3] || 5433);
/* Rutas absolutas: file:// no acepta una relativa y el error que da -
   ERR_INVALID_URL- no se parece en nada a la causa. */
const API  = path.resolve(process.argv[4] || '/mnt/user-data/uploads/HDT/api/src/index.js');
const IDX  = path.resolve(process.argv[5] || '/mnt/user-data/uploads/HDT/frontend/index.html');
const MIGS = path.resolve(process.argv[6] || '/mnt/user-data/uploads/HDT/database');

const res = []; const chk = (n, ok, x) => res.push((ok?'  OK  ':'  FALLA ')+n+(x?' — '+x:''));

/* Saca del fuente un trozo delimitado por dos textos. */
function trozo(src, desde, hasta) {
  const i = src.indexOf(desde); if (i < 0) return null;
  const j = src.indexOf(hasta, i); if (j < 0) return null;
  return src.slice(i, j);
}
/* Todos los endpoints registrados, con su método y su ruta, leídos del
   fuente. Es la lista contra la que se prueba el candado. */
function endpoints(src) {
  const out = [];
  const re = /app\.http\(\s*'([^']+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let d = 0, j = m.index + m[0].length - 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (!d) break; }
    }
    const cuerpo = src.slice(m.index, j + 1);
    const met = /methods:\s*\[([^\]]*)\]/.exec(cuerpo);
    const rut = /route:\s*'([^']*)'/.exec(cuerpo);
    if (!met || !rut) continue;
    met[1].split(',').map(s => s.replace(/['\s]/g, '')).filter(Boolean)
      .forEach(mm => out.push({ nombre: m[1], metodo: mm, ruta: rut[1] }));
  }
  return out;
}

(async () => {
  const src = fs.readFileSync(API, 'utf8');

  /* ════════ PARTE 1 · EL CANDADO ════════════════════════════════════════ */
  const txtRol   = (src.match(/^const ROL_IMPRESION = .*$/m) || [null])[0];
  const txtEs    = (src.match(/^const esImpresion = .*$/m) || [null])[0];
  const txtLista = trozo(src, 'const IMPRESION_PERMITIDO = new Set([', ']);');
  const txtCand  = trozo(src, 'function candadoImpresion(cfg) {', '\n/* ============================================================\n   Bitacora');
  const eps = endpoints(src);

  chk('el index.js define ROL_IMPRESION', !!txtRol, txtRol || 'no está');
  chk('el index.js define esImpresion', !!txtEs, txtEs || 'no está');
  chk('el index.js define la lista blanca IMPRESION_PERMITIDO', !!txtLista, txtLista ? '' : 'no está');
  chk('el index.js define candadoImpresion()', !!txtCand, txtCand ? '' : 'no está');
  chk('se encontraron los endpoints en el index.js', eps.length > 40, eps.length + ' métodos registrados');

  if (txtRol && txtEs && txtLista && txtCand) {
    /* El candado se arma con el TEXTO del index.js. Si mañana alguien cambia
       la lista blanca o el envoltorio, esto prueba lo nuevo, no una copia. */
    let ROL = 'Impresión', tiraGetRole = false, llamado = 0;
    const getUser = () => USUARIO;
    const getRole = async () => { if (tiraGetRole) throw new Error('base caída'); return ROL; };
    const json = (status, body) => ({ status, jsonBody: body });
    let USUARIO = { name: 'Kiosco', email: 'kiosco@x.cr' };
    const arma = new Function('getUser','getRole','json','ROL_IMPRESION_TXT','ES_TXT','LISTA_TXT','CAND_TXT',
      txtRol + '\n' + txtEs + '\n' + txtLista + ']);\n' + txtCand + '\nreturn candadoImpresion;')(
        getUser, getRole, json);
    const envolver = (metodo, ruta) => arma({
      methods: [metodo], route: ruta,
      handler: async () => { llamado++; return json(200, { ok: true }); }
    });
    const pedir = async (metodo, ruta) => {
      llamado = 0;
      const cfg = envolver(metodo, ruta);
      const r = await cfg.handler({ method: metodo, params: {} }, { error(){} });
      return { status: r && r.status, llamado };
    };

    /* La lista blanca, tal cual la declara el index.js. */
    const permitidos = (txtLista.match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, ''));
    chk('la lista blanca tiene exactamente los cinco permisos',
        permitidos.length === 5, permitidos.join(' | '));
    for (const p of ['GET me', 'GET hojas', 'GET hojas/{id}', 'GET productos', 'POST hojas/{id}/impresa'])
      chk('la lista blanca incluye «' + p + '»', permitidos.includes(p), permitidos.join(' | '));
    /* EL ASERTO QUE MÁS VALE: el catálogo de productos tiene que estar. De ahí
       salen la Descripción Nutricare y el Código Sima de cada línea del
       imprimible; sin ese permiso la hoja sale con las descripciones vacías y
       la columna SIMA en blanco, y sin ningún error a la vista. */
    chk('«GET productos» está permitido (sin él el imprimible sale sin descripciones)',
        permitidos.includes('GET productos'), '');

    /* TODOS los endpoints, uno por uno, con el rol Impresión. */
    ROL = 'Impresión';
    let abiertos = [], cerrados = 0, pasaron = [];
    for (const e of eps) {
      const clave = e.metodo + ' ' + e.ruta;
      const r = await pedir(e.metodo, e.ruta);
      if (permitidos.includes(clave)) {
        if (r.status === 200 && r.llamado === 1) pasaron.push(clave);
        else abiertos.push('(permitido y NO pasó) ' + clave + ' -> ' + r.status);
      } else if (r.status === 403 && r.llamado === 0) cerrados++;
      else abiertos.push(clave + ' -> ' + r.status);
    }
    chk('con rol Impresión, TODO lo que no está en la lista responde 403 y no ejecuta el handler',
        abiertos.length === 0, abiertos.length ? abiertos.slice(0, 8).join(' · ') : cerrados + ' endpoints cerrados');
    chk('y los cinco permitidos sí ejecutan su handler', pasaron.length === 5, pasaron.join(' | '));

    /* Los dos endpoints de régimen: NO tienen candado de rol propio -a
       propósito, el botón «+» del régimen lo usan Hospital y Bodega-, así que
       el único que los cierra para el kiosco es este envoltorio. */
    for (const r2 of [['POST','regimenes'], ['PUT','regimenes/{id}']]) {
      const r = await pedir(r2[0], r2[1]);
      chk('el kiosco NO puede ' + r2[0] + ' ' + r2[1] + ' (no tiene candado propio)',
          r.status === 403 && r.llamado === 0, 'status=' + r.status);
    }

    /* Y no rompió a los demás: con los otros tres roles el envoltorio deja
       pasar todo y decide el candado de cada endpoint, como antes. */
    let rotos = [];
    for (const rol of ['Hospital', 'Bodega', 'Administrador']) {
      ROL = rol;
      for (const e of eps) {
        const r = await pedir(e.metodo, e.ruta);
        if (!(r.status === 200 && r.llamado === 1)) rotos.push(rol + ' ' + e.metodo + ' ' + e.ruta);
      }
    }
    chk('los otros tres roles pasan por el envoltorio sin cambio',
        rotos.length === 0, rotos.slice(0, 6).join(' · '));

    /* Sin usuario -el endpoint anónimo de integración- no se consulta el rol y
       el handler corre: si esto se rompe, Power Automate deja de poder
       ingresar cirugías. */
    ROL = 'Impresión'; USUARIO = null;
    const anon = await pedir('POST', 'cirugias/ingest');
    chk('un pedido sin usuario (cirugias/ingest) no toca el candado',
        anon.status === 200 && anon.llamado === 1, 'status=' + anon.status);
    USUARIO = { name: 'Kiosco', email: 'kiosco@x.cr' };

    /* Y si el rol NO se puede leer, no se sigue de largo: 503 y el handler no
       corre. Dejar pasar sería abrirle todo al kiosco justo cuando la base
       falla, que es el momento en que nadie está mirando. */
    tiraGetRole = true;
    const caida = await pedir('DELETE', 'hojas/{id}');
    chk('si getRole falla, el candado responde 503 y NO ejecuta el handler',
        caida.status === 503 && caida.llamado === 0, 'status=' + caida.status);
    tiraGetRole = false;
  }

  /* El rol tiene que estar en ROLES, o «Usuarios y roles» no lo puede asignar. */
  const lnRoles = (src.match(/^const ROLES = .*$/m) || [null])[0];
  chk('ROLES incluye Impresión (si no, no se puede asignar desde Usuarios y roles)',
      !!lnRoles && /Impresión/.test(lnRoles), lnRoles || 'no está');
  /* La cuenta del kiosco se protege por variable de entorno: el correo no
     existe todavía cuando esto se despliega. */
  chk('EMAILS_PROTEGIDOS admite la cuenta del kiosco por KIOSCO_EMAIL',
      /KIOSCO_EMAIL/.test(src), '');
  /* /api/me ya no puede inventar un rol: con la base caída devolvía 'Hospital'
     y el kiosco se dibujaba con el menú de Hospital. */
  const me = trozo(src, "app.http('me'", '\n});');
  const meOk = !!me && !/rol: 'Hospital'/.test(me);
  chk('/api/me ya no devuelve rol Hospital cuando la base falla',
      meOk, meOk ? '' : (me ? 'sigue inventando el rol' : 'no se encontró /api/me'));
  chk('el listado de hojas usa la regla de alcance y no una copia',
      /alcanceImpresion\('h'\)/.test(src), '');

  /* ════════ PARTE 2 · EL ALCANCE, CONTRA LA BASE ════════════════════════ */
  const cli = new Client({ host: SOCK, port: PORT, user: 'postgres', database: 'postgres' });
  await cli.connect();
  await cli.query('DROP SCHEMA IF EXISTS dbo CASCADE');
  await cli.query('DROP SCHEMA IF EXISTS cat CASCADE');
  const migras = fs.readdirSync(MIGS).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  let fallas = [];
  for (const f of migras) {
    try { await cli.query(fs.readFileSync(path.join(MIGS, f), 'utf8')); }
    catch (e) { fallas.push(f + ': ' + e.message.split('\n')[0]); }
  }
  chk('las migraciones corren en orden', fallas.length === 0, fallas.slice(0, 3).join(' · '));
  chk('la 37 dejó el rol Impresión en cat.Rol',
      (await cli.query(`SELECT 1 FROM cat.Rol WHERE Nombre='Impresión'`)).rows.length === 1, '');
  chk('existe dbo.HojaImpresion (migración 38)',
      (await cli.query(`SELECT to_regclass('dbo.HojaImpresion') r`)).rows[0].r !== null, '');
  /* Idempotencia: las dos se re-ejecutan. */
  try {
    await cli.query(fs.readFileSync(path.join(MIGS, '37_RolImpresion.sql'), 'utf8'));
    await cli.query(fs.readFileSync(path.join(MIGS, '38_HojaImpresion.sql'), 'utf8'));
    chk('la 37 y la 38 son idempotentes', true, '');
  } catch (e) { chk('la 37 y la 38 son idempotentes', false, e.message.split('\n')[0]); }

  /* Las hojas de prueba. La clave es la 2: nace ENVIADA y nunca pasa por
     'Pendiente reposición' -eso lo hace el botón Enviar de una hoja nueva-,
     así que con «solo pendientes» el kiosco no la vería y no habría forma de
     imprimirla. */
  const casos = [
    ['P-VIEJA',   'Pendiente reposición', "30 days",  false, true,  'pendiente de hace 30 días'],
    ['E-HOY',     'Enviado',              "0 days",   false, true,  'enviada hoy (nació enviada)'],
    ['E-3DIAS',   'Enviado',              "3 days",   false, true,  'enviada hace 3 días'],
    ['F-2DIAS',   'Finalizada',           "2 days",   false, true,  'finalizada hace 2 días'],
    ['E-BORDE',   'Enviado',              "6 days 23 hours", false, true, 'enviada justo dentro de los 7 días'],
    ['E-FUERA',   'Enviado',              "7 days 1 hour",   false, false,'enviada justo fuera de los 7 días'],
    ['E-10DIAS',  'Enviado',              "10 days",  false, false, 'enviada hace 10 días'],
    ['R-PEND',    'Pendiente reposición', "1 day",    true,  false, 'reemplazo pendiente'],
    ['R-HOY',     'Enviado',              "0 days",   true,  false, 'reemplazo de hoy']
  ];
  const ids = {};
  for (const [n, estado, edad, esRem] of casos) {
    const r = await cli.query(
      `INSERT INTO dbo.HojaConsumo (NumeroHoja, Estado, EsReemplazo, CreadoPor, CreadoPorEmail, FechaCreacion)
       VALUES ($1,$2,$3,'Maria','maria@x.cr', (now() at time zone 'utc') - interval '${edad}')
       RETURNING Id`, [n, estado, esRem]);
    ids[n] = r.rows[0].id;
  }

  const txtAlcance = trozo(src, 'const alcanceImpresion = (a) => {', '\nasync function hojaEnAlcanceImpresion');
  const txtDias = (src.match(/^const IMPRESION_DIAS = \d+;$/m) || [null])[0];
  chk('el index.js define IMPRESION_DIAS', !!txtDias, txtDias || 'no está');
  chk('el index.js define alcanceImpresion()', !!txtAlcance, txtAlcance ? '' : 'no está');
  if (txtAlcance && txtDias) {
    const alcanceImpresion = new Function(txtDias + '\n' + txtAlcance + '\nreturn alcanceImpresion;')();
    const sql = `SELECT h.NumeroHoja AS n FROM dbo.HojaConsumo h WHERE ${alcanceImpresion('h')} ORDER BY 1`;
    const dentro = (await cli.query(sql)).rows.map(r => r.n);
    for (const [n, , , , esperado, texto] of casos)
      chk((esperado ? 'ENTRA' : 'queda fuera') + ': ' + texto,
          dentro.includes(n) === esperado, 'dentro=' + dentro.join(','));

    /* La misma regla, por hoja, que es la que usan el detalle y la marca. */
    const txtUna = trozo(src, 'async function hojaEnAlcanceImpresion(id) {', '\n}');
    if (txtUna) {
      const query = (s2, p) => cli.query(s2, p);
      const una = new Function('query', txtDias + '\n' + txtAlcance + '\n' + txtUna + '\n}\nreturn hojaEnAlcanceImpresion;')(query);
      chk('hojaEnAlcanceImpresion() acepta la pendiente vieja', (await una(ids['P-VIEJA'])) === true, '');
      chk('hojaEnAlcanceImpresion() rechaza la enviada de hace 10 días', (await una(ids['E-10DIAS'])) === false, '');
      chk('hojaEnAlcanceImpresion() rechaza un reemplazo', (await una(ids['R-HOY'])) === false, '');
      chk('hojaEnAlcanceImpresion() rechaza un id que no existe', (await una(999999)) === false, '');
    } else chk('se encontró hojaEnAlcanceImpresion() en el index.js', false, '');

    /* El SELECT del listado, extraído tal cual, con las columnas de la marca. */
    const tplIni = src.indexOf('`SELECT h.Id AS id, h.Consecutivo AS consecutivo');
    const tplFin = src.indexOf('`, params);', tplIni);
    if (tplIni > 0 && tplFin > tplIni) {
      const tpl = src.slice(tplIni, tplFin + 1);
      const where = 'WHERE ' + alcanceImpresion('h');
      const sqlListado = new Function('where', 'return ' + tpl + ';')(where);
      await cli.query(
        `INSERT INTO dbo.HojaImpresion (IdHojaConsumo, ConSima, Usuario, Rol, FechaHora)
         VALUES ($1,false,'Kiosco','Impresión',(now() at time zone 'utc') - interval '20 minutes'),
                ($1,true, 'Kiosco','Impresión',(now() at time zone 'utc') - interval '5 minutes')`,
        [ids['P-VIEJA']]);
      const filas = (await cli.query(sqlListado)).rows;
      const porN = Object.fromEntries(filas.map(f => [f.numero_hoja, f]));
      /* Cinco: las cuatro que entran por fecha más la pendiente vieja. */
      chk('el SELECT real del listado corre contra la base y devuelve solo el alcance',
          filas.length === 5, 'filas=' + filas.length + ' (' + filas.map(f=>f.numero_hoja).join(',') + ')');
      chk('la hoja impresa dos veces reporta impresa_veces = 2',
          porN['P-VIEJA'] && porN['P-VIEJA'].impresa_veces === 2, JSON.stringify(porN['P-VIEJA'] && porN['P-VIEJA'].impresa_veces));
      chk('y trae la fecha de la ÚLTIMA impresión, no la primera',
          porN['P-VIEJA'] && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(porN['P-VIEJA'].impresa_ultima || ''),
          String(porN['P-VIEJA'] && porN['P-VIEJA'].impresa_ultima));
      chk('una hoja sin imprimir reporta veces = 0 y última = null',
          porN['E-HOY'] && porN['E-HOY'].impresa_veces === 0 && porN['E-HOY'].impresa_ultima === null,
          JSON.stringify(porN['E-HOY'] && [porN['E-HOY'].impresa_veces, porN['E-HOY'].impresa_ultima]));

      /* Al borrar la hoja se van sus impresiones: ON DELETE CASCADE. La
         constancia de que existió queda en la bitácora, que no tiene FK. */
      await cli.query('DELETE FROM dbo.HojaConsumo WHERE Id=$1', [ids['P-VIEJA']]);
      const q = (await cli.query('SELECT COUNT(*)::int n FROM dbo.HojaImpresion WHERE IdHojaConsumo=$1', [ids['P-VIEJA']])).rows[0].n;
      chk('borrar la hoja se lleva sus impresiones (CASCADE)', q === 0, 'quedaron ' + q);
    } else chk('se encontró el SELECT del listado en el index.js', false, '');
  }
  await cli.end();

  /* ════════ PARTE 3 · LA PANTALLA ═══════════════════════════════════════ */
  const HOJAS = [
    { id: 41, consecutivo: 447, numero_hoja: 'HDT-0447', fecha: '2026-09-10 08:12', usuario: 'María Calderón',
      estado: 'Pendiente reposición', impresa_veces: 0, impresa_ultima: null, diagnostico: 'FRACTURA DE FEMUR',
      paciente: 'Juan Pérez', regimen: 'RT', cantidad_lineas: 3 },
    { id: 42, consecutivo: 448, numero_hoja: 'HDT-0448', fecha: '2026-09-10 09:40', usuario: 'María Calderón',
      estado: 'Enviado', impresa_veces: 2, impresa_ultima: '2026-09-10 09:55', diagnostico: 'LUXACION',
      paciente: 'Ana Mora', regimen: 'RT', cantidad_lineas: 1 }
  ];
  const HOJA = { id: 41, consecutivo: 447, numero_hoja: 'HDT-0447', estado: 'Pendiente reposición',
    paciente: 'Juan Pérez', identificacion: '1-1111-1111', diagnostico: 'FRACTURA DE FEMUR',
    procedimiento: 'RAFI', regimen: 'RT', cirujano: 'Dr. Solano', instrumentista: 'M. Calderón',
    fecha: '2026-09-10 08:12', usuario: 'María Calderón', imagen_base64: null,
    detalle: [{ id: 1, linea: 1, codigo: '20108004', numero_equipo: 'NUT-10290', descripcion: 'PLACA',
                descripcion_nutricare: 'Placa recta 1/3 caña 4 orificios', und: 1, reposicion_anaquel: 1 }] };

  const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  /* El menú de los cuatro roles. */
  for (const rol of ['Hospital', 'Bodega', 'Administrador', 'Impresión']) {
    const pg = await (await nav.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    pg.on('pageerror', e => chk('sin errores de JS (' + rol + ')', false, e.message));
    await pg.goto('file://' + IDX, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(600);
    const m = await pg.evaluate((rol) => {
      ROL = rol; REAL_ROL = rol; USER = { name: 'X', email: 'x@x.cr' };
      document.getElementById('login').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      buildNav();
      return [...document.querySelectorAll('#navTabs button')].map(b => b.textContent.trim());
    }, rol);
    if (rol === 'Impresión') {
      chk('Impresión ve UNA sola opción de menú', m.length === 1, m.join(' | '));
      chk('y es «Imprimir hojas»', m.length === 1 && /Imprimir hojas/.test(m[0]), m.join(' | '));
      for (const no of ['Inicio', 'Hojas de consumo', 'Código Sima', 'Pendientes de reposición',
                        'Solicitud de Equipo', 'Cirugías', 'Auditoría', 'Bitácora', 'Usuarios'])
        chk('Impresión NO ve «' + no + '»', !m.some(x => x.includes(no)), m.join(' | '));
    } else {
      /* No se les quitó nada a los de siempre: los tres ítems que estaban en
         ver:()=>true siguen ahí. */
      for (const si of ['Inicio', 'Hojas de consumo', 'Código Sima'])
        chk(rol + ' sigue viendo «' + si + '»', m.some(x => x.includes(si)), m.join(' | '));
      chk(rol + ' NO ve «Imprimir hojas»', !m.some(x => x.includes('Imprimir hojas')), m.join(' | '));
    }
    await pg.close();
  }

  /* La pantalla del kiosco, la hoja abierta y la marca. */
  {
    const pg = await (await nav.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
    pg.on('pageerror', e => chk('sin errores de JS (kiosco)', false, e.message));
    await pg.goto('file://' + IDX, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(600);

    /* Contra el código anterior la pantalla del kiosco no existe. Se reporta
       como falla y se sigue, en vez de reventar acá: si reventara, los asertos
       del login que vienen después no se correrían y la comparación con el
       código viejo mostraría menos de lo que falta. */
    const hayPantalla = await pg.evaluate(() =>
      typeof showImprimirHojas === 'function' && typeof inicioPorRol === 'function');
    if (!hayPantalla) {
      chk('el frontend tiene la pantalla del kiosco (showImprimirHojas e inicioPorRol)', false,
          'no existen en este index.html');
      await pg.close();
    } else {

    const r = await pg.evaluate(async ([hojas, hoja]) => {
      const out = { pedidos: [], impresos: [], cargadores: [] };
      window.__O = out;
      api = async (m, url, body) => {
        out.pedidos.push(m + ' ' + url);
        if (m === 'GET' && url === '/me') return { name: 'Kiosco', email: 'k@x.cr', rol: 'Impresión' };
        if (m === 'GET' && url === '/hojas') return hojas;
        if (m === 'GET' && /^\/hojas\/\d+$/.test(url)) return hoja;
        if (m === 'POST' && /impresa$/.test(url)) { out.impresos.push({ url, body }); return { ok: true }; }
        throw new Error('403 en ' + m + ' ' + url);
      };
      /* Se cuentan los catálogos que init() pide: el kiosco solo debe pedir el
         de productos. */
      ['loadLotes','loadEquipos','loadCats','loadEquipoProd','acInit'].forEach(n => {
        window[n] = () => out.cargadores.push(n);
      });
      loadCatalogo = () => { out.cargadores.push('loadCatalogo'); CATALOGO = new Map([['20108004','Placa recta 1/3 caña 4 orificios']]); SIMA = new Map([['20108004','QX2-0103']]); };
      toast = (t) => { out.toast = t; };
      /* imprimirDoc se reemplaza: no se quiere abrir una ventana de verdad,
         pero sí saber que se llamó y con qué. */
      imprimirDoc = (enc, filas, conSima) => { out.doc = { enc, filas, conSima }; };
      await init();
      out.rol = ROL;
      out.pantalla = [...document.querySelectorAll('section')].filter(s => !s.classList.contains('hidden')).map(s => s.id);
      out.cols = [...document.querySelectorAll('#prtHead tr:first-child th')].map(t => t.textContent.trim());
      out.filas = [...document.querySelectorAll('#prtBody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
      out.sub = document.getElementById('prtSub').textContent;
      return out;
    }, [HOJAS, HOJA]);

    chk('el kiosco entra directo a su pantalla, sin pasar por Inicio',
        r.pantalla.includes('viewImprimir') && !r.pantalla.includes('viewInicio'), r.pantalla.join(','));
    chk('init pide el catálogo de productos (lo necesita el imprimible)',
        r.cargadores.includes('loadCatalogo'), r.cargadores.join(','));
    chk('y NO pide los catálogos de las pantallas que no tiene',
        !['loadLotes','loadEquipos','loadCats','loadEquipoProd','acInit'].some(n => r.cargadores.includes(n)),
        r.cargadores.join(','));
    chk('el listado se pide sin parámetros: el alcance lo decide el servidor',
        r.pedidos.includes('GET /hojas') && !r.pedidos.some(p => /\/hojas\?/.test(p)),
        r.pedidos.join(' · '));
    chk('la cola muestra las dos hojas', r.filas.length === 2, 'filas=' + r.filas.length);
    /* Las columnas: las que hacen falta para encontrar la hoja, y ninguna
       clínica. Esta lista queda abierta en una máquina de pasillo. */
    for (const c of ['Consecutivo', 'N°', 'Fecha y hora', 'Creada por', 'Estado', 'Impresa'])
      chk('la cola tiene la columna «' + c + '»', r.cols.includes(c), r.cols.join(' | '));
    for (const c of ['Diagnóstico', 'Paciente', 'Régimen', 'Identificación'])
      chk('la cola NO muestra «' + c + '»', !r.cols.includes(c), r.cols.join(' | '));
    chk('la hoja sin imprimir dice «Sin imprimir»',
        (r.filas[0] || []).some(c => /Sin imprimir/.test(c)), JSON.stringify(r.filas[0]));
    chk('la hoja impresa dos veces muestra la hora y el conteo',
        (r.filas[1] || []).some(c => /09:55/.test(c) && /2 veces/.test(c)), JSON.stringify(r.filas[1]));
    chk('el subtítulo cuenta lo que falta imprimir', /1 hoja sin imprimir/.test(r.sub), r.sub);

    /* Abrir la hoja: la vista de solo lectura, con los dos botones de imprimir
       y sin nada de editar. */
    const v = await pg.evaluate(async () => {
      await verHoja(41);
      const cuerpo = document.getElementById('verBody');
      const botones = [...cuerpo.querySelectorAll('button')].map(b => b.textContent.trim());
      return {
        visible: !document.getElementById('viewVer').classList.contains('hidden'),
        botones,
        haySellada: /Fotos de la hoja sellada/.test(cuerpo.textContent),
        hayPaciente: /Juan Pérez/.test(cuerpo.textContent),
        hayInputs: cuerpo.querySelectorAll('input, textarea, select').length,
        volver: document.querySelector('#viewVer .page-head button').getAttribute('onclick')
      };
    });
    chk('la hoja abre en la vista de solo lectura', v.visible, '');
    chk('con el botón Imprimir', v.botones.some(b => /^🖨️ Imprimir$/.test(b)), v.botones.join(' | '));
    chk('y con el de Imprimir Código Sima', v.botones.some(b => /Código Sima/.test(b)), v.botones.join(' | '));
    chk('sin Guardar ni Crear reemplazo ni Dynamics',
        !v.botones.some(b => /Guardar|reemplazo|Dynamics/i.test(b)), v.botones.join(' | '));
    chk('sin un solo campo editable', v.hayInputs === 0, 'campos=' + v.hayInputs);
    /* La hoja SÍ lleva los datos del paciente: es la hoja que se va a
       imprimir. Lo que se le quitó es la lista, no el documento. */
    chk('la hoja abierta sí muestra el paciente (es lo que se imprime)', v.hayPaciente, '');
    chk('no se le ofrecen las fotos de la hoja sellada', !v.haySellada, '');
    chk('el «Volver» del kiosco no va al listado general', /volverDeVer/.test(v.volver || ''), String(v.volver));

    /* Imprimir: sale el documento Y queda la marca. */
    const i1 = await pg.evaluate(async () => {
      window.__O.impresos = []; window.__O.doc = null;
      imprimirHoja(false);
      await new Promise(r => setTimeout(r, 250));
      return { impresos: window.__O.impresos, doc: window.__O.doc };
    });
    chk('imprimir arma el documento', !!i1.doc && i1.doc.conSima === false, JSON.stringify(!!i1.doc));
    chk('y con las descripciones del catálogo (por eso hace falta GET /productos)',
        !!i1.doc && /Placa recta/.test(((i1.doc.filas || [])[0] || {}).desc || ''),
        JSON.stringify(((i1.doc.filas || [])[0] || {}).desc));
    chk('y con el Código Sima de la línea',
        !!i1.doc && ((i1.doc.filas || [])[0] || {}).sima === 'QX2-0103',
        JSON.stringify(((i1.doc.filas || [])[0] || {}).sima));
    chk('imprimir deja la marca en la API', i1.impresos.length === 1 && /\/hojas\/41\/impresa$/.test(i1.impresos[0].url),
        JSON.stringify(i1.impresos));
    chk('la marca dice que fue la hoja de siempre', i1.impresos.length === 1 && i1.impresos[0].body.sima === false,
        JSON.stringify(i1.impresos[0] && i1.impresos[0].body));

    const i2 = await pg.evaluate(async () => {
      window.__O.impresos = []; window.__O.doc = null;
      imprimirHoja(true);
      await new Promise(r => setTimeout(r, 250));
      return { impresos: window.__O.impresos, doc: window.__O.doc };
    });
    chk('el otro botón marca sima:true', i2.impresos.length === 1 && i2.impresos[0].body.sima === true,
        JSON.stringify(i2.impresos[0] && i2.impresos[0].body));
    chk('y arma el documento con la columna Sima', !!i2.doc && i2.doc.conSima === true, '');

    /* EL ASERTO QUE PROTEGE LA IMPRESIÓN: si la marca falla, la hoja se
       imprime igual. Es la razón de que la llamada vaya sin await. */
    const i3 = await pg.evaluate(async () => {
      window.__O.doc = null;
      const antes = api;
      api = async (m, url) => { if (/impresa$/.test(url)) throw new Error('la base no contesta'); return antes(m, url); };
      imprimirHoja(false);
      await new Promise(r => setTimeout(r, 250));
      api = antes;
      return { doc: window.__O.doc, toast: window.__O.toast };
    });
    chk('si la marca falla, la hoja SE IMPRIME igual', !!i3.doc, 'no se armó el documento');
    await pg.close();
    }
  }

  /* Con la base caída, /api/me devuelve 503: la pantalla tiene que DECIRLO en
     vez de dejar la tarjeta de login muda y que la persona dé vueltas. */
  {
    const pg = await (await nav.newContext({ viewport: { width: 900, height: 800 } })).newPage();
    await pg.goto('file://' + IDX, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(400);
    const t = await pg.evaluate(async () => {
      api = async () => { throw new Error('No se pudo determinar su rol en este momento.'); };
      await init();
      /* Defensivo a propósito: contra el código anterior el <p> no tiene id y
         esto tiene que reportar la falla, no reventar la prueba. */
      const p = document.getElementById('loginMsg');
      return { msg: p ? p.textContent : '(no existe el aviso del login)',
               login: !document.getElementById('login').classList.contains('hidden') };
    });
    chk('si /api/me falla, se vuelve al login', t.login, '');
    chk('y la tarjeta explica por qué', /No se pudo cargar su usuario/.test(t.msg), t.msg);
    await pg.close();
  }

  await nav.close();
  console.log(res.join('\n'));
  const malas = res.filter(x => x.startsWith('  FALLA'));
  console.log('\n' + res.length + ' asertos, ' + malas.length + ' fallas');
  process.exit(malas.length ? 1 : 0);
})().catch(e => { console.log(res.join('\n')); console.log('\nERROR: ' + e.message + '\n' + e.stack); process.exit(1); });
