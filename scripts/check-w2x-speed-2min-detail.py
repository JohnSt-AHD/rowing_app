#!/usr/bin/env python3
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
WINDOW_S = 120


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
track = get(
    f"/api/history?format=dashboard&uniqueId={urllib.parse.quote(UID, safe='')}"
    f"&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
).get("track") or []
pts = [p for p in track if p.get("lat") is not None and p.get("lon") is not None and p.get("t")]
end_t = pts[-1]["t"] if pts else 0
pts = [p for p in pts if p["t"] >= end_t - WINDOW_S * 1000]

mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
pos = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
snap = get("/api/snapshot?onlineSec=600")
dev = next((d for d in snap.get("devices", []) if d.get("uniqueId") == UID), None)
sp = next((p for p in snap.get("positions", []) if dev and p.get("deviceId") == dev.get("id")), None)

print(f"=== W2x EH — last {WINDOW_S}s (polled {datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC) ===")
print(f"map-positions: {pos.get('speed') if pos else None} m/s ({split500(pos.get('speed') if pos else None)}/500)")
print(f"snapshot:      {sp.get('speed') if sp else None} m/s ({split500(sp.get('speed') if sp else None)}/500)")

if len(pts) < 2:
    print("Not enough points")
    raise SystemExit

dist_all = sum(
    haversine_m(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
    for i in range(1, len(pts))
)
span = (pts[-1]["t"] - pts[0]["t"]) / 1000

legs = []
for i in range(1, len(pts)):
    dt = (pts[i]["t"] - pts[i - 1]["t"]) / 1000
    dist = haversine_m(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
    seg = dist / dt if dt > 0 else None
    legs.append({"dt": dt, "dist": dist, "seg": seg, "rep": pts[i].get("speed"), "t": pts[i]["t"]})

# Filter GPS spikes (>8 m/s segment)
legs_ok = [l for l in legs if l["seg"] is not None and l["dist"] >= 1 and l["seg"] <= 8]
dist_ok = sum(l["dist"] for l in legs_ok)
time_ok = sum(l["dt"] for l in legs_ok)
reps = [float(l["rep"]) for l in legs if l["rep"] is not None]

print(f"\nfixes={len(pts)} span={span:.0f}s total distance={dist_all:.0f}m")
print(f"path (all legs):     {dist_all/span:.2f} m/s ({split500(dist_all/span)}/500)")
if time_ok > 0:
    print(f"path (legs <=8m/s): {dist_ok/time_ok:.2f} m/s ({split500(dist_ok/time_ok)}/500) over {time_ok:.0f}s / {dist_ok:.0f}m")
if reps:
    print(f"reported avg:        {sum(reps)/len(reps):.2f} m/s ({split500(sum(reps)/len(reps))}/500)")
print(f"reported last fix:   {pts[-1].get('speed')} m/s ({split500(pts[-1].get('speed'))}/500)")

print("\nlast 8 legs: time, dist, segment m/s, reported m/s")
for l in legs[-8:]:
    ts = datetime.fromtimestamp(l["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
    seg = f"{l['seg']:.2f}" if l["seg"] is not None else "—"
    print(f"  {ts}  dt={l['dt']:.0f}s  {l['dist']:.0f}m  seg={seg}  rep={l['rep']}")
