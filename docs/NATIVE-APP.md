# CrewSight — native app (Capacitor)

The native shell wraps the same Vite UI as the PWA but uses **native GPS, accelerometer, and BLE** so recording continues with the screen locked (especially on iOS).

## Architecture

```
apps/recorder-native/     Capacitor project (ios/ + android/)
apps/recorder-pwa/        Shared UI + session logic
packages/sensor-adapters/ web vs native sensor implementations
```

Server-side ingest, Postgres, and fleet dashboard are **unchanged** — phones still POST to `/api/ingest`.

## Easy install on Android (Samsung, etc.) — no USB

You do **not** need Android Studio on your phone. Pick one:

### A) Direct download link (Samsung / Android)

**https://github.com/JohnSt-AHD/rowing_app/releases/download/android-apk-latest/CrewSight.apk** (~10 MB arm64 build)

Install page: **https://rowing-app-recorder-pwa.vercel.app/install-native.html**

(Vercel `/downloads/…` redirects to GitHub — do not use old 40 MB universal APKs.)

Install steps and Samsung “stuck at 100%” help: [install-native.html](https://rowing-app-recorder-pwa.vercel.app/install-native.html)

If the link 404s, open [Releases](https://github.com/JohnSt-AHD/rowing_app/releases/tag/android-apk-latest) or run **Actions → Android APK → Run workflow**, wait ~5 min, then try again.

### B) Download APK from GitHub Actions artifact

Requires **Android Studio installed once** (for the Android SDK), then:

```powershell
cd c:\path\to\Rowing_App
npm install
npm run native:apk
```

This creates:

`apps/recorder-native/install/CrewSight.apk`

Copy that file to the phone and tap it to install. Windows Explorer opens the folder when done.

### Upload fails with “Failed to fetch”

1. **Settings → Ingest API URL** must be exactly:  
   `https://rowing-app-recorder-pwa.vercel.app/api/ingest`  
   (not `localhost` — the native WebView uses `https://localhost` internally.)
2. Tap **Test upload connection** (v1.0.2+). You should see `OK — server received …`.
3. **Ingest token** — leave empty unless you set `INGEST_TOKEN` on Vercel (then use the same token).
4. Install APK **v1.0.2** or newer (uses Android native HTTP instead of WebView `fetch`).

## After install (Samsung S21)

1. **Settings → Apps → CrewSight → Battery** → **Unrestricted**
2. **Location** → **Allow all the time**
3. In the app: **Settings** → Device ID → **Start session**

---

## Developer workflow (Android Studio / USB)

| Tool | Android | iOS |
|------|---------|-----|
| Node 20 | ✓ | ✓ |
| Android Studio | ✓ (or use APK install above) | — |
| Xcode (Mac) | — | ✓ |

From repo root:

```bash
npm install
npm run native:sync          # build native web bundle + cap sync both platforms
npm run native:android       # open Android Studio
npm run native:ios           # open Xcode (Mac only)
```

Or from `apps/recorder-native`:

```bash
npm run sync
npm run open:android
```

## First-time platform setup

```bash
cd apps/recorder-native
npx cap add android
npx cap add ios          # Mac only
npm run sync
```

## iOS background modes (required)

After `npx cap add ios`, open **Xcode → App target → Signing & Capabilities**:

1. **+ Capability → Background Modes**
   - ☑ Location updates
   - ☑ Uses Bluetooth LE accessories (if using HR)

2. **Info.plist** usage descriptions (Capacitor may add some; verify):

| Key | Example text |
|-----|----------------|
| `NSLocationAlwaysAndWhenInUseUsageDescription` | Track boat position during rowing sessions, including when the screen is locked. |
| `NSLocationWhenInUseUsageDescription` | Track boat position during rowing sessions. |
| `NSMotionUsageDescription` | Measure stroke rate and detect capsize from boat motion. |
| `NSBluetoothAlwaysUsageDescription` | Connect to a heart rate chest strap. |

3. On first session, iOS will prompt for location — choose **Allow While Using**, then upgrade to **Always** when prompted (needed for background GPS).

## Android permissions

`cap sync` merges permissions from Capacitor plugins. The app also declares:

- `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION` (Android 10+ — choose **Allow all the time**)
- `POST_NOTIFICATIONS` (Android 13+ — required for background GPS notification)
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (system prompt for **Unrestricted** / not optimized battery)

On **Start session** (and **Settings → Phone permissions & battery**), the native app walks through:

1. Notifications allow prompt (Android 13+)
2. Location while using (precise)
3. Location **all the time** prompt (Android 10+), or the app info screen if the OS requires it
4. Battery optimization exemption dialog (Unrestricted)

Android does not allow apps to toggle these silently — the user must confirm each system screen.
- `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_LOCATION`
- `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` (Android 12+)

`capacitor.config.ts` sets `android.useLegacyBridge: true` so location + uploads keep working with the foreground-service GPS plugin.

## Sensor adapters

| Build | Command | Sensors |
|-------|---------|---------|
| Web PWA | `npm run build:app` | Browser geolocation, DeviceMotion, Web Bluetooth |
| Native | `npm run build:native -w recorder-pwa` | Native GPS + BLE; motion via Capacitor Motion (DeviceMotion in WebView) |

**Background recording (v1.0.7+):** With **Allow background** enabled in Settings, GPS uses `@capacitor-community/background-geolocation` — Android shows a persistent notification and keeps tracking when the screen is off. Do **not** swipe the app away from recents; set battery to **Unrestricted** on Samsung.

**Capsize / stroke with screen off (v1.0.10+):** When **Allow background** and **GPS** are both on, motion uses the native accelerometer (`@capgo/capacitor-accelerometer`) so capsize and stroke rate can keep running while the screen is locked (Android, with the GPS notification active). Enable **Accelerometer** in session settings. Without GPS background, motion may still pause when the screen is off — keep GPS on for reliable capsize alerts.

**Capsize alarm when minimized (v1.0.11+):** On capsize, the app posts a **high-priority notification** (sound + vibration) so you are alerted when the screen is off or another app is in front. Allow **Notifications** for CrewSight. In-app beeps still play when the app is visible.

**Native capsize monitor (v1.0.14+):** With **Allow background** + **Accelerometer**, a separate **Android foreground service** watches the accelerometer and **POSTs capsize directly to ingest** (for the fleet monitor) even when the WebView is paused. You will see a second notification: “RNZ capsize monitor active”. Hold the boat still ~3s at session start to calibrate (or let the native service self-calibrate).

**Upload rate with accelerometer:** Motion is analyzed at full rate (e.g. 50 ms) on the phone, but when GPS is also enabled, upload samples are only queued on each GPS fix (~1/s) with the latest accel + stroke/capsize attached. That keeps the outbox small so uploads do not stall. Without GPS, motion uploads are throttled (default 500 ms) via **Motion upload interval** in Settings.

Vite `--mode native` sets `VITE_PLATFORM=native` and aliases `@rowing/sensor-adapters` to the Capacitor implementation.

## TestFlight / distribution

1. `npm run native:sync`
2. Open Xcode → **Product → Archive**
3. Upload to App Store Connect → **TestFlight**
4. Crew installs via TestFlight link

Android: **Build → Generate Signed Bundle** in Android Studio, or sideload debug APK for testing:

```bash
npm run run:android -w recorder-native
```

## Phone settings

Same as PWA:

- **Ingest URL:** `https://rowing-app-recorder-pwa.vercel.app/api/ingest`
- **Device ID:** e.g. `G1`, `CREW-01`
- Enable **Background recording** and **Keep screen on** in app Settings (still useful on Android)

## Troubleshooting

| Issue | Fix |
|-------|-----|
| GPS stops when locked | Grant **Always** location + notifications; enable **Allow background** in app Settings; install v1.0.7+ APK; Samsung → battery **Unrestricted** |
| GPS stops when locked (iOS) | Background Modes → Location updates; grant **Always** location |
| App “closed” / swiped away | Android may kill the app — leave recording running and use the GPS notification to return; do not force-stop |
| No stroke rate | Motion permission; verify native build (`Native app` in header) |
| No capsize when screen off | Install v1.0.10+ APK; enable **Allow background**, **GPS**, and **Accelerometer**; battery **Unrestricted**; do not swipe app away |
| No capsize *alarm* when screen off | Install v1.0.13+ APK; Settings → **Request location & notification access**; allow **Notifications**; enable **GPS** + **Allow background**; alarm is a system notification (not in-app sound) |
| No capsize *detection* when screen off | Install v1.0.14+; enable **Allow background** + **Accelerometer**; check Log for `Native capsize monitor on`; hold boat still ~3s at start |
| Monitor no capsize when phone minimized | v1.0.14+ native service uploads capsize to ingest without WebView; same ingest URL/token in Settings |
| No accelerometer permission prompt | Normal on Android — accelerometer is usually auto-granted; check Log for `accelerometer: granted`. Use **Notifications** prompt for capsize alarms |
| HR won't connect | Bluetooth permission; tap **Connect HR strap** before launching |
| White screen after sync | Run `npm run build:web -w recorder-native` first — `webDir` must contain `index.html` |

## Vercel vs native

| Component | Hosted on |
|-----------|-----------|
| Recorder UI in native app | Bundled in IPA/APK |
| `/api/ingest`, dashboard, Postgres | Vercel (unchanged) |
| traccar-overlay | Separate Vercel project |

Do **not** point Capacitor `server.url` at production for normal use — the app should run offline-capable UI with network only for uploads.
