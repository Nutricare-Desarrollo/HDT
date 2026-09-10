# Pruebas de navegador

Seis suites que se escribieron el 7 de setiembre mientras se construía la
validación de bandeja por foto. **No corren en la máquina de Luis**: corren
dentro de la sesión de Claude, que tiene Chromium y Playwright instalados.
Se guardan acá porque volver a escribirlas cuesta más que guardarlas, y
porque cada una documenta —en forma ejecutable— por qué un arreglo era un
arreglo.

## Cómo se corren

```
node probar_val.js                    # contra el index.html actual
node probar_val.js /ruta/al/otro.html # contra otra versión
```

Cada una carga el `index.html` **real** en Chromium, reemplaza `api()` por una
API de mentira y ejercita la pantalla. Salen con código 1 si algo falla.

Ojo con dos cosas al escribir asertos nuevos:

- `SOL_ACT`, `VAL`, `CB_ACT` y compañía son `let` de nivel de script: **no
  viven en `window`**. Hay que asignarles sin `window.` o se crea una variable
  aparte y la pantalla sigue leyendo la original.
- Los ids de foto llegan como **cadena** (`BIGINT` → node-postgres devuelve
  string). Las pruebas los usan como cadena a propósito: fue un bug real.

## Qué prueba cada una

| Archivo | Qué cubre |
|---|---|
| `probar_val.js` | Pantalla «Validar bandeja»: los tres veredictos, el veredicto desactualizado, la selección múltiple de fotos, el comparador y el emparejado por contenido |
| `probar_solicitud.js` | Rol Hospital: el combo que no abría, las bandejas que se perdían al segundo guardado, «Enviar» solo después de guardar |
| `probar_columna.js` | La columna «Validación» del listado y su filtro |
| `probar_scroll.js` | El panel del combo: rodar la lista, rodar la página, abrir hacia arriba |
| `probar_ocrcat.js` | La galería del catálogo: avisar qué fotos no tienen texto y leerlas |
| `probar_galeria.js` | Los dos botones de cámara y galería en la hoja de consumo |
| `probar_valcam.js` | Los dos botones de cámara y galería en «Validar bandeja», y que subir bloquee las dos entradas |
| `probar_ajenas.js` | Que las fotos que no son de la bandeja se vean marcadas, con el resumen arriba y el borde en la miniatura. Y que la franja del piso se vea como **rechazo** —`Incorrecta`, en rojo— sin agregar «Se parece más a» cuando no hay candidato |
| `probar_tipocirugia.js` | Tipo de cirugía HDT/Transitoria: el panel de Configuración, la columna del listado y el combo del encabezado, con sus reglas de rol. Incluye la regla del servidor, leída del `index.js` real |
| `probar_impresion.js` | La hoja de consumo IMPRESA: los nueve tamaños de fuente en pt, que el estilo no vuelva a px, y que 24 líneas sigan entrando en una sola A4. Y los **dos formatos**: que «Imprimir» salga sin la columna CÓDIGO SIMA —y sin el código en ninguna parte del documento— mientras «Imprimir Código Sima» la lleve, que los anchos sumen 100 en las dos, que cada botón diga cuál de las dos quiere, y que olvidarse el argumento saque la de siempre |
| `probar_imprimir_proceso.js` | Que **imprimir no congele la aplicación**. Mete un bloqueo sincrónico de 3 s dentro de la ventana del imprimible y mide cuánto se detuvo el hilo de la app: con `window.open` normal daba **3005 ms**, con `noopener` da **51**. Comprueba además que esa ventana no tenga `opener`, que el documento cargue completo —el blob no se revoca antes— y que el aviso de «el navegador bloqueó la ventana» siga saliendo cuando corresponde y solo entonces. **Es la única que levanta un servidor http**: un Blob creado desde `file://` tiene origen opaco y ni `window.open` ni BroadcastChannel se portan como en producción |
| `probar_sima.js` | Códigos Sima: la API contra un Postgres real (los tres endpoints extraídos del `index.js`) más la pantalla. Cubre el «no se pueden agregar productos», las dos semánticas del campo vacío, el precio con coma decimal y que los TRES roles editan e importan —Hospital incluido— mientras un rol de fuera de los tres sigue recibiendo 403 |
| `probar_rol_impresion.js` | El rol **Impresión** (el kiosco del hospital). No comprueba una lista de endpoints: **enumera todos los `app.http()` del `index.js` real** y exige 403 en cada uno que no esté en la lista blanca, así que un endpoint nuevo que quede abierto al kiosco hace fallar esta prueba. Mide además el alcance —pendientes de cualquier fecha más los últimos 7 días, sin reemplazos— contra un Postgres de verdad y con los dos bordes de la ventana, el menú de los cuatro roles, la cola de impresión, la marca «impresa» y que **si la marca falla la hoja se imprime igual** |
| `probar_sima_modal.js` | Subir Excel de códigos Sima: que mientras la carga viaja ningún botón del modal reciba el clic —medido con `elementFromPoint`, no con «el overlay está visible»—, que al terminar bien el modal se cierre y lo rechazado pase a su propio modal, y que al fallar se quede abierto para reintentar |

## La regla que las hace valer

**Cada una se corrió primero contra el código ANTERIOR y tenía que fallar.**
Una prueba que pasa en verde contra el código roto no prueba nada — pasó dos
veces en esta sesión:

