# Testing the rowing recorder (ingest-only)

Deployment: **https://rowing-app-recorder-pwa.vercel.app**

## CI gate (must-pass, no phone)

`.github/workflows/ci.yml` on push/PR to main: `npm ci` → `npm run build` → API module load → `npm run test:smoke`.

| Check | What it blocks |
|-------|----------------|
| `test-gps-live-reporting.mjs --quick` | 4.6 km / 30s teleport bypass; 1 Hz car/row trails chopped; last-known shown as live |
| `test-gps-capsize-scenarios.mjs --quick` | Capsize not sticky; phone upright clearing Manager; Stop still moving the pin |
| `test-session-resume.mjs` | Screen-off / reopen dropping a live session, or resuming a stopped one |
| `test-geofence-session.mjs --quick` | Lake vs park polarity; auto-start/stop; empty org no-op; pause-only does not stop |
| API `require()` | ingest / history / capsize-clear / gps-outlier / ingest-store fail to load |

`--quick` skips production fetches and 32s/61s wall-clock waits (CI minutes stay small). Local gold: `npm run test:gps` (John + rnz history) and `npm run test:capsize` (full waits). Overlay JSON (4 Jun H6) is optional — if present next to the repo, live-reporting asserts the reconstructed 1 Hz car trail is kept.

### Invariants we must never break

1. **1 Hz trail kept in car** — ~25 m / 1 s (90 km/h) and a 10-minute 28 m/s trail stay on the map.
2. **No 4.6 km / 30 s leap** — speed × dt always applies after a hole; the old `dt>30` / `dt>120` bypass must not return.
3. **Capsize sticky until safe** — tip stays active after the phone rights; only manager/RowSafe “crew is safe” or athlete I’m OK clears it.
4. **Stop ends the session** — further GPS for that `sessionId` is ignored; the pin does not jump.

## Live checklist (John / empty token)

After a GPS or capsize change, drive or walk with Device ID matching a known empty-token boat, then:

1. Start session → Manager pin moves at ~1 Hz (no chopped trail in **car** interpretation).
2. Indoor / GPS hole ~30 s → pin **pauses** (amber/lost from satellite age, not HTTP-live); a 4 km leap on regain is **rejected**.
3. Nearby walk/drive resume → pin continues, badge live again.
4. Tip phone → Manager sticky **active**; right the phone → still sticky; I’m OK or Crew is safe → cleared. Stop → session `ended_at`, later GPS ignored.

June 4 H6 overlay (sibling `traccar-overlay` / `Drone_CV` JSON) is the gold 1 Hz drive for `npm run test:gps`.

---

## Step 1 — Connection test

```
https://rowing-app-recorder-pwa.vercel.app/test.html
```

| Button | Expect |
|--------|--------|
| 1. Ping API | `{"ok":true,...}` |
| 2. Test ingest | `{"ok":true,"received":1}` |
| 3. List devices | Device in list |
| 4. GPS positions | `"positions":[{...}]` |

## Step 2 — Phone settings

| Field | Value |
|-------|--------|
| Device ID | `TEST-PHONE-01` |
| Ingest API URL | `https://rowing-app-recorder-pwa.vercel.app/api/ingest` |
| Ingest token | (if `INGEST_TOKEN` set in Vercel) |

No Traccar fields.

## Step 3 — Record

Save → **Start session** → allow location → watch **Log** for `Upload: N sent, 0 failed`.

## Step 4 — Dashboard

```
https://rowing-app-recorder-pwa.vercel.app/dashboard.html
```

## Step 5 — Positions API (map source)

```
https://rowing-app-recorder-pwa.vercel.app/api/positions
```

Use this instead of Traccar for live maps.
