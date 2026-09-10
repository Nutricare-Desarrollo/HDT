/* Códigos Sima del catálogo: la API contra una base REAL, y la pantalla.

   La parte de API no usa datos de mentira para la lógica: extrae el TEXTO de
   los tres manejadores del api/src/index.js y lo corre contra un PostgreSQL
   local con la migración 36 aplicada. Se prueba el código que se despliega, y
   las consultas se ejecutan contra columnas que existen.

   Lo que más importa acá:
     · NO se pueden agregar productos: el PUT rechaza un código que el catálogo
       no tiene, y la importación lo descarta.
     · El vacío BORRA al editar pero NO TOCA al importar. Son dos semánticas
       distintas a propósito y es lo más fácil de romper sin darse cuenta.
     · El precio con COMA decimal (62,5344444444444) no se puede leer como 62.
     · LOS TRES ROLES editan e importan. Hospital incluido: es la unica
       pantalla que no reparte por rol. Y un rol de FUERA de los tres sigue
       recibiendo 403, para que abrirla no se haya vuelto «cualquiera».

   uso: node probar_sima.js <socket-pg> <puerto> [index.js] [index.html]
*/
const fs = require('fs');
const { Client } = require('pg');
const { chromium } = require('playwright');

const SOCK = process.argv[2] || '/home/ubuntu/pgtest/run';
const PORT = Number(process.argv[3] || 5433);
const API  = process.argv[4] || '/mnt/user-data/uploads/HDT/api/src/index.js';
const IDX  = process.argv[5] || '/mnt/user-data/uploads/HDT/frontend/index.html';

const res = []; const chk = (n, ok, x) => res.push((ok?'  OK  ':'  FALLA ')+n+(x?' — '+x:''));

/* El catálogo externo, simulado: tres productos. El cuarto código NO está, y
   es el que tiene que rechazarse. */
const CATALOGO = [
  { codigo:'20108004', descripcion:'Placa recta 1/3 caña 4 orificios' },
  { codigo:'20108005', descripcion:'Placa recta 1/3 caña 5 orificios' },
  { codigo:'24268008', descripcion:'Placa recta bajo contacto 8 orificios' }
];

/* Saca del index.js las dos funciones sueltas y el cuerpo de un app.http. */
function trozo(src, desde, hasta) {
  const i = src.indexOf(desde); if (i < 0) return null;
  const j = src.indexOf(hasta, i); if (j < 0) return null;
  return src.slice(i, j);
}

