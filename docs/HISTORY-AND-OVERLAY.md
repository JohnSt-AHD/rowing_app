# Historical data + traccar-overlay

## 1. Enable Postgres on Vercel

1. Open **rowing_app** on Vercel → **Storage** → **Create Database** → **Postgres** (or connect Neon).
2. Link `POSTGRES_URL` to the project (automatic when created via Vercel Storage).
3. Redeploy.

Tables are created automatically on first ingest (`api/lib/db.js`).

Optional: run `scripts/schema.sql` in the SQL console.

## 2. Phone (unchanged)

```
Ingest API URL: https://rowing-app-recorder-pwa.vercel.app/api/ingest
Device ID:      CREW-01
```

All samples are appended to Postgres.

## 3. APIs

| Endpoint | Purpose |
|----------|---------|
| `GET /api/snapshot` | Live map — Traccar-shaped `{ devices, positions }` |
| `GET /api/history?deviceId=1&from=ISO&to=ISO` | Route replay (overlay history charts) |
| `GET /api/history?list=sessions&uniqueId=CREW-01` | Past sessions list |
| `GET /api/ingest?sessionId=…` | Full session samples |

Numeric `deviceId` in snapshot is assigned in `rnz_devices` when the device first ingests.

## 4. traccar-overlay

On the **hub main page** (`index.html`), use **Settings → Position data source** to switch between **Traccar** and **CrewSight**. The choice is saved in the browser and sent as `?source=traccar` or `?source=rowing` on every `/api/traccar` request.

In **traccar-overlay** Vercel env:

```
ROWING_TRACKER_URL=https://rowing-app-recorder-pwa.vercel.app
ROWING_INGEST_TOKEN=<same as INGEST_TOKEN on rowing app, if used>
```

When `ROWING_TRACKER_URL` is set:

- `?action=snapshot` → rowing `/api/snapshot` (live map)
- `?action=route` → rowing `/api/history` (historical track)
- `?action=auth` → succeeds without Traccar login

Leave `TRACCAR_*` unset to use rowing only. Set both only if you want Traccar for some pages and rowing for others (snapshot/route prefer rowing when URL is set).

## 5. Dashboard

`dashboard.html` — live rates (memory + same ingest).

Overlay maps — live + history from Postgres via snapshot/route.

## 6. Capsize explainer (simulation, not live)

Standalone static page on the CrewSight recorder host:

- Local: http://localhost:5173/capsize-explainer.html
- Files: `apps/recorder-pwa/public/capsize-explainer.html` (+ `.css` / `.js`)
- In-memory only — no ingest, tokens, or production writes.

**traccar-overlay change (sibling repo):** `public/rowsafe-map.html` now has a **How capsize alerts work (simulation)** link in the header, capsize panel, and footer. Localhost RowSafe points at `:5173`; deployed RowSafe points at `https://rowing-app-recorder-pwa.vercel.app/capsize-explainer.html`.
