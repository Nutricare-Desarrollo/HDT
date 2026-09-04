/* Aviso por correo de los eventos de Solicitud de Equipo.

   El envio lo hace un flujo de Power Automate. Su URL lleva la firma del
   trigger (sig=...), o sea que ES una credencial: va en la App Setting
   NOTIF_SOLICITUD_URL del Static Web App y nunca en el codigo ni en el
   frontend. Mismo criterio que DYNAMICS_API_URL y PRODUCTOS_API_URL.

   Cuerpo que espera el flujo, verificado contra el trigger con Postman
   (200 OK, {"Resultado":"Enviado"}). Cuentas es un arreglo de OBJETOS con la
   propiedad email, no de strings:
     {
       "Descripcion": "...",
       "SolicitadoPor": "email",
       "Cuentas": [{ "email": "a@x" }, { "email": "b@x" }]
     }

   Nada de lo que pasa aca tumba la operacion que lo llamo: si el flujo no
   responde, la solicitud igual queda enviada y el llamador recibe el aviso
   para avisarle a Bodega por otro medio. Perder el trabajo del usuario por
   un webhook intermitente seria peor. */

const TIMEOUT_MS = parseInt(process.env.NOTIF_TIMEOUT_MS || '20000', 10);

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
async function notificar({ descripcion, solicitadoPor, cuentas, envName = 'NOTIF_SOLICITUD_URL' }, context) {
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
    if (context && cuerpo) context.log('Notificación enviada. Respuesta del flujo: ' + String(cuerpo).slice(0, 200));
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

module.exports = { notificar, cuentasDe };