1. La de la marca de las fotos llamaba a `valMarcar()` directamente y pasaba
   contra el código con el bug. El bug estaba en lo que el DOM le pasaba a esa
   función, no en la función. Se rehizo para que **haga clic en la casilla**.
2. La del reseteo del wizard comprobaba contra una función que no existe
   (`nuevaHoja`) y daba OK sin comprobar nada. Ahora apunta a `openWizard()`
   y **falla si no la encuentra**.

Para comparar contra el código anterior:

```
git show HEAD:frontend/index.html > /tmp/antes.html
node probar_val.js /tmp/antes.html     # tiene que reportar los fallos
```

## Las que no son de navegador

### `probar_payload_dynamics.js` — el objeto que va a Dynamics

Tampoco usa navegador, y es la única que necesita una **base de verdad**. No
usa datos de mentira para la función: extrae el TEXTO de
`construirPayloadDynamics()` del `api/src/index.js` y lo corre contra un
PostgreSQL local con el esquema de las migraciones. Así se prueba el código que
se despliega, y las consultas se ejecutan contra columnas que existen: si
alguien renombra `TipoCirugia`, esta prueba se cae.

`probar_sima.js` y `probar_rol_impresion.js` funcionan igual y comparten ese
Postgres. La del rol Impresión además **corre las migraciones enteras** —todas
las de `database/`, en orden— antes de sembrar sus hojas, así que también avisa
si una migración dejó de aplicarse limpia sobre una base vacía:

```
node probar_rol_impresion.js ~/pgtest/run 5433
```

Necesita `pg` (`npm install pg`) y un Postgres corriendo. Para levantar uno
descartable dentro de la sesión, como usuario no-root:

```
export PGDATA=~/pgtest/pgdata PGBIN=/usr/lib/postgresql/16/bin
$PGBIN/initdb -D $PGDATA -U postgres --encoding=UTF8
$PGBIN/pg_ctl -D $PGDATA -o "-k ~/pgtest/run -p 5433 -c listen_addresses=''" start
node probar_payload_dynamics.js ~/pgtest/run 5433
```

El esquema y los datos los crea la prueba sola. Comprueba `Cirugia`, las cuatro
áreas de `Configuracion` con «transitoria» en minúscula, que el `Detalle` no
haya cambiado de forma, y que si falta la fila del área nueva no reviente.

### `probar_ajenas_motor.js` — el motor de comparación

`probar_ajenas_motor.js` sí está acá y se corre con node, sin navegador —y por
eso es la única que corre igual de bien en la máquina de Luis, desde la raíz del
repositorio—. Mide el clasificador de fotos ajenas y el piso del veredicto
contra el texto real de las fotos del Paso 0, así que necesita `paso0/ocr/` y
`paso0/catalogo_bandejas.json`:

```
node probar_ajenas_motor.js                       # contra api/src/comparar.js
node probar_ajenas_motor.js /tmp/comparar_antes.js  # contra otra versión
```

Lo que deja claro, y es la razón de ser del arreglo: contra el código anterior,
agregar UNA foto de la hoja de consumo a un juego de fotos buenas convertía una
`Correcta` de 1.000 en `No puedo determinarlo` de 0.194. La foto ajena no solo
daba un mensaje malo: contaminaba el puntaje.

Y desde el 9 de setiembre mide también **que el piso responda `Incorrecta` y no
una duda**. El caso que lo motivó: cinco fotos de documentos que no son
nuestros —un informe, una hoja de cálculo, una página web—, que las `HUELLAS`
no marcan porque están escritas sobre los rótulos que imprimimos nosotros. Las
paró el piso con 0.018, pero contestaba «No puedo determinarlo», y con eso la
pantalla ofrecía «Comparar y decidir»: alguien podía estampar «Confirmo que es
la NUT-…» sobre cinco fotos de papeles. Hay tres documentos ajenos de fixture
para ese camino, y un aserto que comprueba que **`MIN_PISO` sigue cayendo entre
el techo de lo ajeno y el puntaje legítimo más flojo** —hoy 0.000 y 0.309—,
porque ahora un falso positivo del piso no es una duda: es acusar a la
bandeja.

Las demás viven en `paso0/` y en el historial de la sesión; miden el motor de
comparación contra el texto real de las 51 fotos del catálogo:

- **el motor**: 12 de 12 bandejas Correcta con todas las fotos y con la mitad;
  10 y 2 dudas con una sola. 132 cruces de impostor, **cero** aprobaciones
  falsas.
- **el emparejado** (`parear()`): de 45 que se anima a emparejar, acierta 45.
  Las 6 que deja sin par son exactamente las que tienen texto idéntico a otra
  de su misma bandeja.

## Un aserto que cambió (10 de setiembre)

`probar_sima.js` daba por bueno que la cejilla **Código Sima** la ve cualquier
rol, porque su `ver` era `()=>true`. Con el rol **Impresión** eso dejó de ser
cierto a propósito: la cejilla pasó a los tres roles de la app y el kiosco no la
ve —un catálogo con precios no tiene nada que hacer en una máquina de pasillo—.
El aserto ahora espera lo contrario para un rol de fuera de los tres, y los
demás de esa suite siguen igual: **la pantalla no cambió**, sigue teniendo su
modo de solo lectura, y eso se prueba llamando a `showSima()` directo sin pasar
por el menú.
