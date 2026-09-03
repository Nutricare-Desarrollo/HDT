# Ubicarse en la carpeta del repositorio (donde vive este script).
Set-Location -Path $PSScriptRoot

# ============================================================================
#  Sube a main lo que este pendiente. El push dispara GitHub Actions y
#  despliega a produccion. Se puede correr las veces que haga falta.
#
#  MIGRACIONES
#  El script detecta solo los archivos database/*.sql que traen los commits
#  por subir y los lista antes de preguntar. Si aparece alguno, corralo con
#  psql ANTES de aceptar el push: desplegar codigo que nombra columnas o
#  tablas que no existen deja esa pantalla dando error 500.
#
#  OJO CON REEJECUTAR UNA MIGRACION YA APLICADA
#  21_BandejaCatalogo.sql hace ON CONFLICT DO UPDATE SET Cantidad, asi que
#  correrla otra vez devuelve a los valores de SharePoint cualquier cantidad
#  que Bodega haya corregido desde la pantalla. Si hay que reejecutarla,
#  comente el bloque 3 (Detalle de productos) del archivo .sql.
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
# Solo los .sql AGREGADOS (--diff-filter=A): los modificados no son
# migraciones nuevas que haya que aplicar.
$migraciones = git diff --name-only --diff-filter=A origin/main..main -- 'database/*.sql'
if ($migraciones) {
    Write-Host "Estos commits agregan migraciones de base:" -ForegroundColor Yellow
    $migraciones | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
    Write-Host ""
    Write-Host "Corralas con psql ANTES de subir. Si el codigo se despliega primero," -ForegroundColor Yellow
    Write-Host "la pantalla que dependa de esas columnas da error 500." -ForegroundColor Yellow
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

# --- 5. Confirmacion --------------------------------------------------------
# Acepta s, si, S, y, yes... cualquier cosa que empiece con s o y.
$ok = Read-Host "Confirmas el push a main (dispara el despliegue)? (s/n)"
if ($ok -notmatch '^\s*[syY]') {
    Write-Host "Respuesta: '$ok' -> se entiende como NO. Cancelado." -ForegroundColor Yellow
    exit 0
}

# --- 6. Push ----------------------------------------------------------------
git push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "El push fallo." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Listo. El push dispara GitHub Actions y despliega a produccion." -ForegroundColor Green
Write-Host "Segui la corrida en Actions y despues probalo en la app." -ForegroundColor Green
