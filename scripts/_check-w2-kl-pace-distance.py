#!/usr/bin/env python3
"""W2- KL pace-graph distance analysis after dropout."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
UID = "W2- KL"
NZ = timezone(timedelta(hours=12))


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


def line_mid(lat1, lon1, lat2, lon2):
    return (lat1 + lat2) / 2, (lon1 + lon2) / 2


def distance_along_course(lat, lon, start, bearing):
    mid = line_mid(start["lat1"], start["lon1"], start["lat2"], start["lon2"])
    dist = hav(mid[0], mid[1], lat, lon)
    brg = bearing_deg(mid[0], mid[1], lat, lon)
    return dist * math.cos(math.radians(brg - bearing))


now = datetime.now(NZ)
print(f"=== W2- KL pace/distance @ {now.strftime('%H:%M:%S')} NZ ===\n")

mp = next(
    p
    for p in get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")["positions"]
    if p["deviceId"] == UID
)
print("Live map:")
for k in [
    "online",
    "lastSeenAgoSec",
    "latitude",
    "longitude",
    "displaySpeedMps",
    "pathSpeedMps",
    "fixAgeSec",
    "telemetryStale",
    "gpsSampleSource",
]:
    print(f"  {k}: {mp.get(k)}")

# timing lines for course projection
tl = get("/api/timing-lines")
lines = [l for l in (tl.get("lines") or []) if l.get("enabled", True)]
groups = sorted({l.get("courseGroup") or l.get("course_group") or "?" for l in lines})
print(f"\nTiming line groups: {groups[:8]}")

# pick likely 2k course group used at Karapiro
for group in groups:
    gl = [l for l in lines if (l.get("courseGroup") or l.get("course_group")) == group]
    starts = [l for l in gl if l.get("lineType") == "start"]
    finishes = [l for l in gl if l.get("lineType") == "finish"]
    if not starts:
        continue
    start = starts[0]
    finish = finishes[0] if finishes else None
    bearing = start.get("bearingDeg") or start.get("bearing_deg")
    if bearing is None:
        continue
    lat, lon = mp["latitude"], mp["longitude"]
    along = distance_along_course(lat, lon, start, float(bearing))
    total = None
    if finish and finish.get("distanceM") is not None and start.get("distanceM") is not None:
        total = finish["distanceM"] - start.get("distanceM", 0)
    print(f"\nCourse group '{group}':")
    print(f"  projected along-course: {along:.0f}m" + (f" / {total:.0f}m total" if total else ""))
    if total and along >= 1900:
        print("  ** past 2km mark on projection **")

sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(UID))["sessions"]
    if s["session_id"].startswith("be01b0da")
)
tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"]
gps = [p for p in tr if p.get("lat") is not None]

cum = 0.0
for i in range(1, len(gps)):
    cum += hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])

last = gps[-1]
last_ts = datetime.fromtimestamp(last["t"] / 1000, NZ)
print(f"\nSession track:")
print(f"  gps fixes={len(gps)}  cumulative path distance={cum:.0f}m")
print(f"  last fix {last_ts.strftime('%H:%M:%S')} ({(now-last_ts).total_seconds():.0f}s ago)")
print(f"  last coords {last['lat']:.5f},{last['lon']:.5f} spd={last.get('speed')}")

# gaps
recent = [p for p in gps if p["t"] >= int((now - timedelta(hours=1)).timestamp() * 1000)]
big = []
for i in range(1, len(recent)):
    dt = (recent[i]["t"] - recent[i - 1]["t"]) / 1000
    if dt >= 30:
        big.append(
            (
                datetime.fromtimestamp(recent[i - 1]["t"] / 1000, NZ).strftime("%H:%M:%S"),
                datetime.fromtimestamp(recent[i]["t"] / 1000, NZ).strftime("%H:%M:%S"),
                round(dt, 1),
                round(
                    hav(
                        recent[i - 1]["lat"],
                        recent[i - 1]["lon"],
                        recent[i]["lat"],
                        recent[i]["lon"],
                    ),
                    0,
                ),
            )
        )

print(f"\nGPS gaps >=30s in last hour: {len(big)}")
for row in big[-8:]:
    print(f"  {row[0]} -> {row[1]}  gap={row[2]}s  jump={row[3]}m")

# Simulate what pace graph would show: trace stops when position frozen
# Find longest recent gap and distance at gap start vs end
if big:
    g = max(big, key=lambda x: x[2])
    print(f"\nWorst gap: {g[0]} -> {g[1]} ({g[2]}s, {g[3]}m position jump)")
    print("  Pace graph uses course projection from live GPS — frozen pin = flat distance on chart.")
