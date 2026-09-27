#!/usr/bin/env python3
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICE = "M1x TM"
SID = "315e22f9-3c4e-4a56-a82c-6d308f1623cd"
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# Poll fixAge for 2 min
print("=== fixAge watch (40 x 3s) ===")
ages = []
fix_ages = []
for i in range(40):
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
    if pos:
        ages.append(pos.get("fixAgeSec"))
        fix_ages.append(pos.get("displayFixAgeSec"))
        if (pos.get("fixAgeSec") or 0) >= 8:
            print(
                i,
                "SPIKE fixAge",
                pos.get("fixAgeSec"),
                "display",
                pos.get("displayFixAgeSec"),
                "lastSeen",
                pos.get("lastSeenAgoSec"),
            )
    time.sleep(3)
if ages:
    print(
        f"fixAge min={min(ages)} med={statistics.median(ages):.1f} max={max(ages)}"
        f" ge8={sum(1 for a in ages if a>=8)} ge10={sum(1 for a in ages if a>=10)}"
    )

# Segment speed vs displayed speed on recent fixes
dash = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(SID))
track = dash.get("track") or []
now_ms = int(datetime.now(AUCKLAND).timestamp() * 1000)
gps = sorted(
    [p for p in track if p.get("lat") and p["t"] >= now_ms - 30 * 60 * 1000],
    key=lambda x: x["t"],
)
print(f"\n=== Last 30m segment speeds ({len(gps)} fixes) ===")
segs = []
for i in range(1, len(gps)):
    dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
    dist = haversine_m(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
    if dt <= 0:
        continue
    segs.append({"dt": dt, "dist": dist, "spd": dist / dt})
    if 8 <= dt <= 25:
        print(
            f"  gap {dt:.1f}s dist {dist:.1f}m implied {dist/dt:.2f} m/s",
            datetime.fromtimestamp(gps[i]["t"] / 1000, tz=AUCKLAND).strftime("%H:%M:%S"),
        )

normal = [s for s in segs if 2 <= s["dt"] <= 5]
print(
    f"normal 2-5s gaps: n={len(normal)}"
    f" median_spd={statistics.median([s['spd'] for s in normal]):.2f} m/s"
    f" ({statistics.median([s['spd'] for s in normal])*1.94384:.1f} split)"
)
slow = [s for s in segs if s["dt"] > 8]
print(f"gaps >8s: {len(slow)}")

# Compare API path vs display speed now
mp = get("/api/map-positions?onlineSec=600&staleSec=3600&predictMode=rowing")
pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
print("\n=== Speed fields now ===")
print(json.dumps({k: pos.get(k) for k in [
    "speed", "displaySpeedMps", "pathSpeedMps", "pathPaceWindowSec",
    "course", "fixAgeSec", "smoothFixAgeSec", "displayFixAgeSec"
]}, indent=2))

# Raw phone speed if in recent samples - check ingest tail
raw = get("/api/ingest?sessionId=" + urllib.parse.quote(SID))
samples = [s for s in (raw.get("samples") or []) if s.get("gps")][-20:]
phone_spd = [s["gps"].get("spd") for s in samples if s["gps"].get("spd") is not None]
print(f"\nPhone gps.spd in last 20 uploads: {phone_spd[-5:] if phone_spd else 'none'}")
