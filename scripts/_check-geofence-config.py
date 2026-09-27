#!/usr/bin/env python3
import json
import math
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


gf = json.load(
    urllib.request.urlopen(urllib.request.Request(BASE + "/api/geofences", headers=H), timeout=60)
)["geofences"]

klat, klon = -37.9467958, 175.57930165
print("Geofence list order (first match wins on native):")
for i, g in enumerate(gf):
    print(
        f"  {i}: {g['name']} enabled={g.get('enabled')} "
        f"economyGps={g.get('economyGpsIntervalSec')}s "
        f"autoStart={g.get('autoStartOnExit')} autoStop={g.get('autoStopOnEnter')}"
    )

print("\nWhich zones contain Keeleys sample point?")
for g in gf:
    if g.get("shapeType") == "polygon":
        ins = in_poly(klat, klon, g.get("polygonCoords") or [])
    else:
        ins = hav(klat, klon, g["centerLat"], g["centerLon"]) <= g["radiusM"]
    if ins:
        print(f"  INSIDE: {g['name']}")
