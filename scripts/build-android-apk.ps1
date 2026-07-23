# Build a sideloadable Android APK (no Android Studio Run button needed).
# Requires: JDK 17+ and Android SDK (install Android Studio once, or command-line tools).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$native = Join-Path $root "apps\recorder-native"
$android = Join-Path $native "android"
$installDir = Join-Path $native "install"
$outApk = Join-Path $installDir "RNZ-Row-Recorder.apk"

Write-Host "==> Building native web bundle..." -ForegroundColor Cyan
Push-Location $root
npm run build:native -w recorder-pwa
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Capacitor sync android..." -ForegroundColor Cyan
Push-Location $native
npx cap sync android
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path (Join-Path $android "gradlew.bat"))) {
  Write-Host "Android project missing. Run: cd apps/recorder-native && npx cap add android" -ForegroundColor Red
  exit 1
}

Write-Host "==> Gradle assembleDebug (first run may take several minutes)..." -ForegroundColor Cyan
Push-Location $android
.\gradlew.bat assembleDebug
if ($LASTEXITCODE -ne 0) {
  Write-Host "Gradle failed. Install Android Studio and open the project once, or set ANDROID_HOME." -ForegroundColor Red
  exit $LASTEXITCODE
}

$built = Join-Path $android "app\build\outputs\apk\debug\app-debug.apk"
if (-not (Test-Path $built)) {
  $split = Get-ChildItem (Join-Path $android "app\build\outputs\apk\debug") -Filter "app-*-debug.apk" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($split) { $built = $split.FullName }
}
if (-not (Test-Path $built)) {
  Write-Host "APK not found at $built" -ForegroundColor Red
  exit 1
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item $built $outApk -Force

Write-Host ""
Write-Host "APK ready:" -ForegroundColor Green
Write-Host "  $outApk"
Write-Host ""
Write-Host "Install on Samsung S21:" -ForegroundColor Yellow
Write-Host "  1. Copy APK to phone (USB, Google Drive, or email)"
Write-Host "  2. On phone: open the APK file"
Write-Host "  3. Allow 'Install unknown apps' for Files/Drive if prompted"
Write-Host "  4. Open RNZ Row Recorder -> Settings -> Device ID -> Start session"
Write-Host ""

if (Get-Command explorer -ErrorAction SilentlyContinue) {
  explorer $installDir
}

Pop-Location
