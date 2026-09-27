#!/usr/bin/env python3
import json
import math
import urllib.parse
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def in_poly(lat, lon, ring):
    x, y = lon, lat
    inside = False
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i][0], ring[i][1]
        y2, x2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1):
            inside = not inside
    return inside


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


gf = get("/api/geofences")["geofences"]
full = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M4x JS"))["sessions"]
    if s["session_id"].startswith("fd472428")
)
tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(full))["track"]
gps = [(p["lat"], p["lon"]) for p in tr if p.get("lat") is not None]
print(f"GPS fixes with lat: {len(gps)}")
for lat, lon in gps:
    hits = []
    for g in gf:
        if not g.get("enabled", True):
            continue
        eco = g.get("economyIntervalSec") or g.get("economyGpsIntervalSec")
        if g.get("shapeType") == "polygon":
            ins = in_poly(lat, lon, g.get("polygonCoords") or [])
        else:
            ins = hav(lat, lon, g["centerLat"], g["centerLon"]) <= g["radiusM"]
        if ins:
            hits.append(f"{g['name']}({eco}s)")
    print(f"  {lat:.5f},{lon:.5f} -> {hits or ['outside all']}")
