/* Bitácora de actividad: qué hizo cada usuario en la app.

   El registro NO se llama desde cada endpoint. Se envuelve app.http una
   sola vez y todo lo que no sea GET queda registrado solo. La razón es
   simple: hay cuarenta endpoints que escriben, y basta olvidar uno para que
   la bitácora tenga un hueco justo donde alguien va a buscar. Un envoltorio
   no se puede olvidar.

   Qué se guarda: solo lo que tuvo EFECTO. Se registran las respuestas 2xx
   —la operación se hizo— y los 403 —alguien intentó algo que su rol no
   permite, que es lo único que vale la pena de un intento fallido—. Un 400
   de validación no entra: si alguien toca Guardar cinco veces con un campo
   mal, son cinco filas de ruido.

   El detalle sale de la RESPUESTA del endpoint, no de un parámetro nuevo en
   cada handler: los endpoints ya devuelven codigo, estado, alisto_borrado,
   avisos y notificacion, que es exactamente lo que se quiere en el registro.
   Por eso no hubo que tocar ningún handler.

   Nada de acá puede tumbar la operación que registra. Si el INSERT falla, se
   anota en el log de la Function y la respuesta sale igual: perder el
   trabajo del usuario por la bitácora sería peor que perder la fila. */

/* Ruta -> pantalla y nombre de la acción por método. La ruta es la misma
   cadena con la que el endpoint se registra en app.http, así que si alguien
   la cambia y se olvida de acá, la fila sale con la ruta cruda en vez de un
   nombre legible: se degrada, no se pierde.
   `POST /extraer` NO está: lee una imagen y devuelve datos, no modifica
   nada. Es la única excepción deliberada. */
const MAPA = {
  'cirujanos':                                   { p:'Catálogos',           POST:'Agregó un cirujano' },
  'cirujanos/{id}':                              { p:'Catálogos',           PUT:'Corrigió un cirujano' },
  'regimenes':                                   { p:'Catálogos',           POST:'Agregó un régimen' },
  'regimenes/{id}':                              { p:'Catálogos',           PUT:'Corrigió un régimen' },
  'equipos/importar':                            { p:'Bandejas',            POST:'Importó el catálogo de equipos' },
  'bandejas':                                    { p:'Bandejas',            POST:'Creó una bandeja' },
  'bandejas/{codigo}':                           { p:'Bandejas',            PUT:'Editó la bandeja' },
  'bandejas/{codigo}/productos':                 { p:'Bandejas',            POST:'Agregó un producto a la bandeja' },
  'bandejas/{codigo}/productos/{producto}':      { p:'Bandejas',            PUT:'Cambió la cantidad de un producto',
                                                                            DELETE:'Quitó un producto de la bandeja' },
  'hospitales':                                  { p:'Hospitales',          POST:'Agregó un hospital' },
  'hospitales/{id}':                             { p:'Hospitales',          PUT:'Editó el hospital' },
  'notificaciones':                              { p:'Notificaciones',      POST:'Agregó una cuenta de aviso' },
  'notificaciones/{id}':                         { p:'Notificaciones',      PUT:'Cambió los eventos de una cuenta',
                                                                            DELETE:'Quitó una cuenta de aviso' },
  'solicitudes':                                 { p:'Solicitud de Equipo', POST:'Creó una solicitud' },
  'solicitudes/{id}':                            { p:'Solicitud de Equipo', PUT:'Guardó el borrador de la solicitud',
                                                                            DELETE:'Eliminó la solicitud' },
  'solicitudes/{id}/enviar':                     { p:'Solicitud de Equipo', POST:'Envió la solicitud a Bodega' },
  'solicitudes/{id}/despachar':                  { p:'Solicitud de Equipo', POST:'Envió el equipo al hospital' },
  'solicitudes/{id}/devolver':                   { p:'Solicitud de Equipo', POST:'Devolvió la solicitud al hospital' },
  'solicitudes/{id}/reabrir':                    { p:'Solicitud de Equipo', POST:'Reabrió el alisto' },
  'solicitudes/{id}/bandejas/{codigo}/checklist':{ p:'Solicitud de Equipo', PUT:'Guardó el alisto de una bandeja' },
  'hojas':                                       { p:'Hojas de consumo',    POST:'Registró una hoja de consumo' },
  'hojas/{id}':                                  { p:'Hojas de consumo',    PUT:'Editó la hoja de consumo',
                                                                            DELETE:'Eliminó la hoja de consumo' },
  'hojas/{id}/selladas':                         { p:'Hojas de consumo',    POST:'Subió una foto de la hoja sellada' },
  'hojas/{id}/selladas/{sid}':                   { p:'Hojas de consumo',    DELETE:'Borró una foto de la hoja sellada' },
  'hojas/{id}/resolver':                         { p:'Reemplazos',          POST:'Marcó el reemplazo como resuelto' },
  'cirugias':                                    { p:'Cirugías',            POST:'Agregó una cirugía' },
  'cirugias/{id}':                               { p:'Cirugías',            PUT:'Editó la cirugía' },
  'cirugias/importar':                           { p:'Cirugías',            POST:'Importó cirugías' },
  'cirugias/ingest':                             { p:'Cirugías',            POST:'Recibió cirugías por integración' },
  'configuracion':                               { p:'Configuración',       PUT:'Cambió la configuración' },
  'dynamics/{id}':                               { p:'Hojas de consumo',    POST:'Creó los trabajos en Dynamics' },
  'pedidos/{id}/envios':                         { p:'Pedido Pendiente',    PUT:'Guardó los envíos del pedido' },
  'pedidos/{id}/envios/pendientes':              { p:'Pedido Pendiente',    DELETE:'Canceló los envíos pendientes' },
  'pedidos/{id}/dynamics':                       { p:'Pedido Pendiente',    POST:'Envió el pedido a Dynamics' },
  'usuarios/{email}':                            { p:'Usuarios y roles',    PUT:'Cambió el rol de un usuario' }
};

