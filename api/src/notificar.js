/* Aviso por correo de los eventos de Solicitud de Equipo.

   El envio lo hace un flujo de Power Automate. Su URL lleva la firma del
   trigger (sig=...), o sea que ES una credencial: va en la App Setting
   NOTIF_SOLICITUD_URL del Static Web App y nunca en el codigo ni en el
   frontend. Mismo criterio que DYNAMICS_API_URL y PRODUCTOS_API_URL.

   Cuerpo que espera el flujo. Es un contrato GENERICO -el mismo trigger lo
   usan otras apps-, asi que son cuatro campos y nada mas. Cuentas es un
   arreglo de OBJETOS con la propiedad email, no de strings:
     {
       "Descripcion":  "ORT-000003 - Hospital del Trauma INS - 3 bandejas",
       "SolicitadoPor":"lgomez@nutricare.co.cr",
       "Url":          "https://<host-del-app>/#solicitud=17",
       "Cuentas":      [{ "email": "a@x" }, { "email": "b@x" }]
     }

   La Url NO esta escrita en el codigo ni en una variable de ambiente: sale de
   la peticion que se esta atendiendo (ver portalDe). Asi el aviso siempre
   apunta al ambiente desde donde se genero -produccion a produccion, pruebas
   a pruebas- sin tener que recordar cambiar una App Setting al clonar el
   sitio.

   Nada de lo que pasa aca tumba la operacion que lo llamo: si el flujo no
   responde, la solicitud igual queda enviada y el llamador recibe el aviso
   para avisarle a Bodega por otro medio. Perder el trabajo del usuario por
   un webhook intermitente seria peor. */

const TIMEOUT_MS = parseInt(process.env.NOTIF_TIMEOUT_MS || '20000', 10);

/* ----- URL publica del app -----
   Azure Static Web Apps reenvia la URL original de la peticion en la cabecera
   `x-ms-original-url`; de ahi sale el host real del sitio. Se prefiere eso a
   una constante o una App Setting por dos razones:
     - clonar el sitio para un ambiente de pruebas no obliga a acordarse de
       cambiar nada: el aviso apunta a donde se genero;
     - `host` a secas NO sirve, porque en las Functions administradas de SWA
       es el host interno del runtime, no el del sitio.
   PORTAL_URL queda como ultimo recurso, para poder forzar el destino. */
function portalDe(request) {
  const h = (k) => {
    try { return (request && request.headers && request.headers.get(k)) || ''; }
    catch { return ''; }
  };
  const orig = h('x-ms-original-url');
  if (orig) {
    try { return new URL(orig).origin; } catch { /* sigue con las otras */ }
  }
  const reenviado = h('x-forwarded-host');
  if (reenviado) return (h('x-forwarded-proto') || 'https') + '://' + reenviado.split(',')[0].trim();
  const env = String(process.env.PORTAL_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const host = h('host');
  return host ? 'https://' + host : '';
}

/* Enlace del boton del aviso. Se usa el ID y no el codigo para que el portal
   no tenga que buscarlo en el listado, que para Bodega ni siquiera trae los
   borradores. Si no se pudo determinar el host, se manda cadena vacia y el
   flujo decide: mejor un aviso sin boton que un boton a ninguna parte. */
function urlSolicitud(request, id) {
  const raiz = portalDe(request);
  if (!raiz) return '';
  return raiz + (id ? '/#solicitud=' + encodeURIComponent(id) : '/');
}

async function postConTimeout(url, cuerpo) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(t);
  }
}

/* Manda el aviso. Devuelve { enviado, cuentas, aviso } y NUNCA lanza:
   - enviado: true si el flujo respondio 2xx
   - cuentas: cuantas direcciones se incluyeron
   - aviso:   texto para mostrarle al usuario cuando algo no salio */
async function notificar({ descripcion, solicitadoPor, cuentas, url: urlApp,
                            envName = 'NOTIF_SOLICITUD_URL' }, context) {
  const lista = (cuentas || []).map((c) => String(c || '').trim()).filter(Boolean);
  if (!lista.length) {
    return { enviado: false, cuentas: 0, aviso: 'No hay cuentas configuradas para este evento; no se envió el aviso.' };
  }
  const url = process.env[envName];
  if (!url) {
    if (context) context.warn(`Falta configurar ${envName}; no se envió el aviso.`);
    return { enviado: false, cuentas: lista.length, aviso: `Falta configurar ${envName} en el servidor; no se envió el aviso.` };
  }
  try {
    const res = await postConTimeout(url, {
      Descripcion: String(descripcion || ''),
      SolicitadoPor: String(solicitadoPor || ''),
      Url: String(urlApp || ''),
      Cuentas: lista.map((email) => ({ email }))
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (context) context.error(`El flujo de notificación respondió ${res.status}. ${String(txt).slice(0, 300)}`);
      return { enviado: false, cuentas: lista.length, aviso: `El flujo de notificación respondió ${res.status}; el aviso no salió.` };
    }
    /* El flujo responde {"Resultado":"Enviado"}. Se considera enviado por el
       2xx -no por ese texto, para no romperse si el flujo cambia su
       respuesta-, pero se registra para poder revisarlo en el log del run. */
    const cuerpo = await res.text().catch(() => '');
    /* Se registra la Url que se mando: es lo unico del aviso que se calcula a
       partir de las cabeceras, asi que si un dia el boton llevara a un host
       equivocado, el log del run lo dice sin tener que reproducirlo. */
    if (context) context.log('Notificación enviada a ' + lista.length + ' cuenta(s). Url: '
      + (urlApp || '(sin determinar)')
      + (cuerpo ? '. Respuesta del flujo: ' + String(cuerpo).slice(0, 200) : ''));
    return { enviado: true, cuentas: lista.length, aviso: null };
  } catch (e) {
    const porTimeout = e && e.name === 'AbortError';
    if (context) context.error('No se pudo notificar: ' + e.message);
    return {
      enviado: false, cuentas: lista.length,
      aviso: porTimeout
        ? 'El flujo de notificación no respondió a tiempo; el aviso no salió.'
        : 'No se pudo contactar el flujo de notificación; el aviso no salió.'
    };
  }
}

/* Cuentas suscritas a un evento. El nombre NO viene del cliente: se
   interpola en el SQL, asi que solo puede salir de esta tabla.
   Ojo con los dos parecidos: `devolucion` es el hospital devolviendo el
   EQUIPO despues de la cirugia, y `devuelta` es Bodega devolviendo la
   SOLICITUD al hospital para que le haga cambios. */
const EVENTOS = { solicitud: 'Solicitud', alistado: 'Alistado', devolucion: 'Devolucion',
                  liberado: 'Liberado', devuelta: 'Devuelta' };

async function cuentasDe(query, evento) {
  const col = EVENTOS[evento];
  if (!col) throw new Error('Evento de notificación desconocido: ' + evento);
  const r = await query(`SELECT Email FROM cat.Notificacion WHERE ${col} = TRUE ORDER BY Email`);
  return r.rows.map((x) => x.email);
}

module.exports = { notificar, cuentasDe, portalDe, urlSolicitud };
