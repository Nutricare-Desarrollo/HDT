/* Un usuario inactivo no puede hacer NADA — y se puede volver atrás.

   El escenario: alguien que ya no debe usar RIC se inactiva desde «Usuarios y
   roles». Lo que hay que probar no es solo que quede bloqueado, sino que la
   inactivación sea REVERSIBLE y que nadie pueda quedarse afuera de su propia
   aplicación sin manera de volver. Eso último son tres candados y cada uno
   tiene su aserto.

   PARTE 1 — EL BLOQUEO. Se extrae el envoltorio `candadoActivo` del index.js
   real y se le pasan TODOS los endpoints registrados: el inactivo tiene que
   recibir 403 en todos menos en `GET me`. Que /api/me pase es deliberado: sin
   él la pantalla no podría explicar qué ocurrió.

   PARTE 2 — ACTIVAR Y REACTIVAR, contra un PostgreSQL de verdad con las
   migraciones aplicadas. El handler se extrae del index.js, así que se prueba
   el código que se despliega. Cubre los tres candados y —lo que más importa—
   que reactivar devuelva a la persona con SU rol y no con el de por defecto.

   PARTE 3 — LA PANTALLA. Que el inactivo vea el aviso y no la aplicación, que
   el checkbox «ver inactivos» exista (sin él la acción no se puede deshacer
   desde la pantalla), y que el botón no se ofrezca donde el servidor lo va a
   rechazar.

   uso: node probar_usuario_inactivo.js <socket-pg> <puerto> [index.js] [index.html] [dir-migraciones]
*/
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { chromium } = require('playwright');

const SOCK = process.argv[2] || '/tmp/pgtest/run';
const PORT = Number(process.argv[3] || 5433);
const API  = path.resolve(process.argv[4] || '/mnt/user-data/uploads/HDT/api/src/index.js');
const IDX  = path.resolve(process.argv[5] || '/mnt/user-data/uploads/HDT/frontend/index.html');
const MIGS = path.resolve(process.argv[6] || '/mnt/user-data/uploads/HDT/database');

const res = []; const chk = (n, ok, x) => res.push((ok?'  OK  ':'  FALLA ')+n+(x?' — '+x:''));

function trozo(src, desde, hasta) {
  const i = src.indexOf(desde); if (i < 0) return null;
  const j = src.indexOf(hasta, i); if (j < 0) return null;
  return src.slice(i, j);
}
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
    met[1].split(',').map(x => x.replace(/['\s]/g, '')).filter(Boolean)
      .forEach(mm => out.push({ metodo: mm, ruta: rut[1] }));
  }
  return out;
}
/* El cuerpo de un app.http, para correr el handler de verdad. */
function cuerpoHandler(src, nombre) {
  const i = src.indexOf(`app.http('` + nombre + `'`);
  if (i < 0) return null;
  const ini = src.indexOf('handler: async (request, context) => {', i);
  const fin = src.indexOf('\n});', ini);
  if (ini < 0 || fin < 0) return null;
  return src.slice(ini + 'handler: async (request, context) => {'.length, fin).replace(/\s*\}\s*$/, '');
}

