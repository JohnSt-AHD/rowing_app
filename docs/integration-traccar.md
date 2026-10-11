# Traccar + traccar-overlay integration

## PWA → Traccar

1. Create device in Traccar with **Unique ID** = PWA **Device ID**.
2. Set **Traccar URL** to server root (e.g. `https://traccar.example.com`). Port `5055` is applied for OsmAnd if omitted.
3. GPS fixes include optional attributes: `hr`, `ax`, `ay`, `az`.

## PWA → Ingest API

`POST /api/ingest` with JSON body:

```json
{
  "sessionId": "uuid",
  "deviceId": "CREW-01",
  "athleteId": "optional",
  "samples": [{ "t": 1710000000000, "gps": {}, "motion": {}, "hr": {} }]
}
```

`GET /api/ingest?sessionId=uuid` returns stored samples (for overlay extensions).

## traccar-overlay

No code changes required for GPS-only: existing map polls Traccar `/api/positions` via your proxy.

Recommended live event settings:

- PWA GPS interval: **1000–3000 ms** (product default is 10 s; tighten for denser live tracks)
- Overlay map refresh: **3–5 s**
