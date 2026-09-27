#!/usr/bin/env python3
"""Project W2- KL onto 2km course — pace graph distance vs reality."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
UID = "W2- KL"
NZ = timezone(timedelta(hours=12))
GROUP = "2 km course"


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=120) as r:
        return json.load(r)


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def bearing_deg(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    dlon = math.radians(d - b)
    y = math.sin(dlon) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def along_course(lat, lon, start, bearing_deg_val):
    mid_lat = (start["lat1"] + start["lat2"]) / 2
    mid_lon = (start["lon1"] + start["lon2"]) / 2
    dist = hav(mid_lat, mid_lon, lat, lon)
    brg = bearing_deg(mid_lat, mid_lon, lat, lon)
    return dist * math.cos(math.radians(brg - bearing_deg_val))


lines = [l for l in get("/api/timing-lines")["lines"] if l.get("courseGroup") == GROUP]
start = next(l for l in lines if l["lineType"] == "start")
finish = next((l for l in lines if l["lineType"] == "finish"), None)
splits = sorted(
    [l for l in lines if l["lineType"] == "split" and l.get("distanceM") is not None],
    key=lambda x: x["distanceM"],
)
bearing = float(start.get("courseBearingDeg") or start.get("bearingDeg") or 0)
total = (finish or {}).get("distanceM") or 2000

print(f"=== 2 km course projection for {UID} ===")
print(f"course total={total}m bearing={bearing:.1f}°\n")


def report(label, lat, lon, t=None):
    along = along_course(lat, lon, start, bearing)
    along_clamped = max(0, min(total, along))
    ts = datetime.fromtimestamp(t / 1000, NZ).strftime("%H:%M:%S") if t else ""
    print(f"{label:28} {ts:8}  along={along:.0f}m (clamped {along_clamped:.0f}m)  {lat:.5f},{lon:.5f}")


mp = next(
    p
    for p in get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")["positions"]
    if p["deviceId"] == UID
)
report("Live map now", mp["latitude"], mp["longitude"])

sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(UID))["sessions"]
    if s["session_id"].startswith("be01b0da")
)
tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"]
gps = [p for p in tr if p.get("lat") is not None]

for label, p in [
    ("Last session fix", gps[-1]),
    ("Before dropout ~08:16:10", next(p for p in gps if p["t"] >= int(datetime(2026, 8, 4, 8, 16, 8, tzinfo=NZ).timestamp() * 1000))),
    ("After dropout ~08:22:22", gps[-1]),
]:
    report(label, p["lat"], p["lon"], p.get("t"))

# show progression around dropout window
print("\n--- Along-course every ~30s 08:14-08:23 ---")
window = [p for p in gps if int(datetime(2026, 8, 4, 8, 14, 0, tzinfo=NZ).timestamp() * 1000) <= p["t"] <= int(datetime(2026, 8, 4, 8, 23, 0, tzinfo=NZ).timestamp() * 1000)]
step = max(1, len(window) // 12)
for p in window[::step]:
    along = along_course(p["lat"], p["lon"], start, bearing)
    print(f"  {datetime.fromtimestamp(p['t']/1000,NZ).strftime('%H:%M:%S')} along={along:.0f}m spd={p.get('speed')}")

# biggest position jumps
print("\n--- Largest GPS jumps (pace graph skips distance) ---")
jumps = []
for i in range(1, len(gps)):
    dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
    d = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
    if d >= 80 or dt >= 60:
        a0 = along_course(gps[i - 1]["lat"], gps[i - 1]["lon"], start, bearing)
        a1 = along_course(gps[i]["lat"], gps[i]["lon"], start, bearing)
        jumps.append((dt, d, a1 - a0, gps[i - 1]["t"], gps[i]["t"]))
for dt, d, da, t0, t1 in sorted(jumps, key=lambda x: x[1], reverse=True)[:8]:
    print(
        f"  {datetime.fromtimestamp(t0/1000,NZ).strftime('%H:%M:%S')}->{datetime.fromtimestamp(t1/1000,NZ).strftime('%H:%M:%S')} "
        f"gap={dt:.0f}s jump={d:.0f}m along_delta={da:.0f}m"
    )

print("\n--- Pace graph behaviour on dropout ---")
print("Manager chart uses course projection from each live poll (every 2s).")
print("When GPS position freezes, along-course distance stops → graph stalls.")
print("When GPS jumps after outage, distance jumps but intermediate pace is lost.")
print("Chart does NOT use cumulative path distance from session history.")
