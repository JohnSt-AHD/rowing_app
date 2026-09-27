#!/usr/bin/env python3
"""Poll W2x EH inside Keeleys — watch for economy interval switch (~10s)."""
import json
import math
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
DEVICE = "W2x EH"
POLLS = 8
SLEEP_SEC = 30


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=90) as r:
        return json.load(r)


def hav(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def point_in_polygon(lat, lon, ring):
    x, y = lon, lat
    inside = False
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i][0], ring[i][1]
        y2, x2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1):
            inside = not inside
    return inside


def in_geofence(lat, lon, g):
    if g.get("shapeType", "circle") == "polygon":
        ring = g.get("polygonCoords") or []
        return len(ring) >= 3 and point_in_polygon(lat, lon, ring)
    return hav(lat, lon, float(g["centerLat"]), float(g["centerLon"])) <= float(g["radiusM"])


keeleys = next(g for g in get("/api/geofences")["geofences"] if "keeley" in g["name"].lower())
expected = float(keeleys.get("economyGpsIntervalSec") or 10)
sid = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(DEVICE))["sessions"][0]["session_id"]

print(f"Watching {DEVICE} | Keeleys economy={expected}s | session {sid[:8]}…")
print(f"Polling every {SLEEP_SEC}s x {POLLS}\n")

for n in range(POLLS):
    now = datetime.now(timezone.utc).strftime("%H:%M:%S")
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    p = next((x for x in mp["positions"] if x["deviceId"] == DEVICE), None)
    hist = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    track = [pt for pt in hist.get("track", []) if pt.get("lat")]
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    recent = [pt for pt in track if pt["t"] >= now_ms - 5 * 60 * 1000]

    inside = False
    if p and p.get("latitude") is not None:
        inside = in_geofence(p["latitude"], p["longitude"], keeleys)

    intervals = [(recent[i]["t"] - recent[i - 1]["t"]) / 1000 for i in range(1, len(recent))]
    tight = [x for x in intervals if x <= 120]
    med = sorted(tight)[len(tight) // 2] if tight else None
    buckets = Counter()
    for x in tight:
        if x <= 5:
            buckets["4-5s"] += 1
        elif x <= 15:
            buckets["6-15s"] += 1
        elif x <= 35:
            buckets["16-35s"] += 1
        else:
            buckets[">35s"] += 1

    economy_like = sum(1 for x in tight if 8 <= x <= 14)
    normal_like = sum(1 for x in tight if 3 <= x <= 6)

    status = "INSIDE Keeleys" if inside else "OUTSIDE Keeleys"
    mode = "ECONOMY ~10s" if med and med >= 8 else ("NORMAL ~4s" if med and med <= 6 else "?")

    print(f"[{now} UTC] poll {n + 1}/{POLLS} | {status} | {mode}")
    if p:
        print(
            f"  live: lastSeen={p.get('lastSeenAgoSec')}s acc={p.get('accuracy'):.1f}m "
            f"spd={p.get('displaySpeedMps')}"
        )
    print(f"  last 5min: {len(recent)} pts | med={med}s | 6-15s={buckets.get('6-15s',0)} | 4-5s={buckets.get('4-5s',0)}")
    if recent:
        tail = recent[-4:]
        ts = [datetime.fromtimestamp(pt["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S") for pt in tail]
        print(f"  last uploads: {' -> '.join(ts)}")
    print()

    if n < POLLS - 1:
        time.sleep(SLEEP_SEC)

print("Done.")