const corta = (v, n) => {
  const t = (v === undefined || v === null) ? '' : String(v).trim();
  return t ? t.slice(0, n) : null;
};

/* El registro sobre el que se actuó, en texto legible. Primero lo que
   devolvió el endpoint -que es el dato ya normalizado- y si no, lo que venía
   en la ruta. */
function registroDe(request, cuerpo) {
  const c = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const p = request.params || {};
  return corta(c.codigo || c.demarcado || c.numero_hoja || c.email
    || p.codigo || p.producto || p.email || p.id, 120);
}

/* Detalle en lenguaje llano, compuesto con lo que ya trae la respuesta. */
function detalleDe(cuerpo) {
  const c = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
  const partes = [];
  if (c.estado) partes.push('quedó en ' + c.estado);
  if (typeof c.alistados === 'number' && typeof c.articulos === 'number') {
    partes.push(c.alistados + ' de ' + c.articulos + ' componentes');
  }
  if (typeof c.alisto_borrado === 'number' && c.alisto_borrado > 0) {
    partes.push('se descartaron ' + c.alisto_borrado
      + (c.alisto_borrado === 1 ? ' marca del alisto' : ' marcas del alisto'));
  }
  if (Array.isArray(c.avisos) && c.avisos.length) {
    partes.push('sin check list: ' + c.avisos.join(', '));
  }
  if (c.notificacion) {
    partes.push(c.notificacion.enviado
      ? ('avisó a ' + c.notificacion.cuentas + (c.notificacion.cuentas === 1 ? ' cuenta' : ' cuentas'))
      : 'el aviso por correo no salió');
  }
  return corta(partes.join(' · '), 400);
}

/* Envuelve la configuración de un endpoint. Devuelve la misma config con el
   handler envuelto, o tal cual si el endpoint no escribe. */
function envolver(cfg, deps) {
  const metodos = (cfg && cfg.methods) || [];
  const escribe = metodos.some((m) => m !== 'GET' && m !== 'OPTIONS');
  const conf = MAPA[cfg && cfg.route];
  if (!escribe || !conf) return cfg;

  const original = cfg.handler;
  return Object.assign({}, cfg, {
    handler: async (request, context) => {
      const res = await original(request, context);
      try {
        const estado = (res && res.status) || 200;
        /* 2xx: se hizo. 403: intento sin permiso, que si interesa. El resto
           -400 de validacion, 404, 409- no entra: es ruido. */
        if (!((estado >= 200 && estado < 300) || estado === 403)) return res;
        const accion = conf[request.method];
        if (!accion) return res;

        const user = deps.getUser(request);
        /* Una consulta extra de rol, solo en las operaciones que escriben.
           No se cachea el rol a proposito: cambiarle el rol a alguien tiene
           que verse en la fila siguiente, no en un minuto. */
        let rol = null;
        try { rol = user ? await deps.getRole(user) : null; } catch { rol = null; }

        const cuerpo = res && res.jsonBody;
        await deps.query(
          `INSERT INTO dbo.Bitacora
             (Usuario, UsuarioEmail, Rol, Pantalla, Accion, Registro, Detalle, Metodo, Ruta, Estado)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [corta(user && (user.name || user.email), 200), corta(user && user.email, 200),
           corta(rol, 30), conf.p, accion + (estado === 403 ? ' (sin permiso)' : ''),
           registroDe(request, cuerpo), detalleDe(cuerpo),
           request.method, corta(cfg.route, 200), estado]);
      } catch (e) {
        /* La bitacora no tumba la operacion. */
        try { context.error('No se pudo escribir la bitácora: ' + e.message); } catch {}
      }
      return res;
    }
  });
}

module.exports = { envolver, MAPA };