(async () => {
  const src = fs.readFileSync(API, 'utf8');

  /* ── Las dos funciones puras: simaTexto y simaPrecio ─────────────────── */
  const fnTexto = trozo(src, 'function simaTexto(', '\n/* El precio.');
  const fnPrecio = trozo(src, 'function simaPrecio(', "\n/* GET /api/productos/sima");
  if (!fnTexto || !fnPrecio) {
    chk('se encontraron simaTexto() y simaPrecio() en el index.js', false, API);
  } else {
    const F = new Function(fnTexto + '\n' + fnPrecio + '\nreturn { simaTexto, simaPrecio };')();

    /* EL CASO QUE MOTIVA ESTO: en los datos de origen hay un precio con coma. */
    chk('precio con PUNTO', F.simaPrecio('234.468571428571').valor === 234.468571428571,
        String(F.simaPrecio('234.468571428571').valor));
    const coma = F.simaPrecio('62,5344444444444');
    chk('precio con COMA decimal no se lee como 62',
        coma.ok === true && Math.abs(coma.valor - 62.5344444444444) < 1e-9, JSON.stringify(coma));
    chk('miles con punto y decimal con coma: 1.234,56', F.simaPrecio('1.234,56').valor === 1234.56,
        String(F.simaPrecio('1.234,56').valor));
    chk('miles con coma y decimal con punto: 1,234.56', F.simaPrecio('1,234.56').valor === 1234.56,
        String(F.simaPrecio('1,234.56').valor));
    chk('con símbolo de moneda', F.simaPrecio('₡234.47').valor === 234.47, String(F.simaPrecio('₡234.47').valor));
    chk('vacío es válido y da null', F.simaPrecio('').ok === true && F.simaPrecio('').valor === null, '');
    chk('texto NO es un precio y se avisa', F.simaPrecio('abc').ok === false, JSON.stringify(F.simaPrecio('abc')));
    chk('negativo se rechaza', F.simaPrecio('-5').ok === false, JSON.stringify(F.simaPrecio('-5')));
    /* Recorta en vez de rechazar: una descripción dos caracteres más larga no
       vale perder la fila. */
    chk('el texto se recorta al máximo', F.simaTexto('x'.repeat(700), 600).length === 600,
        String(F.simaTexto('x'.repeat(700), 600).length));
    chk('el texto vacío da null', F.simaTexto('   ', 60) === null, String(F.simaTexto('   ', 60)));
  }

  /* ── La base, con la migración 36 ─────────────────────────────────────── */
  const cli = new Client({ host: SOCK, port: PORT, user: 'postgres', database: 'postgres' });
  await cli.connect();
  await cli.query('DROP SCHEMA IF EXISTS cat CASCADE');
  await cli.query(fs.readFileSync(
    (process.argv[6] || '/mnt/user-data/uploads/HDT/database/36_ProductoSima.sql'), 'utf8'));
  chk('la migración 36 corre', true, '');
  /* Idempotente: se corre dos veces. */
  await cli.query(fs.readFileSync(
    (process.argv[6] || '/mnt/user-data/uploads/HDT/database/36_ProductoSima.sql'), 'utf8'));
  chk('la migración 36 es idempotente', true, '');

  const cols = await cli.query(
    `SELECT column_name, data_type, numeric_precision, numeric_scale, character_maximum_length
       FROM information_schema.columns WHERE table_schema='cat' AND table_name='productosima'
      ORDER BY ordinal_position`);
  const porNom = Object.fromEntries(cols.rows.map(c => [c.column_name, c]));
  for (const c of ['productocodigo','codigosima','descripcionsima','lineasima','partidasima','renglonsima','preciosima'])
    chk('existe la columna ' + c, !!porNom[c], '');
  chk('el precio guarda SEIS decimales, no dos',
      porNom.preciosima && Number(porNom.preciosima.numeric_scale) === 6,
      'scale=' + (porNom.preciosima || {}).numeric_scale);
  chk('la descripción Sima aguanta las de origen (262 caracteres)',
      porNom.descripcionsima && Number(porNom.descripcionsima.character_maximum_length) >= 262,
      'largo=' + (porNom.descripcionsima || {}).character_maximum_length);

  /* ── Los manejadores, con la base y el catálogo simulados ─────────────── */
  const cuerpo = (nombre) => {
    const i = src.indexOf(`app.http('` + nombre + `'`);
    if (i < 0) return null;
    const ini = src.indexOf('handler: async (request, context) => {', i);
    const fin = src.indexOf('\n});', ini);
    return src.slice(ini + 'handler: async (request, context) => {'.length, fin).replace(/\s*\}\s*$/, '');
  };
  const mkHandler = (nombre) => {
    const c = cuerpo(nombre);
    if (!c) return null;
    return new Function('query','getClient','getMapa','getCatalogo','normCod','puedeBodega','puedeSima','getRole','json','SIMA_SELECT','SIMA_CAMPOS','simaTexto','simaPrecio',
      'return async (request, context) => {' + c + '};');
  };

  /* Contra el codigo anterior no existen ni las funciones ni los endpoints. Se
     reporta cada cosa como fallo y se sigue: reventar acá esconderia los
     asertos de la pantalla, que son la otra mitad de la prueba. */
  if (!fnTexto || !fnPrecio) {
    for (const n2 of ['el GET lista todo el catálogo', 'el PUT RECHAZA un código que no está en el catálogo',
                      'editar con un campo vacío lo BORRA', 'importar solo el precio NO borra lo demás',
                      'descarta el código que no está en el catálogo', 'Hospital SÍ puede importar'])
      chk(n2, false, 'la API no tiene los endpoints de Sima');
    await cli.end();
  } else {
  const query = (sql, p) => cli.query(sql, p);
  const getClient = async () => { const c = { query:(s2,p)=>cli.query(s2,p), release(){} }; return c; };
  const normCod = (c) => String(c == null ? '' : c).replace(/\s+/g, '').trim();
  const mapa = new Map(CATALOGO.map(p => [normCod(p.codigo), p.descripcion]));
  const F2 = new Function(fnTexto + '\n' + fnPrecio + '\nreturn { simaTexto, simaPrecio };')();
  const FECHA = `to_char((FechaModificacion AT TIME ZONE 'UTC') AT TIME ZONE 'America/Costa_Rica', 'YYYY-MM-DD HH24:MI')`;
  const SIMA_SELECT = `SELECT ProductoCodigo AS producto_codigo, CodigoSima AS codigo_sima,
       DescripcionSima AS descripcion_sima, LineaSima AS linea_sima,
       PartidaSima AS partida_sima, RenglonSima AS renglon_sima,
       PrecioSima::float8 AS precio_sima, ModificadoPor AS modificado_por,
       ${FECHA} AS fecha_modificacion
  FROM cat.ProductoSima`;
  const SIMA_CAMPOS = [['codigo_sima'],['descripcion_sima'],['linea_sima'],['partida_sima'],['renglon_sima'],['precio_sima']];
  let ult = null;
  const json = (st, b) => { ult = { status: st, body: b }; return ult; };
  const req = (params, body) => ({ params, query:{ get:()=>null }, json: async () => body });
  const ctx = { error(){}, warn(){}, log(){} };
  /* El permiso se EXTRAE del index.js en vez de reescribirse acá: si alguien
     vuelve a cerrar la pantalla a Bodega, esta prueba se cae. Reescribir la
     regla en la prueba la haría pasar en verde contra el código equivocado. */
  const lnSima = (src.match(/^const puedeSima = .*$/m) || [null])[0];
  chk('el index.js define puedeSima', !!lnSima, lnSima || 'no está');
  const puedeSima = lnSima ? new Function(lnSima + '\nreturn puedeSima;')() : (()=>false);
  const puedeBodega = (r)=>r==='Bodega'||r==='Administrador';
  const arma = (n) => { const h = mkHandler(n); return h ? h(query, getClient, async()=>mapa, async()=>CATALOGO, normCod,
      puedeBodega, puedeSima, async()=>ROL, json, SIMA_SELECT, SIMA_CAMPOS, F2.simaTexto, F2.simaPrecio) : null; };
  let ROL = 'Bodega';

  const hGet = arma('productos-sima-list'), hPut = arma('productos-sima-save'), hImp = arma('productos-sima-importar');
  if (!hGet || !hPut || !hImp) {
    chk('se encontraron los tres endpoints en el index.js', false,
        'get=' + !!hGet + ' put=' + !!hPut + ' imp=' + !!hImp);
  } else {
    global.getUser = () => ({ name:'Luis', email:'l@x.cr' });
    /* getUser vive en el módulo, así que se inyecta como global: los cuerpos
       extraídos lo resuelven por ahí. */

    /* 1. El GET lista TODO el catálogo, con los Sima vacíos. */
    await hGet(req({}, {}), ctx);
    chk('el GET lista todo el catálogo', ult.status === 200 && ult.body.productos.length === CATALOGO.length,
        JSON.stringify((ult.body.productos||[]).length));
    chk('y los campos Sima llegan vacíos cuando no hay',
        (ult.body.productos||[]).every(p => p.codigo_sima === '' && p.precio_sima === ''), '');

    /* 2. NO SE PUEDEN AGREGAR PRODUCTOS: el PUT rechaza un código de fuera. */
    await hPut(req({ codigo:'99999999' }, { codigo_sima:'QX2-9999' }), ctx);
    chk('el PUT RECHAZA un código que no está en el catálogo', ult.status === 404, JSON.stringify(ult));
    const n0 = (await cli.query('SELECT COUNT(*)::int n FROM cat.ProductoSima')).rows[0].n;
    chk('y no creó ninguna fila', n0 === 0, 'filas=' + n0);

    /* 3. El PUT guarda los seis, con el precio exacto. */
    await hPut(req({ codigo:'20108004' }, { codigo_sima:'QX2-0103', descripcion_sima:'Placa recta de 1/3 de caña',
      linea_sima:'3', partida_sima:'Suministro de material', renglon_sima:'Renglón 1', precio_sima:'234.468571428571' }), ctx);
    chk('el PUT guarda', ult.status === 200, JSON.stringify(ult));
    let f = (await cli.query(`SELECT * FROM cat.ProductoSima WHERE ProductoCodigo='20108004'`)).rows[0];
    chk('el precio se guarda con sus seis decimales', String(f.preciosima) === '234.468571', String(f.preciosima));

    /* 4. EL VACIO BORRA al editar. */
    await hPut(req({ codigo:'20108004' }, { codigo_sima:'QX2-0103', descripcion_sima:'', linea_sima:'3',
      partida_sima:'', renglon_sima:'', precio_sima:'' }), ctx);
    f = (await cli.query(`SELECT * FROM cat.ProductoSima WHERE ProductoCodigo='20108004'`)).rows[0];
    chk('editar con un campo vacío lo BORRA',
        f.descripcionsima === null && f.preciosima === null && f.codigosima === 'QX2-0103',
        JSON.stringify({ d:f.descripcionsima, p:f.preciosima, c:f.codigosima }));

    /* 5. EL VACIO NO TOCA al importar. */
    await hPut(req({ codigo:'20108005' }, { codigo_sima:'QX2-0103', descripcion_sima:'La de antes',
      linea_sima:'3', partida_sima:'P', renglon_sima:'R', precio_sima:'100' }), ctx);
    await hImp(req({}, { filas:[
      { linea:2, producto_codigo:'20108005', precio_sima:'250,75' }   // solo el precio, con coma
    ]}), ctx);
    chk('la importación aplica la fila', ult.status === 200 && ult.body.aplicadas === 1, JSON.stringify(ult.body));
    f = (await cli.query(`SELECT * FROM cat.ProductoSima WHERE ProductoCodigo='20108005'`)).rows[0];
    chk('importar solo el precio NO borra lo demás',
        f.descripcionsima === 'La de antes' && f.codigosima === 'QX2-0103' && String(f.preciosima) === '250.750000',
        JSON.stringify({ d:f.descripcionsima, c:f.codigosima, p:f.preciosima }));

    /* 6. La importación descarta lo que no está en el catálogo. */
    await hImp(req({}, { filas:[
      { linea:2, producto_codigo:'20108004', codigo_sima:'QX2-0103' },
      { linea:3, producto_codigo:'99999999', codigo_sima:'QX2-9999' },   // no está
      { linea:4, producto_codigo:'',         codigo_sima:'QX2-8888' },   // sin código
      { linea:5, producto_codigo:'24268008' }                            // sin ninguno de los seis
    ]}), ctx);
    chk('descarta el código que no está en el catálogo',
        ult.body.descartadas_total === 2, JSON.stringify(ult.body.descartadas));
    chk('la fila sin ninguno de los seis campos no toca el registro',
        ult.body.sin_datos_total === 1 && ult.body.aplicadas === 1, JSON.stringify(ult.body));
    const hay = (await cli.query(`SELECT COUNT(*)::int n FROM cat.ProductoSima WHERE ProductoCodigo IN ('99999999','24268008')`)).rows[0].n;
    chk('y ninguna de las dos creó fila', hay === 0, 'filas=' + hay);

    /* 7. Precio inválido: se avisa y NO se aplica esa fila. */
    await hImp(req({}, { filas:[{ linea:9, producto_codigo:'20108004', precio_sima:'como sea' }] }), ctx);
    chk('un precio ilegible se reporta y no se aplica',
        ult.body.precio_invalido_total === 1 && ult.body.aplicadas === 0, JSON.stringify(ult.body));

    /* 8. Código repetido en el archivo: gana la última fila. */
    await hImp(req({}, { filas:[
      { linea:2, producto_codigo:'20108004', codigo_sima:'PRIMERA' },
      { linea:3, producto_codigo:'20108004', codigo_sima:'ULTIMA' }
    ]}), ctx);
    f = (await cli.query(`SELECT CodigoSima FROM cat.ProductoSima WHERE ProductoCodigo='20108004'`)).rows[0];
    chk('con el código repetido gana la ÚLTIMA fila', f.codigosima === 'ULTIMA', String(f.codigosima));

    /* 9. El rol. Los TRES escriben; uno de fuera de los tres, no. */
    ROL = 'Hospital';
    await hGet(req({}, {}), ctx);
    chk('Hospital SÍ puede listar', ult.status === 200, JSON.stringify(ult.status));
    chk('y le llega el precio, igual que a Bodega',
        ult.status === 200 && (ult.body.productos || []).some(p2 => p2.precio_sima !== ''),
        JSON.stringify((ult.body.productos || []).map(p2 => p2.precio_sima)));
    /* EL CAMBIO: Hospital edita e importa. Antes los dos daban 403. */
    await hPut(req({ codigo:'20108004' }, { codigo_sima:'HOSP-PUT' }), ctx);
    chk('Hospital SÍ puede editar', ult.status === 200, JSON.stringify(ult));
    f = (await cli.query(`SELECT CodigoSima FROM cat.ProductoSima WHERE ProductoCodigo='20108004'`)).rows[0];
    chk('y el dato quedó escrito', f.codigosima === 'HOSP-PUT', String(f.codigosima));
    await hImp(req({}, { filas:[{ linea:2, producto_codigo:'20108004', codigo_sima:'HOSP-IMP' }] }), ctx);
    chk('Hospital SÍ puede importar', ult.status === 200 && ult.body.aplicadas === 1, JSON.stringify(ult.body));
    f = (await cli.query(`SELECT CodigoSima FROM cat.ProductoSima WHERE ProductoCodigo='20108004'`)).rows[0];
    chk('y la importación de Hospital escribió', f.codigosima === 'HOSP-IMP', String(f.codigosima));

    /* Los otros dos siguen escribiendo: abrirla a Hospital no le quitó el
       permiso a nadie. */
    for (const r2 of ['Bodega', 'Administrador']) {
      ROL = r2;
      await hPut(req({ codigo:'20108004' }, { codigo_sima:r2.toUpperCase() }), ctx);
      chk(r2 + ' sigue pudiendo editar', ult.status === 200, JSON.stringify(ult.status));
    }

    /* Y NO es «cualquiera con sesión»: un rol de fuera de los tres, 403. Sin
       este aserto, cambiar puedeSima por `true` pasaría en verde. */
    ROL = 'Proveedor';
    await hPut(req({ codigo:'20108004' }, { codigo_sima:'AJENO' }), ctx);
    chk('un rol de fuera de los tres NO puede editar', ult.status === 403, JSON.stringify(ult.status));
    await hImp(req({}, { filas:[{ linea:2, producto_codigo:'20108004', codigo_sima:'AJENO' }] }), ctx);
    chk('un rol de fuera de los tres NO puede importar', ult.status === 403, JSON.stringify(ult.status));
    f = (await cli.query(`SELECT CodigoSima FROM cat.ProductoSima WHERE ProductoCodigo='20108004'`)).rows[0];
    chk('y no le tocó el dato', f.codigosima === 'ADMINISTRADOR', String(f.codigosima));
    ROL = 'Bodega';

    /* 10. Filas huérfanas: el producto ya no está en el catálogo. */
    await cli.query(`INSERT INTO cat.ProductoSima (ProductoCodigo, CodigoSima) VALUES ('77777777','VIEJO')`);
    await hGet(req({}, {}), ctx);
    chk('una fila de un código que ya no está en el catálogo no se lista, pero se cuenta',
        ult.body.productos.length === CATALOGO.length && ult.body.huerfanas === 1,
        'filas=' + ult.body.productos.length + ' huerfanas=' + ult.body.huerfanas);
  }
  await cli.end();
  }

  /* ── La pantalla ──────────────────────────────────────────────────────── */
  const nav = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const FILAS = [
    { codigo:'20108004', descripcion:'Placa recta 1/3 caña 4 orificios', codigo_sima:'QX2-0103',
      descripcion_sima:'Placa recta de 1/3 de caña, bloqueada', linea_sima:'3', partida_sima:'Suministro',
      renglon_sima:'Renglón 1', precio_sima:234.468571 },
    { codigo:'20108005', descripcion:'Placa recta 1/3 caña 5 orificios', codigo_sima:'', descripcion_sima:'',
      linea_sima:'', partida_sima:'', renglon_sima:'', precio_sima:'' }
  ];
  /* Los TRES editan y suben Excel: Hospital incluido. El cuarto caso NO es un
     rol de la app -no existe 'Proveedor'-: está para comprobar que la pantalla
     sigue teniendo modo de solo lectura, y que abrirla a Hospital no fue poner
     `true`. De paso mantiene vivo el aserto del CSS: sin columna de acciones,
     el Precio no debe quedar anclado.

     DESDE EL ROL 'Impresión' (10 de setiembre) la CEJILLA ya no es de todos:
     su `ver` pasó de `()=>true` a los tres roles de la app. Un rol de fuera de
     los tres -el kiosco del hospital- no debe ver un catálogo con precios en
     una máquina de pasillo. La PANTALLA no cambió: sigue teniendo su modo de
     solo lectura, y eso es lo que se prueba acá llamando a showSima() directo,
     sin pasar por el menú. */
  for (const [rol, edita] of [['Bodega',true], ['Administrador',true], ['Hospital',true], ['Proveedor',false]]) {
    const pg = await (await nav.newContext({ viewport:{width:1440,height:1000} })).newPage();
    pg.on('pageerror', e => chk('sin errores de JS (' + rol + ')', false, e.message));
    await pg.goto('file://' + IDX, { waitUntil:'domcontentloaded' });
    await pg.waitForTimeout(700);
    const r = await pg.evaluate(async ([rol, filas]) => {
      window.__PUT = [];
      api = async (m, url, body) => {
        if (url === '/productos/sima' && m === 'GET') return { productos: filas, con_sima: 1, huerfanas: 0 };
        if (/^\/productos\/sima\//.test(url) && m === 'PUT') { window.__PUT.push({ url, body }); return { ok:true }; }
        return {};
      };
      showLoading = () => {}; hideLoading = () => {}; toast = (m) => { window.__T = m; };
      ROL = rol; REAL_ROL = rol; USER = { name:'Luis', email:'l@x.cr' };
      document.getElementById('login').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      buildNav();
      const enMenu = [...document.querySelectorAll('#navTabs button')].map(b => b.textContent.trim());
      if (typeof showSima !== 'function') return { noHay:true, enMenu };
      await showSima();
      /* La ultima celda del encabezado es la vacia del boton Editar: se saca,
         si no el aserto compara nueve contra ocho. */
      /* Las columnas de DATOS: se descarta la celda de acciones cuando existe. */
      const th = [...document.querySelectorAll('#simaHead tr:first-child th')];
      const cols = th.filter(t => !t.classList.contains('sima-acc')).map(t => t.textContent.trim());
      const celdas = [...document.querySelectorAll('#simaBody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()));
      const btnSubir = document.getElementById('simaXlsBtn2');
      return { enMenu, cols, celdas, visible: !document.getElementById('viewSima').classList.contains('hidden'),
               hayNuevo: /Nuevo/i.test(document.querySelector('#viewSima .page-head').textContent),
               haySubir: !!btnSubir && !btnSubir.classList.contains('hidden'),
               hayEditar: !!document.querySelector('#simaBody .sima-acc button'),
               /* Cuando NO hay columna de acciones, la ultima celda es el Precio
                  y NO se debe anclar: si se anclara, el precio quedaria flotando
                  encima del resto al correr la tabla. */
               ultimaAnclada: (()=>{ const tr=document.querySelector('#simaBody tr');
                 if(!tr) return null; const td=tr.children[tr.children.length-1];
                 return getComputedStyle(td).position; })(),
               accAnclada: (()=>{ const td=document.querySelector('#simaBody .sima-acc');
                 return td ? getComputedStyle(td).position : null; })() };
    }, [rol, FILAS]);

    if (r.noHay) { chk(rol + ': existe showSima()', false, 'no está definida'); await pg.close(); continue; }
    /* La cejilla es de los tres roles de la app; un rol de fuera no la ve. */
    const deLaApp = ['Bodega','Administrador','Hospital'].includes(rol);
    chk(rol + ': la opción «Código Sima» ' + (deLaApp ? 'está' : 'NO está') + ' en el menú',
        r.enMenu.some(x => /Código Sima/.test(x)) === deLaApp,
        JSON.stringify(r.enMenu.filter(x=>/Sima|Hospitales/.test(x))));
    chk(rol + ': la pantalla se abre', r.visible === true, '');

    chk(rol + ': el grid trae las ocho columnas en orden',
        JSON.stringify(r.cols) === JSON.stringify(['Código Nutricare','Descripción Nutricare','Código Sima',
          'Descripción Sima','Línea','Partida','Renglón','Precio']), JSON.stringify(r.cols));
    chk(rol + ': el precio se muestra con dos decimales',
        (r.celdas[0] || [])[7] === '234.47', JSON.stringify((r.celdas[0] || [])[7]));
    chk(rol + ': NO hay botón de nuevo producto', r.hayNuevo === false, '');
    /* El precio se ve en todos los roles, tambien en el de solo lectura. */
    chk(rol + ': la columna Precio está y con su valor',
        r.cols.includes('Precio') && (r.celdas[0]||[])[7] === '234.47', JSON.stringify(r.cols));
    chk(rol + ': el botón Subir Excel ' + (edita ? 'está' : 'NO está'), r.haySubir === edita, 'haySubir=' + r.haySubir);
    chk(rol + ': el botón Editar ' + (edita ? 'está' : 'NO está'), r.hayEditar === edita, 'hayEditar=' + r.hayEditar);
    chk(rol + ': la columna de acciones ' + (edita ? 'está anclada' : 'no existe'),
        edita ? r.accAnclada === 'sticky' : r.accAnclada === null, 'accAnclada=' + r.accAnclada);
    /* Y sin acciones, el Precio NO queda anclado. */
    if (!edita) chk(rol + ': la última celda (Precio) NO queda anclada',
        r.ultimaAnclada !== 'sticky', 'position=' + r.ultimaAnclada);

    if (!edita) {
      /* Un rol sin permiso no edita ni llamando la funcion a mano. */
      const bloq = await pg.evaluate(() => {
        window.__T = null;
        editarSima('20108004');
        return { abierto: !document.getElementById('simaModal').classList.contains('hidden'), aviso: window.__T };
      });
      chk(rol + ': editarSima() a mano NO abre el modal y avisa',
          bloq.abierto === false && /no puede editar/i.test(String(bloq.aviso)), JSON.stringify(bloq));
      await pg.close(); continue;
    }

    /* El modal: los dos de Nutricare no son editables, los seis Sima sí. */
    const mod = await pg.evaluate(() => {
      editarSima('20108004');
      const ids = ['sima_codigo','sima_descripcion','sima_linea','sima_partida','sima_renglon','sima_precio'];
      return {
        abierto: !document.getElementById('simaModal').classList.contains('hidden'),
        prodCod: document.getElementById('sima_prod_cod').textContent,
        /* Los de Nutricare tienen que ser TEXTO, no campos de formulario. */
        codEsInput: !!document.querySelector('#sima_prod_cod input, #sima_prod_cod textarea, #sima_prod_cod select'),
        descEsInput: !!document.querySelector('#sima_prod_desc input, #sima_prod_desc textarea, #sima_prod_desc select'),
        editables: ids.map(i => { const e = document.getElementById(i); return e ? (e.disabled ? 'off' : e.tagName) : null; }),
        /* El precio del modal lleva el valor EXACTO, no el redondeado. */
        precio: document.getElementById('sima_precio').value
      };
    });
    chk(rol + ': el modal abre con el producto', mod.abierto && mod.prodCod === '20108004', JSON.stringify(mod.prodCod));
    chk(rol + ': el código y la descripción de Nutricare NO son editables',
        mod.codEsInput === false && mod.descEsInput === false, JSON.stringify(mod));
    chk(rol + ': los seis campos Sima SÍ son editables',
        mod.editables.every(t => t === 'INPUT' || t === 'TEXTAREA'), JSON.stringify(mod.editables));
    chk(rol + ': el modal muestra el precio EXACTO, no el redondeado',
        mod.precio === '234.468571', JSON.stringify(mod.precio));

    /* Guardar manda los seis y solo los seis. */
    const put = await pg.evaluate(async () => {
      document.getElementById('sima_codigo').value = 'QX2-0999';
      window.__PUT = [];
      await guardarSima();
      return window.__PUT;
    });
    chk(rol + ': al guardar manda los seis campos Sima y ninguno de Nutricare',
        put.length === 1 && JSON.stringify(Object.keys(put[0].body).sort()) ===
          JSON.stringify(['codigo_sima','descripcion_sima','linea_sima','partida_sima','precio_sima','renglon_sima']),
        put.length ? JSON.stringify(Object.keys(put[0].body)) : 'no hubo PUT');
    chk(rol + ': y al producto correcto',
        put.length === 1 && /20108004$/.test(put[0].url), put.length ? put[0].url : '');
    await pg.close();
  }
  await nav.close();

  console.log(res.join('\n'));
  process.exit(res.some(x => x.startsWith('  FALLA')) ? 1 : 0);
})().catch(e => { console.log(res.join('\n')); console.log('\nERROR: ' + e.message + '\n' + e.stack); process.exit(1); });
