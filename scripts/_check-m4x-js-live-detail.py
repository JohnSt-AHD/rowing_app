#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M4x JS"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


d = get("/api/devices?windowSec=600&onlineSec=3600&includeMetrics=1")
dev = next((x for x in d.get("devices", []) if x.get("deviceId") == UID), None)
print("=== devices ===")
if not dev:
    print("NOT FOUND")
    raise SystemExit(1)

for k in (
    "deviceId",
    "online",
    "lastSeenAgoSec",
    "reportingIntervalSec",
    "sessionId",
    "platform",
    "appVersion",
    "gpsProvider",
    "gpsSampleSource",
):
    if k in dev or dev.get(k) is not None:
        print(f"  {k}: {dev.get(k)}")

print("gps:", json.dumps(dev.get("gps"), indent=2))
print("nativePulse:", json.dumps(dev.get("nativePulse"), indent=2))
print("rowing:", json.dumps(dev.get("rowing"), indent=2))

mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
print("\n=== map position ===")
print(json.dumps(p, indent=2) if p else "none")

sid = dev.get("sessionId")
if sid:
    ing = get(f"/api/ingest?sessionId={urllib.parse.quote(sid)}&limit=20")
    samples = ing.get("samples") or []
    print(f"\n=== last {min(10, len(samples))} ingest samples ===")
    for s in samples[-10:]:
        gps = s.get("gps") or {}
        print(
            f"t={s.get('t')} gps spd={gps.get('spd')} acc={gps.get('acc')} "
            f"prov={gps.get('provider')} src={gps.get('sampleSource')} "
            f"fixMs={gps.get('fixMs')} hb={s.get('heartbeat')}"
        )
