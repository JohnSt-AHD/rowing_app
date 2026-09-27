#!/usr/bin/env python3
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

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


def along_course(lat, lon, start, bearing):
    mid_lat = (start["lat1"] + start["lat2"]) / 2
    mid_lon = (start["lon1"] + start["lon2"]) / 2
    dist = hav(mid_lat, mid_lon, lat, lon)
    brg = bearing_deg(mid_lat, mid_lon, lat, lon)
    return dist * math.cos(math.radians(brg - bearing))


def chart_dist(along, total, reversed_course=False):
    eff = total - along if reversed_course else along
    return max(0, min(total, eff))


lines = [l for l in get("/api/timing-lines")["lines"] if l.get("courseGroup") == GROUP]
start = next(l for l in lines if l["lineType"] == "start")
finish = next(l for l in lines if l["lineType"] == "finish")
bearing = float(start["courseBearingDeg"])
total = finish["distanceM"] - start.get("distanceM", 0)

sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(UID))["sessions"]
    if s["session_id"].startswith("be01b0da")
)
gps = [p for p in get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"] if p.get("lat")]

print(f"2km course: total={total}m bearing={bearing:.1f}")
print(f"GPS points: {len(gps)}\n")

for rev in (False, True):
    dists = [chart_dist(along_course(p["lat"], p["lon"], start, bearing), total, rev) for p in gps]
    mx = max(dists)
    mx_i = dists.index(mx)
    print(f"reversed={rev}: max chart dist={mx:.0f}m at {datetime.fromtimestamp(gps[mx_i]['t']/1000,NZ).strftime('%H:%M:%S')}")
    print(f"  last chart dist={dists[-1]:.0f}m")

# dropout window: last fix gaps
now = datetime.now(NZ)
last_ts = datetime.fromtimestamp(gps[-1]["t"] / 1000, NZ)
print(f"\nLast GPS fix: {last_ts.strftime('%H:%M:%S')} ({(now-last_ts).total_seconds():.0f}s ago)")

mp = next(p for p in get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")["positions"] if p["deviceId"] == UID)
along_live = along_course(mp["latitude"], mp["longitude"], start, bearing)
print(f"Live map fixAge={mp.get('fixAgeSec')}s along={along_live:.0f}m")
for rev in (False, True):
    print(f"  chart dist reversed={rev}: {chart_dist(along_live, total, rev):.0f}m")

# segment path distance in last 15 min (actual ground covered)
cut = int((now - timedelta(minutes=15)).timestamp() * 1000)
recent = [p for p in gps if p["t"] >= cut]
seg = sum(hav(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"]) for i in range(1, len(recent)))
print(f"\nLast 15 min ground path: {seg:.0f}m in {len(recent)} fixes")

# find stall in chart distance (normal orientation)
dists = [chart_dist(along_course(p["lat"], p["lon"], start, bearing), total, False) for p in gps]
for i in range(1, len(gps)):
    dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
    if dt >= 120 and dists[i] > dists[i - 1]:
        print(
            f"Gap {dt:.0f}s: chart dist {dists[i-1]:.0f}->{dists[i]:.0f}m "
            f"({datetime.fromtimestamp(gps[i-1]['t']/1000,NZ).strftime('%H:%M:%S')}->{datetime.fromtimestamp(gps[i]['t']/1000,NZ).strftime('%H:%M:%S')})"
        )
