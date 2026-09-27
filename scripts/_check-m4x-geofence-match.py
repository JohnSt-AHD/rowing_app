#!/usr/bin/env python3
"""Match drive coords against geofences using same logic as geofence.ts."""
import json
import math
import urllib.parse
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=120) as r:
        return json.load(r)


def dist_m(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def in_poly(lat, lon, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i][0], ring[i][1]
        y2, x2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1 + 1e-15) + x1:
            inside = not inside
    return inside


def in_zone(g, lat, lon):
    if not g.get("enabled", True):
        return False
    if g.get("shapeType") == "polygon":
        return in_poly(lat, lon, g.get("polygonCoords") or [])
    return dist_m(lat, lon, g["centerLat"], g["centerLon"]) <= g["radiusM"]


gf = [g for g in get("/api/geofences")["geofences"] if g.get("kind") == "boat_park" or True]
sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M4x JS"))["sessions"]
    if s["session_id"].startswith("fd472428")
)
pts = [
    (p["lat"], p["lon"])
    for p in get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"]
    if p.get("lat") is not None
]
home = (-37.80809, 175.26999)
print("=== boat_park match for home + drive ===")
for lat, lon in [home] + pts[:3] + pts[-1:]:
    hits = [g["name"] for g in gf if in_zone(g, lat, lon)]
    print(f"  {lat:.5f},{lon:.5f} -> {hits or ['none']}")

# distance to RNZ
rnz = next(g for g in gf if g["name"] == "RNZ")
d_home = dist_m(home[0], home[1], rnz["centerLat"], rnz["centerLon"])
print(f"\nHome to RNZ center: {d_home/1000:.1f} km (radius {rnz['radiusM']}m)")

# session 63d89272 compare
s63 = next(
    s for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M4x JS"))["sessions"]
    if s["session_id"].startswith("63d89272")
)
print(f"\nSession 63d89272: {s63['started_at']} samples={s63.get('sample_count')}")
