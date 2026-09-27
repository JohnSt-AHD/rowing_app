#!/usr/bin/env python3
import json
import math
import time
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
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(s):
    if s is None or s < 0.25:
        return "—"
    sec = 500 / float(s)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


print(f"=== {UID} live check {datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC ===\n")
print("5 polls (5s apart):")
for i in range(5):
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    d = next(
        (
            x
            for x in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get("devices", [])
            if x.get("deviceId") == UID
        ),
        None,
    )
    row = (d or {}).get("rowing") or {}
    last = ((d or {}).get("gps") or {}).get("last") or {}
    ms = p.get("speed") if p else None
    ds = last.get("spd")
    stale = p.get("telemetryStale") if p else None
    print(
        f"  [{i}] map {ms} m/s ({split500(ms)}) | raw GPS {ds} ({split500(ds)}) | "
        f"stroke map={p.get('strokeRate') if p else None} dev={row.get('strokeRate')} | "
        f"seen={d.get('lastSeenAgoSec') if d else None}s stale={stale}"
    )
    time.sleep(5)

now = datetime.now(timezone.utc)
frm = (now - timedelta(minutes=8)).isoformat().replace("+00:00", "Z")
to = now.isoformat().replace("+00:00", "Z")
enc = urllib.parse.quote(UID, safe="")
track = get(
    f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
).get("track") or []

speeds = [p["speed"] for p in track if p.get("speed") is not None]
strokes = [p["strokeRate"] for p in track if p.get("strokeRate") is not None]
print(f"\nLast 8 min: {len(track)} GPS points, {len(speeds)} speed samples, {len(strokes)} stroke samples")
if speeds:
    print(
        f"  Reported speed: min={min(speeds):.2f} max={max(speeds):.2f} avg={sum(speeds)/len(speeds):.2f} m/s"
    )
    print(f"  Last 10 reported: {[round(x, 2) for x in speeds[-10:]]}")
else:
    print("  No speed samples")

if strokes:
    print(f"  Stroke rate last 10: {strokes[-10:]}")
else:
    print("  Stroke rate: NONE in history")

pts = [p for p in track if p.get("lat") is not None and p.get("lon") is not None and p.get("t")]
if len(pts) >= 2:
    end_t = pts[-1]["t"]
    recent = [p for p in pts if p["t"] >= end_t - 120_000]
    if len(recent) >= 2:
        dist = sum(
            haversine_m(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"])
            for i in range(1, len(recent))
        )
        span = (recent[-1]["t"] - recent[0]["t"]) / 1000
        path_spd = dist / span if span > 0 else None
        print(
            f"\nLast 120s path speed (GPS positions): {path_spd:.2f} m/s ({split500(path_spd)}) "
            f"over {dist:.0f}m in {span:.0f}s ({len(recent)} fixes)"
        )
