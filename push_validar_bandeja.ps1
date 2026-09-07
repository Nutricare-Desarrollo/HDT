# Ubicarse en la carpeta del repositorio (donde vive este script).
Set-Location -Path $PSScriptRoot

# ============================================================================
#  Sube lo pendiente a main y con eso dispara el despliegue.
#
#  ESTE PUSH TRAE LA MIGRACION 33 (33_SolicitudValidacion.sql).
#  CORRELA CON psql ANTES DE SUBIR. Si el codigo se despliega primero, tocar
#  «Validar bandeja» da error 500: la API nombra tablas y columnas que
#  todavia no existirian.
#      psql "<tu-cadena-de-conexion>" -f database/33_SolicitudValidacion.sql
#  Es idempotente y no destructiva.
#
#  Y DESPUES, el texto ya leido de las 51 fotos del catalogo:
#      psql "<tu-cadena-de-conexion>" -f database/33b_EquipoFoto_texto.sql
#  Ese archivo NO SE VERSIONA, igual que 32b y 13b. Sin el, la validacion
#  contesta «No puedo determinarlo» en TODAS las bandejas hasta que alguien
#  vuelva a subir cada foto del catalogo: el texto se lee al subirla, y las 51
#  que ya estan cargadas entraron antes de que existiera esa lectura. Correrlo
#  ahorra volver a pagarle a Azure 51 lecturas que ya se hicieron.
#
#  QUE TRAE: la validacion de bandeja por foto, automatica.
#
#    - Boton «Validar bandeja» al lado de «Check list», en cada fila del grid
#      de bandejas de la solicitud.
#    - Bodega sube de 1 a N fotos de la bandeja alistada. Cada foto se LEE al
#      subirla (Azure Document Intelligence, prebuilt-read) y se guarda con su
#      texto; por eso el boton «Validar» contesta al instante.
#    - El veredicto es automatico y tiene TRES respuestas:
#          Correcta · Incorrecta · No puedo determinarlo
#      La tercera no es un adorno. Esta medido: no existe un umbral que separe
#      las bandejas buenas de las impostoras con estos datos, y una respuesta
#      binaria obligaria a inventarse una de las dos.
#    - Cuando el sistema duda o dice que no, la franja ofrece «Ver fotos lado a
#      lado»: pantalla completa, catalogo a la izquierda, lo alistado a la
#      derecha, de par en par. Ahi la persona decide, y su decision pisa a la
#      del sistema y queda con su nombre («lo dijo Bodega») sin borrar lo que
#      la maquina habia contestado.
#    - El color de la demarcacion es OPCIONAL: si Bodega lo dice y contradice
#      al catalogo, baja el veredicto; si no lo dice, se valida solo con la
#      foto. Asi lo pidio el requerimiento.
#
#  LO QUE NO HACE, a proposito:
#    - NO revisa que la bandeja este completa. No cuenta tornillos. Valida
#      IDENTIDAD: que la bandeja alistada sea la que se pidio.
#    - NO BLOQUEA el envio al hospital. Avisa, estampa el resultado en la
#      solicitud (Validada / Parcial / Sin validar) y lo manda en el correo.
#      Es la regla de la seccion 8.5, y esta medido: con el veredicto como
#      candado, 4 de las 12 bandejas del Paso 0 no se podrian despachar hoy, y
#      las 4 por errores del catalogo, no de la bandeja.
#    - NO re-valida cuando el equipo vuelve de cirugia.
#
#  MEDIDO CONTRA LOS DATOS REALES (las 12 bandejas fotografiadas del Paso 0):
#    - Con todas las fotos:      12 de 12 Correcta.
#    - Con la mitad de las fotos: 12 de 12 Correcta.
#    - Con una sola foto:        10 Correcta, 2 «No puedo determinarlo»
#      (la 0001330 y la 0001336: su primera foto es el recipiente plastico de
#       tornillos, que casi no tiene texto impreso).
#    - 132 cruces de impostor -las fotos de una bandeja pidiendo otra-:
#      132 rechazadas, CERO aprobaciones falsas.
#      El motor nunca aprobo una bandeja equivocada.
#
#  Toca api/src/index.js, api/src/layout.js, api/src/bitacora.js,
#  frontend/index.html y agrega api/src/comparar.js y
#  database/33_SolicitudValidacion.sql.
# ============================================================================

# --- 1. Solo frenan los archivos versionados con cambios sin commitear ------
$estado     = git status --porcelain -- api frontend database
$sucio      = $estado | Where-Object { $_ -notmatch '^\?\?' }
$sinVersion = $estado | Where-Object { $_ -match '^\?\?' }

if ($sucio) {
    Write-Host "Hay cambios sin commitear en archivos versionados de api/, frontend/ o database/:" -ForegroundColor Yellow
    $sucio
    Write-Host "Commitealos o descartalos antes de correr este script." -ForegroundColor Yellow
    exit 1
}

if ($sinVersion) {
    Write-Host "Aviso: hay archivos sin versionar. NO se van a subir:" -ForegroundColor DarkYellow
    $sinVersion
    Write-Host ""
}

