#!/usr/bin/env python3
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


import json
import math


def split500(v):
    if v is None or v < 0.25:
        return None
    s = 500 / float(v)
    return f"{int(s // 60)}:{s % 60:04.1f}"


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat = math.radians(c - a)
    dlon = math.radians(d - b)
    x = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def ground_median(track, minutes):
    now = int(datetime.now(AUCKLAND).timestamp() * 1000)
    gps = sorted(
        [x for x in track if x.get("lat") and x["t"] >= now - minutes * 60 * 1000],
        key=lambda x: x["t"],
    )
    segs = []
    for j in range(1, len(gps)):
        dt = (gps[j]["t"] - gps[j - 1]["t"]) / 1000
        if not (1.5 <= dt <= 12):
            continue
        dist = hav(gps[j - 1]["lat"], gps[j - 1]["lon"], gps[j]["lat"], gps[j]["lon"])
        if dist >= 1:
            segs.append(dist / dt)
    return statistics.median(segs) if len(segs) >= 5 else None


print(f"W2x EH @ {datetime.now(AUCKLAND).strftime('%H:%M:%S')} NZ\n")
polls = []
for i in range(3):
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    p = next(x for x in mp["positions"] if x["deviceId"] == UID)
    polls.append(p)
    print(
        f"poll {i + 1}: recent={split500(p.get('recentPathSpeedMps'))}"
        f" path={split500(p.get('pathSpeedMps'))}"
        f" ticket={split500(p.get('displaySpeedMps'))}"
        f" fixAge={p.get('fixAgeSec')}s stroke={p.get('displayStrokeRate')}"
    )
    if i < 2:
        time.sleep(5)

sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(UID)).get("sessions") or []
track = get(
    "/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sess[0]["session_id"])
).get("track") or []

print()
for mins in [5, 10, 15]:
    g = ground_median(track, mins)
    if g:
        print(f"ground ({mins}m): {g:.2f} m/s ({split500(g)}/500)")

p = polls[-1]
g = ground_median(track, 10)
print()
for name, val in [
    ("recent", p.get("recentPathSpeedMps")),
    ("path30s", p.get("pathSpeedMps")),
    ("ticket", p.get("displaySpeedMps")),
]:
    if val is not None and g is not None:
        print(f"{name}: {split500(val)}  delta vs ground: {val - g:+.2f} m/s")
if p.get("displaySpeedMps") and g:
    d = abs(p["displaySpeedMps"] - g)
    print(f"\nVerdict: ticket {'accurate' if d <= 0.45 else 'still off'} (|delta|={d:.2f} m/s)")
