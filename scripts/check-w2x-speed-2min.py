#!/usr/bin/env python3
"""Tight window: last 2 min distance/time vs live map speed for W2x EH."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def split500(speed):
    if speed is None or speed < 0.25:
        return "—"
    sec = 500 / float(speed)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


now = datetime.now(timezone.utc)
frm = (now - timedelta(minutes=3)).isoformat().replace("+00:00", "Z")
to = now.isoformat().replace("+00:00", "Z")
enc = urllib.parse.quote(UID, safe="")
track = get(
    f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
).get("track") or []
pts = [p for p in track if p.get("lat") is not None and p.get("lon") is not None and p.get("t")]

# Last 120 seconds
if pts:
    end_t = pts[-1]["t"]
    pts2 = [p for p in pts if p["t"] >= end_t - 120_000]
else:
    pts2 = []

mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
pos = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
snap = get("/api/snapshot?onlineSec=600")
dev = next((d for d in snap.get("devices", []) if d.get("uniqueId") == UID), None)
sp = next((p for p in snap.get("positions", []) if dev and p.get("deviceId") == dev.get("id")), None)

print("=== Live map speed (now) ===")
print(f"map-positions: {pos.get('speed') if pos else None} m/s ({split500(pos.get('speed') if pos else None)}/500)")
print(f"snapshot:      {sp.get('speed') if sp else None} m/s ({split500(sp.get('speed') if sp else None)}/500)")

if len(pts2) >= 2:
    dist = sum(
        haversine_m(pts2[i - 1]["lat"], pts2[i - 1]["lon"], pts2[i]["lat"], pts2[i]["lon"])
        for i in range(1, len(pts2))
    )
    span = (pts2[-1]["t"] - pts2[0]["t"]) / 1000
    path = dist / span if span > 0 else None
    reps = [float(p["speed"]) for p in pts2 if p.get("speed") is not None]
    rep_avg = sum(reps) / len(reps) if reps else None
    rep_last = pts2[-1].get("speed")
    print(f"\n=== Last {span:.0f}s ({len(pts2)} fixes, {dist:.0f}m) ===")
    print(f"path speed (distance/time): {path:.2f} m/s ({split500(path)}/500)")
    print(f"reported avg:               {rep_avg:.2f} m/s ({split500(rep_avg)}/500)" if rep_avg else "")
    print(f"reported last fix:          {rep_last} m/s ({split500(rep_last)}/500)")
    if pos and pos.get("speed") is not None and path:
        print(f"map vs path:                {pos['speed'] - path:+.2f} m/s ({100*(pos['speed']-path)/path:+.1f}%)")