# --- 2. Tiene que estar en main ---------------------------------------------
$rama = git rev-parse --abbrev-ref HEAD
if ($rama -ne 'main') {
    Write-Host "Estas en la rama '$rama', no en main." -ForegroundColor Yellow
    Write-Host "Corre 'git checkout main' y volve a ejecutar este script." -ForegroundColor Yellow
    exit 1
}

# --- 3. Que hay pendiente ---------------------------------------------------
git fetch origin --quiet

$atras = git log --oneline main..origin/main
if ($atras) {
    Write-Host "OJO: origin/main tiene commits que tu main no tiene:" -ForegroundColor Red
    $atras
    Write-Host "Corre 'git pull --rebase origin main' antes de subir. NO uses push --force." -ForegroundColor Red
    exit 1
}

$porSubir = git log --oneline origin/main..main
if (-not $porSubir) {
    Write-Host "No hay nada pendiente por subir. main y origin/main estan iguales." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "Por subir:" -ForegroundColor Cyan
$porSubir
Write-Host ""
git diff origin/main..main --stat
Write-Host ""

# --- 4. Migraciones que traen los commits por subir -------------------------
$migraciones = git diff --name-only --diff-filter=A origin/main..main -- 'database/*.sql'
if ($migraciones) {
    Write-Host "OJO: estos commits agregan migraciones de base:" -ForegroundColor Yellow
    $migraciones | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "Corralas con psql ANTES de subir. Si el codigo se despliega primero," -ForegroundColor Yellow
    Write-Host "tocar «Validar bandeja» da error 500." -ForegroundColor Yellow
    Write-Host ""
    $okMig = Read-Host "Ya las corriste todas en la base? (s/n)"
    if ($okMig -notmatch '^\s*[syY]') {
        Write-Host "Respuesta: '$okMig' -> se entiende como NO." -ForegroundColor Yellow
        Write-Host "Corre las migraciones y volve a ejecutar este script:" -ForegroundColor Yellow
        $migraciones | ForEach-Object { Write-Host "    psql `"<tu-cadena-de-conexion>`" -f $_" -ForegroundColor Yellow }
        exit 1
    }
} else {
    Write-Host "Estos commits no agregan migraciones de base." -ForegroundColor DarkGray
}

# --- 5. Recordatorio del texto ya leido -------------------------------------
Write-Host ""
if (Test-Path 'database/33b_EquipoFoto_texto.sql') {
    Write-Host "FALTA UNO MAS. El texto ya leido de las 51 fotos del catalogo" -ForegroundColor Yellow
    Write-Host "(archivo sin versionar). Sin el, TODAS las bandejas contestan" -ForegroundColor Yellow
    Write-Host "«No puedo determinarlo»:" -ForegroundColor Yellow
    Write-Host "    psql `"<tu-cadena-de-conexion>`" -f database/33b_EquipoFoto_texto.sql" -ForegroundColor Yellow
    Write-Host ""
    $okTxt = Read-Host "Ya lo corriste? (s/n)"
    if ($okTxt -notmatch '^\s*[syY]') {
        Write-Host "Respuesta: '$okTxt' -> se entiende como NO." -ForegroundColor Yellow
        Write-Host "Correlo y volve a ejecutar este script." -ForegroundColor Yellow
        exit 1
    }
    Write-Host ""
}

# --- 6. Las llaves de Document Intelligence ---------------------------------
# La lectura de las fotos de la entrega usa el mismo recurso que ya lee las
# hojas de consumo. Si esas dos App Settings no estan puestas, la foto SE SUBE
# igual -queda como evidencia- pero sin texto, y el veredicto sera siempre
# «No puedo determinarlo».
Write-Host "Recorda que DOCINTEL_ENDPOINT y DOCINTEL_KEY tienen que estar en las" -ForegroundColor DarkGray
Write-Host "App Settings de la Function App. Son las mismas que ya lee el wizard." -ForegroundColor DarkGray
Write-Host ""

# --- 7. Confirmacion --------------------------------------------------------
$ok = Read-Host "Confirmas el push a main (dispara el despliegue)? (s/n)"
if ($ok -notmatch '^\s*[syY]') {
    Write-Host "Respuesta: '$ok' -> se entiende como NO. Cancelado." -ForegroundColor Yellow
    exit 0
}

# --- 8. Push ----------------------------------------------------------------
git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "El push fallo." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Listo. El push dispara GitHub Actions y despliega a produccion." -ForegroundColor Green
Write-Host ""
Write-Host "Para probarlo:" -ForegroundColor Green
Write-Host "  1. Entra a una solicitud en alisto con la NUT-0001330." -ForegroundColor Green
Write-Host "  2. En la fila de la bandeja, toca «Validar bandeja»." -ForegroundColor Green
Write-Host "  3. Subi 2 o 3 fotos del equipo alistado, con las etiquetas visibles." -ForegroundColor Green
Write-Host "  4. Toca «Validar bandeja». Tiene que contestar en el momento." -ForegroundColor Green
Write-Host "  5. Si dice «Incorrecta» o «No puedo determinarlo», toca" -ForegroundColor Green
Write-Host "     «Ver fotos lado a lado» y compara vos mismo." -ForegroundColor Green
Write-Host ""
Write-Host "Y para ver que NO se traga una equivocada: valida la NUT-0001330 con" -ForegroundColor Green
Write-Host "fotos de la NUT-0001332. Tiene que decir «Incorrecta»." -ForegroundColor Green
