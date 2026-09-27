#!/usr/bin/env python3
"""Drive session fd472428 — GPS vs motion samples, geofences, device settings."""
import json
import statistics
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
UID = "M4x JS"
NZ = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


enc = urllib.parse.quote(UID)
sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
meta = next(s for s in sessions if s["session_id"].startswith("fd472428"))
sid = meta["session_id"]
tr = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}").get("track") or []

print("=== Session", sid[:8], "===")
st = datetime.fromisoformat(meta["started_at"].replace("Z", "+00:00")).astimezone(NZ)
en = datetime.fromisoformat(meta["ended_at"].replace("Z", "+00:00")).astimezone(NZ)
print(f"start={st} end={en} track={len(tr)} meta_samples={meta.get('sample_count')}")

with_gps = [p for p in tr if p.get("lat") is not None]
no_gps = [p for p in tr if p.get("lat") is None]
print(f"with lat: {len(with_gps)}  without lat: {len(no_gps)}")

if len(tr) > 1:
    all_gaps = [(tr[i]["t"] - tr[i - 1]["t"]) / 1000 for i in range(1, len(tr))]
    print(f"all-sample gap med={statistics.median(all_gaps):.2f}s")

if len(with_gps) > 1:
    gps_gaps = [(with_gps[i]["t"] - with_gps[i - 1]["t"]) / 1000 for i in range(1, len(with_gps))]
    print(f"gps gap med={statistics.median(gps_gaps):.2f}s top={Counter(round(g,1) for g in gps_gaps).most_common(5)}")

# sample fields on first few points
for label, pts in [("gps", with_gps[:3]), ("no-gps", no_gps[:3])]:
    print(f"\n--- {label} sample keys ---")
    for p in pts:
        keys = sorted(k for k in p.keys() if p.get(k) is not None)
        print(f"  t={datetime.fromtimestamp(p['t']/1000, NZ).strftime('%H:%M:%S')} keys={keys}")

# geofence bounds
print("\n=== Geofences ===")
for g in get("/api/geofences").get("geofences") or []:
    eco = g.get("economyIntervalSec") or g.get("economyGpsIntervalSec")
    stype = g.get("shapeType", "circle")
    if stype == "polygon":
        ring = g.get("polygonCoords") or []
        lats = [c[0] for c in ring]
        lons = [c[1] for c in ring]
        print(
            f"{g['name']}: poly eco={eco}s "
            f"lat {min(lats):.5f}..{max(lats):.5f} lon {min(lons):.5f}..{max(lons):.5f}"
        )
    else:
        print(
            f"{g['name']}: circle r={g.get('radiusM')} eco={eco}s "
            f"({g.get('centerLat')},{g.get('centerLon')})"
        )

# device registry if available
for path in (
    f"/api/devices?uniqueId={enc}",
    f"/api/map-positions?uniqueId={enc}",
    "/api/devices",
):
    try:
        d = get(path)
        print(f"\n=== {path.split('?')[0]} ===")
        if isinstance(d, dict):
            if "devices" in d:
                dev = next((x for x in d["devices"] if x.get("uniqueId") == UID or x.get("unique_id") == UID), None)
                if dev:
                    print(json.dumps(dev, indent=2)[:2000])
            else:
                print(json.dumps(d, indent=2)[:2000])
        break
    except Exception as e:
        print(f"{path}: {e}")
