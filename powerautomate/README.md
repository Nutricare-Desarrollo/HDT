# Flujo de avisos (genérico)

El flujo vive en Power Automate y **no** está en este repositorio. Lo que sí
está acá son las dos piezas que se pegan a mano, para que queden versionadas y
se pueda ver qué cambió.

| Archivo | Dónde va |
|---|---|
| `esquema_trigger.json` | Trigger **When a HTTP request is received** → *Request Body JSON Schema* |
| `tarjeta_adaptativa.json` | Acción que manda la tarjeta (Teams / correo) → cuerpo del Adaptive Card |

## El contrato

Cuatro campos, y nada más. El trigger es **genérico**: lo usa esta app y puede
usarlo cualquier otra, así que no sabe nada de solicitudes, bandejas ni
estados.

```json
{
  "Descripcion":   "ORT-000003 — Hospital del Trauma INS — 3 bandejas",
  "SolicitadoPor": "lgomez@nutricare.co.cr",
  "Url":           "https://<host-del-app>/#solicitud=17",
  "Cuentas":       [ { "email": "lgomez@nutricare.co.cr" } ]
}
```

`Descripcion` es **todo el mensaje**: la app que llama es la que sabe qué pasó,
así que arma ahí la frase completa. En esta app, por ejemplo:

- `ORT-000003 — Hospital del Trauma INS — cirugía del 12/09/2026 08:30 — 3 bandejas`
- `Equipo alistado — ORT-000003 — … — sin check list: NUT-10291`
- `Solicitud devuelta al hospital para cambios — ORT-000003 — … — se descartaron 40 marcas del alisto`

## De dónde sale la `Url`

De la **petición que se está atendiendo**, no de una constante ni de una App
Setting. Azure Static Web Apps reenvía la URL original en la cabecera
`x-ms-original-url`, y de ahí sale el host real del sitio (ver `portalDe()` en
`api/src/notificar.js`).

Dos razones:

1. Clonar el sitio para un ambiente de pruebas no obliga a acordarse de
   cambiar nada: el aviso apunta a donde se generó. Producción a producción,
   pruebas a pruebas.
2. `host` a secas **no sirve**: en las Functions administradas de Static Web
   Apps es el host interno del runtime, no el del sitio.

El orden es `x-ms-original-url` → `x-forwarded-host` → App Setting `PORTAL_URL`
(último recurso, para forzar el destino) → `host`. Si no se puede determinar
ninguno, se manda cadena vacía: mejor un aviso sin botón que un botón a
ninguna parte.

La `Url` incluye `#solicitud=<id>` y el portal abre esa solicitud al entrar.
Se usa el **id** y no el código para que el portal no tenga que buscarlo en el
listado, que para Bodega ni siquiera trae los borradores. Si algún día se
quiere el aviso apuntando solo a la raíz, es quitar el fragmento en
`urlSolicitud()`.

## Lo que se arregló en la tarjeta

- **La hora.** `utcNow()` devuelve UTC, seis horas adelante de Costa Rica, y
  además sin formato (`2026-09-04T18:53:12.1234567Z`). Ahora la expresión es:

  ```
  formatDateTime(convertFromUtc(utcNow(), 'Central America Standard Time'), 'dd/MM/yyyy HH:mm')
  ```

  Costa Rica no tiene horario de verano, así que esa zona es correcta todo el
  año.

- **«Pendiente de revisión» estaba fija.** El mismo trigger manda avisos de
  cosas distintas —solicitud enviada, equipo alistado, solicitud devuelta— y
  en la mayoría ese texto era falso. Se quitó: `Descripcion` ya dice qué pasó.

- **El botón** usa `Url` en vez de un enlace escrito a mano, así que lleva al
  registro y al ambiente correctos.

- **`fallbackText`**, para que la vista previa de la notificación en Teams y en
  el celular muestre algo útil.

## Por qué la tarjeta no tiene condicionales

Porque no puede tenerlos de forma confiable. La interpolación de Power
Automate siempre produce una **cadena**, y escribe los booleanos como `True` /
`False` con mayúscula: un `"isVisible": "@{...}"` le llega al renderizador
como `"False"`, que es una cadena no vacía, la toma por verdadera, y el bloque
aparece **siempre**. Adaptive Cards 1.4 tampoco tiene expresiones propias
(`$when` necesita el SDK de plantillas, que esta acción no ejecuta). La única
forma confiable de que algo no se vea es que no traiga texto.

## Ojo: la firma del trigger

La URL del trigger lleva `sig=...`, que **es una credencial**. Vive solo en la
App Setting `NOTIF_SOLICITUD_URL` del Static Web App: nunca en el código,
nunca en el frontend, nunca commiteada. Sigue pendiente regenerarla en Power
Automate y actualizar la variable en Azure.
