# Build a sideloadable Android APK (no Android Studio Run button needed).
# Requires: JDK 17+ and Android SDK (install Android Studio once, or command-line tools).
$ErrorActionPreference = "Stop"

function Test-JavaHome([string]$javaHome) {
  if ([string]::IsNullOrWhiteSpace($javaHome)) { return $false }
  $java = Join-Path $javaHome.TrimEnd('\') "bin\java.exe"
  return Test-Path $java
}

function Resolve-JavaHome {
  param([string]$Preferred)

  if (Test-JavaHome $Preferred) { return $Preferred.TrimEnd('\') }

  $searchRoots = @(
    "$env:ProgramFiles\Microsoft\jdk*",
    "$env:ProgramFiles\Eclipse Adoptium\jdk*",
    "$env:ProgramFiles\Java\jdk*",
    "$env:ProgramFiles\Android\Android Studio\jbr",
    "$env:LOCALAPPDATA\Programs\Eclipse Adoptium\jdk*",
    "$env:LOCALAPPDATA\Programs\Android\Android Studio\jbr"
  )

  $found = [System.Collections.Generic.List[string]]::new()
  foreach ($pattern in $searchRoots) {
    Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | ForEach-Object {
      if (Test-JavaHome $_.FullName) { [void]$found.Add($_.FullName) }
    }
  }

  if ($found.Count -eq 0) { return $null }
  return ($found | Sort-Object Name -Descending | Select-Object -First 1)
}

$resolvedJavaHome = Resolve-JavaHome $env:JAVA_HOME
if (-not $resolvedJavaHome) {
  Write-Host "No JDK found. Install JDK 17+ or Android Studio, or set JAVA_HOME." -ForegroundColor Red
  exit 1
}
if ($env:JAVA_HOME -ne $resolvedJavaHome) {
  Write-Host "Using JAVA_HOME: $resolvedJavaHome" -ForegroundColor Yellow
  $env:JAVA_HOME = $resolvedJavaHome
}

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
$gradleHomeArg = "-Dorg.gradle.java.home=$resolvedJavaHome"
.\gradlew.bat assembleDebug $gradleHomeArg "-Dorg.gradle.java.installations.auto-download=false"
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
