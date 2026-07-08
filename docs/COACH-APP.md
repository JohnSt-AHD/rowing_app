# CrewSight Manager (native app)

Android app for coaches to watch fleet GPS, stroke rate, and capsize alerts while on the water. The web dashboard is at `/dashboard` on your deployment; this native app adds **background capsize alerts** while monitoring is on.

## Features (v0.1)

- **Start / Stop monitoring** — background work only runs while monitoring is ON
- **Background capsize alerts** — native service polls `/api/devices`; notification + sound when any boat capsizes
- **Live map** — fleet positions from `/api/positions` (when app is open)
- **History** — session list, GPS trace, speed vs time, speed vs distance

Uses the same **API base URL** and **ingest token** as the rower app and web CrewSight Manager dashboard.

## Download

**Android (background capsize alerts):**  
**https://github.com/JohnSt-AHD/rowing_app/releases/download/android-apk-manager-latest/CrewSight-Manager.apk**

**iPhone / iPad / browser (PWA):**  
**https://rowing-app-recorder-pwa.vercel.app/manager/** — open in Safari → Share → **Add to Home Screen**. Live map and history while the app is open; no background capsize alerts (use Android APK for that).

Install page: **https://rowing-app-recorder-pwa.vercel.app/install-native.html**

Build status: [Android APK (CrewSight Manager)](https://github.com/JohnSt-AHD/rowing_app/actions/workflows/android-apk-coach.yml)

## Dev

```bash
npm install
node scripts/sync-brand-assets.mjs
npm run dev:coach          # web preview (no background alerts)
npm run build:coach:native
npm run coach:sync         # build web + cap sync android
cd apps/coach-native/android && ./gradlew assembleDebug
```

## Monitoring OFF vs ON

| State | Background poll | Status bar | Capsize alerts |
|-------|-----------------|------------|----------------|
| OFF   | No              | No         | No             |
| ON    | Yes (~3 s)      | CrewSight icon | Yes |

Stop via in-app **Stop monitoring** or the notification **Stop monitoring** action.

## Package

- App ID: `nz.org.rowing.coach` (unchanged — existing installs keep working)
- Native plugin: `CoachMonitor`
