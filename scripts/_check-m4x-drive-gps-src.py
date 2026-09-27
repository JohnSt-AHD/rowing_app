#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
NZ = timezone(timedelta(hours=12))


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=120) as r:
        return json.load(r)


sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M4x JS"))["sessions"]
    if s["session_id"].startswith("fd472428")
)
tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"]
gps = [p for p in tr if p.get("lat") is not None]
print(f"GPS points: {len(gps)}\n")
for p in gps:
    ts = datetime.fromtimestamp(p["t"] / 1000, NZ).strftime("%H:%M:%S")
    src = p.get("gpsSampleSource") or p.get("sampleSource") or "?"
    prov = p.get("gpsProvider") or "?"
    fix = p.get("fixMs")
    spd = p.get("speed")
    print(
        f"{ts}  src={src:16} prov={prov:10} fixMs={fix}  "
        f"spd={spd}  {p['lat']:.5f},{p['lon']:.5f}"
    )

# compare indoor session
sid2 = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M4x JS"))["sessions"]
    if s["session_id"].startswith("3e089aaa")
)
tr2 = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid2))["track"]
gps2 = [p for p in tr2 if p.get("lat") is not None][:5]
print("\n=== prior indoor 3e089aaa (first 5 gps) ===")
for p in gps2:
    ts = datetime.fromtimestamp(p["t"] / 1000, NZ).strftime("%H:%M:%S")
    src = p.get("gpsSampleSource") or "?"
    print(f"{ts} src={src} {p['lat']:.5f},{p['lon']:.5f}")