(async () => {
  const src = fs.readFileSync(API, 'utf8');

  /* ════════ PARTE 1 · EL BLOQUEO ════════════════════════════════════════ */
  const txtLista = trozo(src, "const ACTIVO_PERMITIDO = new Set([", ']);');
  const txtCand  = trozo(src, 'function candadoActivo(cfg) {',
                          '\n/* ============================================================\n   Bitacora');
  const eps = endpoints(src);
  chk('el index.js define ACTIVO_PERMITIDO', !!txtLista, txtLista ? '' : 'no está');
  chk('el index.js define candadoActivo()', !!txtCand, txtCand ? '' : 'no está');
  chk('se encontraron los endpoints', eps.length > 40, eps.length + ' métodos registrados');

  /* El orden de los envoltorios: `candadoActivo` tiene que envolver al de
     Impresión y no al revés. Si se invirtiera, un inactivo con rol Impresión
     recibiría el 403 del rol -«solo puede imprimir»- en vez del de estar
     inactivo, y el mensaje mandaría a la persona a resolver lo que no es. */
  chk('candadoActivo envuelve al candado de Impresión, no al revés',
      /candadoActivo\(candadoImpresion\(cfg\)\)/.test(src),
      (src.match(/bitacora\.envolver\([^)]*\)/) || [''])[0].slice(0, 70));

  if (txtLista && txtCand) {
    let ACTIVO = false, tira = false, llamado = 0;
    let USUARIO = { name: 'Sofía', email: 'sofia@x.cr' };
    const getUser = () => USUARIO;
    const estadoUsuario = async () => {
      if (tira) throw new Error('no existe la columna Activo');
      return { rol: 'Hospital', activo: ACTIVO };
    };
    const json = (status, body) => ({ status, jsonBody: body });
    const arma = new Function('getUser', 'estadoUsuario', 'json',
      txtLista + ']);\n' + txtCand + '\nreturn candadoActivo;')(getUser, estadoUsuario, json);
    const pedir = async (metodo, ruta) => {
      llamado = 0;
      const cfg = arma({ methods: [metodo], route: ruta,
        handler: async () => { llamado++; return json(200, { ok: true }); } });
      const r = await cfg.handler({ method: metodo, route: ruta, params: {} }, { error(){} });
      return { status: r && r.status, cuerpo: r && r.jsonBody, llamado };
    };

    const permitidos = (txtLista.match(/'([^']+)'/g) || []).map(x => x.replace(/'/g, ''));
    chk('la lista de lo permitido al inactivo tiene UN solo permiso',
        permitidos.length === 1, permitidos.join(' | '));
    chk('y es «GET me» (sin él la pantalla no podría explicar nada)',
        permitidos[0] === 'GET me', permitidos.join(' | '));

    /* INACTIVO: 403 en todo, menos /api/me. */
    ACTIVO = false;
    let abiertos = [];
    for (const e of eps) {
      const clave = e.metodo + ' ' + e.ruta;
      const r = await pedir(e.metodo, e.ruta);
      if (permitidos.includes(clave)) { if (!(r.status === 200 && r.llamado === 1)) abiertos.push('(permitido y no pasó) ' + clave); }
      else if (!(r.status === 403 && r.llamado === 0)) abiertos.push(clave + ' -> ' + r.status);
    }
    chk('un usuario INACTIVO recibe 403 en todos los endpoints salvo GET me',
        abiertos.length === 0, abiertos.slice(0, 8).join(' · ') || (eps.length - 1) + ' cerrados');

    /* El 403 tiene que venir marcado, para que la pantalla distinga «te
       inactivaron» de un 403 de permisos. */
    const unoCualquiera = await pedir('GET', 'hojas');
    chk('el 403 del inactivo viene marcado con inactivo:true',
        unoCualquiera.cuerpo && unoCualquiera.cuerpo.inactivo === true,
        JSON.stringify(unoCualquiera.cuerpo));

    /* ACTIVO: no estorba a nadie. Es el aserto que protege a los 11 usuarios
       que hay hoy: si este candado se pasara de listo, los bloquearía a todos. */
    ACTIVO = true;
    let rotos = [];
    for (const e of eps) {
      const r = await pedir(e.metodo, e.ruta);
      if (!(r.status === 200 && r.llamado === 1)) rotos.push(e.metodo + ' ' + e.ruta + ' -> ' + r.status);
    }
    chk('un usuario ACTIVO pasa por el candado sin cambio alguno',
        rotos.length === 0, rotos.slice(0, 6).join(' · '));

    /* Sin usuario -la integración anónima- no se consulta nada. */
    USUARIO = null; ACTIVO = false;
    const anon = await pedir('POST', 'cirugias/ingest');
    chk('un pedido sin usuario no toca este candado',
        anon.status === 200 && anon.llamado === 1, 'status=' + anon.status);
    USUARIO = { name: 'Sofía', email: 'sofia@x.cr' };

    /* Si no se puede saber si está activo -por ejemplo, la migración 39 sin
       aplicar-, NO se sigue de largo. */
    tira = true;
    const caida = await pedir('GET', 'hojas');
    chk('si no se puede leer el estado, responde 503 y no ejecuta el handler',
        caida.status === 503 && caida.llamado === 0, 'status=' + caida.status);
    tira = false;
  }

  /* El ON CONFLICT de ensureUserRole NO debe tocar Activo: si lo tocara, un
     inactivo se reactivaría solo con volver a abrir la aplicación. */
  const txtEnsure = trozo(src, 'async function ensureUserRole(user) {', '\n}');
  chk('ensureUserRole NO reactiva al usuario en su ON CONFLICT',
      !!txtEnsure && /ON CONFLICT/.test(txtEnsure) && !/Activo/i.test(txtEnsure.split('ON CONFLICT')[1] || ''),
      txtEnsure ? '' : 'no se encontró ensureUserRole');
  chk('/api/me devuelve el campo activo', /activo: est\.activo/.test(src), '');

  /* ════════ PARTE 2 · ACTIVAR Y REACTIVAR, CONTRA LA BASE ═══════════════ */
  const cli = new Client({ host: SOCK, port: PORT, user: 'postgres', database: 'postgres' });
  await cli.connect();
  await cli.query('DROP SCHEMA IF EXISTS dbo CASCADE');
  await cli.query('DROP SCHEMA IF EXISTS cat CASCADE');
  let fallas = [];
  for (const f of fs.readdirSync(MIGS).filter(x => /^\d+_.*\.sql$/.test(x)).sort()) {
    try { await cli.query(fs.readFileSync(path.join(MIGS, f), 'utf8')); }
    catch (e) { fallas.push(f + ': ' + e.message.split('\n')[0]); }
  }
  chk('las migraciones corren en orden', fallas.length === 0, fallas.slice(0, 3).join(' · '));

  const col = await cli.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema='dbo' AND table_name='usuariorol' AND column_name='activo'`);
  chk('la 39 agregó dbo.UsuarioRol.Activo', col.rows.length === 1, JSON.stringify(col.rows[0] || {}));
  chk('y arranca en TRUE (si arrancara en FALSE, bloquearía a la empresa entera)',
      col.rows.length === 1 && /true/i.test(col.rows[0].column_default || ''),
      String((col.rows[0] || {}).column_default));
  chk('y es NOT NULL', col.rows.length === 1 && col.rows[0].is_nullable === 'NO',
      String((col.rows[0] || {}).is_nullable));
  try {
    await cli.query(fs.readFileSync(path.join(MIGS, '39_UsuarioActivo.sql'), 'utf8'));
    chk('la 39 es idempotente', true, '');
  } catch (e) { chk('la 39 es idempotente', false, e.message.split('\n')[0]); }

  /* Los usuarios que ya existían tienen que haber quedado ACTIVOS: es lo que
     hace que aplicar la migración no le cambie nada a nadie. */
  const rolId = async (n) => (await cli.query(`SELECT Id FROM cat.Rol WHERE Nombre=$1`, [n])).rows[0].id;
  const idAdmin = await rolId('Administrador'), idHosp = await rolId('Hospital');
  /* Defensivo a propósito: contra el código anterior la columna no existe y
     esto tiene que reportar la falla y seguir, no reventar la prueba y dejar
     sin correr los asertos de la pantalla. */
  try {
    chk('los usuarios que ya existían quedaron activos',
        (await cli.query(`SELECT COUNT(*)::int n FROM dbo.UsuarioRol WHERE NOT Activo`)).rows[0].n === 0, '');
  } catch (e) { chk('los usuarios que ya existían quedaron activos', false, e.message.split('\n')[0]); }

  for (const [em, rid] of [['luis@x.cr', idAdmin], ['otro.admin@x.cr', idAdmin],
                           ['bodega@x.cr', await rolId('Bodega')], ['sofia@x.cr', idHosp]])
    await cli.query(`INSERT INTO dbo.UsuarioRol (Email, Nombre, RolId) VALUES ($1,$2,$3)
                     ON CONFLICT (Email) DO UPDATE SET RolId=EXCLUDED.RolId`, [em, em, rid]);

  const cuerpo = cuerpoHandler(src, 'usuario-set-activo');
  chk('el index.js tiene el endpoint usuario-set-activo', !!cuerpo, cuerpo ? '' : 'no está');
  if (cuerpo) {
    let ult = null, QUIEN = 'luis@x.cr', ROL = 'Administrador';
    const json = (st, b) => { ult = { status: st, body: b }; return ult; };
    const query = (s2, p) => cli.query(s2, p);
    const getUser = () => ({ name: QUIEN, email: QUIEN });
    const getRole = async () => ROL;
    /* esProtegido se EXTRAE del index.js: reescribirlo acá haría pasar la
       prueba contra un código que hubiera perdido la protección. */
    const lnProt = trozo(src, 'const esProtegido =', '\n');
    const esProtegido = new Function(
      "const EMAILS_PROTEGIDOS = new Set(['desarrollo@nutricare.co.cr']);\n" + lnProt + '\nreturn esProtegido;')();
    const h = new Function('getUser', 'getRole', 'query', 'json', 'esProtegido',
      'return async (request, context) => {' + cuerpo + '};')(getUser, getRole, query, json, esProtegido);
    const req = (email, body) => ({ params: { email: encodeURIComponent(email) }, json: async () => body });
    const ctx = { error(){}, log(){} };
    const activoDe = async (em) =>
      (await cli.query(`SELECT Activo FROM dbo.UsuarioRol WHERE Email=$1`, [em])).rows[0].activo;

    /* 1. Inactivar, y que quede inactivo de verdad. */
    await h(req('sofia@x.cr', { activo: false }), ctx);
    chk('inactivar responde 200', ult.status === 200, JSON.stringify(ult));
    chk('y la fila queda inactiva', (await activoDe('sofia@x.cr')) === false, '');

    /* 2. REACTIVAR — la pregunta de Luis. Con SU rol, no con el de por defecto. */
    await h(req('sofia@x.cr', { activo: true }), ctx);
    const sofia = (await cli.query(
      `SELECT u.Activo AS activo, r.Nombre AS rol FROM dbo.UsuarioRol u JOIN cat.Rol r ON r.Id=u.RolId
        WHERE u.Email='sofia@x.cr'`)).rows[0];
    chk('reactivar la devuelve a activa', sofia.activo === true, JSON.stringify(sofia));
    chk('y conserva su rol', sofia.rol === 'Hospital', String(sofia.rol));
    /* Un rol que no es el de por defecto: si reactivar «recreara» al usuario,
       Bodega volvería como Hospital y nadie se daría cuenta hasta que faltara
       una pantalla. */
    await h(req('bodega@x.cr', { activo: false }), ctx);
    await h(req('bodega@x.cr', { activo: true }), ctx);
    const bod = (await cli.query(
      `SELECT r.Nombre AS rol FROM dbo.UsuarioRol u JOIN cat.Rol r ON r.Id=u.RolId
        WHERE u.Email='bodega@x.cr'`)).rows[0];
    chk('un Bodega reactivado vuelve como Bodega, no como Hospital', bod.rol === 'Bodega', String(bod.rol));

    /* 3. CANDADO 1: el correo protegido. */
    await h(req('desarrollo@nutricare.co.cr', { activo: false }), ctx);
    chk('CANDADO: un correo protegido no se puede inactivar', ult.status === 403, JSON.stringify(ult.status));

    /* 4. CANDADO 2: uno mismo. */
    await h(req('luis@x.cr', { activo: false }), ctx);
    chk('CANDADO: nadie se puede inactivar a sí mismo', ult.status === 400, JSON.stringify(ult.body));
    chk('y sigue activo', (await activoDe('luis@x.cr')) === true, '');

    /* 5. CANDADO 3: el último Administrador activo.

       PRIMERO HAY QUE AISLAR EL ESCENARIO, y esto lo descubrió la prueba
       fallando: la migración 02 siembra DOS administradores de verdad
       -desarrollo@nutricare.co.cr y lgomez@nutricare.co.cr-, así que en una
       base recién migrada nunca hay «un último admin». Se inactivan los demás
       para que queden solo los dos de este escenario.

       De paso queda dicho algo útil: en producción hay al menos esos dos
       administradores activos, así que este candado no va a estorbar en el uso
       normal. Está para el día en que quede uno. */
    await cli.query(
      `UPDATE dbo.UsuarioRol SET Activo=FALSE WHERE Email NOT IN ('luis@x.cr','otro.admin@x.cr')`);
    const adminsActivos = async () => (await cli.query(
      `SELECT COUNT(*)::int n FROM dbo.UsuarioRol u JOIN cat.Rol r ON r.Id=u.RolId
        WHERE r.Nombre='Administrador' AND u.Activo`)).rows[0].n;
    chk('el escenario arranca con exactamente dos administradores activos',
        (await adminsActivos()) === 2, 'admins activos=' + (await adminsActivos()));

    QUIEN = 'otro.admin@x.cr';
    await h(req('luis@x.cr', { activo: false }), ctx);
    chk('con DOS administradores, se puede inactivar a uno', ult.status === 200, JSON.stringify(ult));
    chk('y queda uno solo', (await adminsActivos()) === 1, 'admins activos=' + (await adminsActivos()));

    /* Ahora otro.admin es el único activo, y se intenta inactivarlo. Lo pide
       luis -inactivo, pero getRole está simulado-: lo que se prueba acá es el
       CONTEO, no quién pide. Que uno no se inactive a sí mismo ya se probó. */
    QUIEN = 'luis@x.cr';
    await h(req('otro.admin@x.cr', { activo: false }), ctx);
    chk('CANDADO: no se puede inactivar al ÚLTIMO Administrador activo',
        ult.status === 400 && /Administrador/.test((ult.body || {}).error || ''), JSON.stringify(ult.body));
    chk('y el último Administrador sigue activo', (await activoDe('otro.admin@x.cr')) === true, '');
    /* Se devuelve todo a como estaba para los asertos que siguen. */
    await cli.query(`UPDATE dbo.UsuarioRol SET Activo=TRUE`);

    /* 6. Un usuario que no existe. */
    await h(req('nadie@x.cr', { activo: false }), ctx);
    chk('un usuario que no existe da 404', ult.status === 404, JSON.stringify(ult.status));

    /* 7. Solo Administrador. */
    ROL = 'Bodega';
    await h(req('sofia@x.cr', { activo: false }), ctx);
    chk('un rol que no es Administrador no puede inactivar a nadie', ult.status === 403, JSON.stringify(ult.status));
    chk('y no le tocó el dato', (await activoDe('sofia@x.cr')) === true, '');
    ROL = 'Administrador';

    /* 8. La respuesta trae lo que la bitácora necesita para su fila. */
    QUIEN = 'luis@x.cr';
    await h(req('sofia@x.cr', { activo: false }), ctx);
    chk('la respuesta trae email y estado, que es lo que lee la bitácora',
        ult.body && ult.body.email === 'sofia@x.cr' && ult.body.estado === 'Inactivo',
        JSON.stringify(ult.body));
  }
  await cli.end();

  /* ════════ PARTE 3 · LA PANTALLA ═══════════════════════════════════════ */
  const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  {
    const pg = await (await nav.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
    pg.on('pageerror', e => chk('sin errores de JS', false, e.message));
    await pg.goto('file://' + IDX, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(500);

    /* El inactivo ve el aviso, no la aplicación, y no se piden catálogos. */
    const bloq = await pg.evaluate(async () => {
      const pedidos = [];
      api = async (m, url) => {
        pedidos.push(m + ' ' + url);
        if (url === '/me') return { name: 'Sofía', email: 'sofia@x.cr', rol: 'Hospital', activo: false };
        throw new Error('403 Su acceso a RIC está inactivo.');
      };
      await init();
      const b = document.getElementById('bloqueado');
      return {
        pedidos,
        avisoVisible: !!b && !b.classList.contains('hidden'),
        appVisible: !document.getElementById('app').classList.contains('hidden'),
        loginVisible: !document.getElementById('login').classList.contains('hidden'),
        texto: b ? b.innerText.replace(/\s+/g, ' ').trim() : '(no existe la pantalla)'
      };
    });
    chk('un usuario inactivo ve la pantalla de aviso', bloq.avisoVisible, bloq.texto.slice(0, 60));
    chk('y NO ve la aplicación', bloq.appVisible === false, '');
    chk('ni la tarjeta de login, que lo dejaría dando vueltas', bloq.loginVisible === false, '');
    chk('el aviso dice de qué cuenta se trata', /sofia@x\.cr/.test(bloq.texto), bloq.texto.slice(0, 80));
    chk('el aviso lo manda con el administrador', /administrador/i.test(bloq.texto), '');
    chk('y no se pide ningún catálogo: solo /me',
        bloq.pedidos.length === 1 && bloq.pedidos[0] === 'GET /me', bloq.pedidos.join(' · '));

    /* Una API que todavía no manda `activo` -la ventana entre los dos
       deploys- NO debe bloquear a nadie. */
    const viejo = await pg.evaluate(async () => {
      api = async (m, url) => {
        if (url === '/me') return { name: 'Sofía', email: 'sofia@x.cr', rol: 'Hospital' };  // sin `activo`
        return [];
      };
      /* Defensivo: contra el código anterior el <div> no existe. */
      const b = document.getElementById('bloqueado');
      if (b) b.classList.add('hidden');
      await init();
      return { appVisible: !document.getElementById('app').classList.contains('hidden'),
               avisoVisible: !!b && !b.classList.contains('hidden') };
    });
    chk('una API sin el campo `activo` NO bloquea a nadie',
        viejo.appVisible === true && viejo.avisoVisible === false, JSON.stringify(viejo));
    await pg.close();
  }

  /* La pantalla de Usuarios: el checkbox, la columna y los botones. */
  {
    const USUARIOS = [
      { email: 'luis@x.cr', nombre: 'Luis', rol: 'Administrador', activo: true, ultimo_acceso: '2026-09-10 08:00', protegido: false },
      { email: 'desarrollo@nutricare.co.cr', nombre: 'Desarrollo', rol: 'Administrador', activo: true, ultimo_acceso: '2026-09-01 10:00', protegido: true },
      { email: 'sofia@x.cr', nombre: 'Sofía', rol: 'Hospital', activo: true, ultimo_acceso: '2026-09-09 11:00', protegido: false },
      { email: 'vieja@x.cr', nombre: 'Cuenta vieja', rol: 'Hospital', activo: false, ultimo_acceso: '2026-05-02 09:00', protegido: false }
    ];
    const pg = await (await nav.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    pg.on('pageerror', e => chk('sin errores de JS (usuarios)', false, e.message));
    await pg.goto('file://' + IDX, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(500);

    const u = await pg.evaluate(async (usuarios) => {
      const out = { puts: [] };
      window.__O = out;   // para leer los PUT desde el evaluate siguiente
      api = async (m, url, body) => {
        if (m === 'GET' && url === '/usuarios') return JSON.parse(JSON.stringify(usuarios));
        if (m === 'PUT' && /\/activo$/.test(url)) { out.puts.push({ url, body }); return { ok: true }; }
        return [];
      };
      toast = () => {}; showLoading = () => {}; hideLoading = () => {};
      ROL = 'Administrador'; REAL_ROL = 'Administrador';
      USER = { name: 'Luis', email: 'luis@x.cr' };
      document.getElementById('login').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      await showUsuarios();
      const fila = (em) => [...document.querySelectorAll('#usrBody tr')]
        .find(tr => tr.innerText.includes(em));
      const leer = (em) => { const f = fila(em); return f ? f.innerText.replace(/\s+/g, ' ').trim() : null; };
      out.hayCheckbox = !!document.getElementById('usrVerInactivos');
      if (!out.hayCheckbox) return out;   // codigo anterior: no hay nada mas que medir
      out.cols = [...document.querySelectorAll('#usrHead tr:first-child th')].map(t => t.textContent.trim());
      out.visiblesSinVer = [...document.querySelectorAll('#usrBody tr')].length;
      out.pie = document.getElementById('usrFoot').textContent;
      out.sofia = leer('sofia@x.cr');
      out.protegida = leer('desarrollo@nutricare.co.cr');
      out.yo = leer('luis@x.cr');
      /* Con el checkbox marcado aparece la inactiva y su botón de reactivar. */
      document.getElementById('usrVerInactivos').checked = true;
      renderUsuarios();
      out.visiblesConVer = [...document.querySelectorAll('#usrBody tr')].length;
      out.vieja = leer('vieja@x.cr');
      out.botonReactivar = !!(fila('vieja@x.cr') && /Reactivar/.test(fila('vieja@x.cr').innerText));
      return out;
    }, USUARIOS);

    chk('la pantalla tiene el checkbox «ver inactivos»', u.hayCheckbox, '');
    if (!u.hayCheckbox) {
      /* Contra el código anterior la pantalla no tiene nada de esto. Se
         reportan los asertos como fallas y se sigue, en vez de reventar. */
      for (const n2 of ['con el checkbox apagado, la cuenta inactiva no se lista',
                        'y al marcarlo aparece', 'con su botón de Reactivar',
                        'hay columna Estado', 'la fila inactiva dice Inactivo',
                        'una activa ofrece Inactivar', 'el pie cuenta los inactivos',
                        'al usuario protegido no se le ofrece el botón', 'y a uno mismo tampoco',
                        'inactivar pide confirmación', 'al confirmar manda el PUT'])
        chk(n2, false, 'la pantalla no tiene el estado de usuario');
      await pg.close(); await nav.close();
      console.log(res.join('\n'));
      const m2 = res.filter(x => x.startsWith('  FALLA'));
      console.log('\n' + res.length + ' asertos, ' + m2.length + ' fallas');
      process.exit(m2.length ? 1 : 0);
    }
    chk('con el checkbox apagado, la cuenta inactiva no se lista',
        u.visiblesSinVer === 3, 'filas=' + u.visiblesSinVer);
    chk('y al marcarlo aparece', u.visiblesConVer === 4, 'filas=' + u.visiblesConVer);
    chk('con su botón de Reactivar: la acción se puede deshacer desde la pantalla',
        u.botonReactivar, u.vieja || '(no está la fila)');
    chk('hay columna Estado', u.cols.includes('Estado'), u.cols.join(' | '));
    chk('la fila inactiva dice Inactivo', /Inactivo/.test(u.vieja || ''), u.vieja);
    chk('una activa ofrece Inactivar', /Inactivar/.test(u.sofia || ''), u.sofia);
    chk('el pie cuenta los inactivos', /1 inactivo/.test(u.pie || ''), u.pie);
    /* Los dos candados que se esconden en la pantalla. */
    chk('al usuario protegido no se le ofrece el botón',
        !/Inactivar|Reactivar/.test(u.protegida || ''), u.protegida);
    chk('y a uno mismo tampoco', !/Inactivar|Reactivar/.test(u.yo || ''), u.yo);

    /* El PUT que manda el botón. */
    const put = await pg.evaluate(async () => {
      window.__O.puts = [];
      const fila = [...document.querySelectorAll('#usrBody tr')].find(tr => tr.innerText.includes('sofia@x.cr'));
      fila.querySelector('button').click();
      /* Inactivar pide confirmación: se comprueba que la pida y se acepta. */
      const pedirConfirm = !document.getElementById('confirmModal').classList.contains('hidden');
      const antesDeConfirmar = window.__O.puts.length;
      const btn = document.getElementById('confirmOkBtn');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 250));
      return { pedirConfirm, antesDeConfirmar, puts: window.__O.puts };
    });
    chk('inactivar pide confirmación antes de cortarle el acceso a alguien',
        put.pedirConfirm === true, JSON.stringify(put.pedirConfirm));
    chk('y NO manda nada hasta que se confirma',
        put.antesDeConfirmar === 0, 'PUT antes de confirmar: ' + put.antesDeConfirmar);
    chk('al confirmar manda el PUT al endpoint y al usuario correctos',
        put.puts.length === 1 && /\/usuarios\/sofia%40x\.cr\/activo$/.test(put.puts[0].url),
        JSON.stringify(put.puts));
    chk('con activo:false en el cuerpo',
        put.puts.length === 1 && put.puts[0].body && put.puts[0].body.activo === false,
        JSON.stringify(put.puts[0] && put.puts[0].body));
    await pg.close();
  }

  await nav.close();
  console.log(res.join('\n'));
  const malas = res.filter(x => x.startsWith('  FALLA'));
  console.log('\n' + res.length + ' asertos, ' + malas.length + ' fallas');
  process.exit(malas.length ? 1 : 0);
})().catch(e => { console.log(res.join('\n')); console.log('\nERROR: ' + e.message + '\n' + e.stack); process.exit(1); });
