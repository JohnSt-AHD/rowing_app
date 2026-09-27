#!/usr/bin/env python3
"""M1x TM map jumps + speed accuracy."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICE = "M1x TM"
SID = "315e22f9-3c4e-4a56-a82c-6d308f1623cd"
AUCKLAND = timezone(timedelta(hours=12))


def get(path, auth=True):
    headers = {"Accept": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def analyze_track(gps, label):
    if len(gps) < 2:
        print(label, "too few", len(gps))
        return
    gps = sorted(gps, key=lambda x: x["t"])
    print(f"\n=== {label} ({len(gps)} fixes) ===")
    gaps = []
    jumps = []
    speeds = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = haversine_m(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        implied = dist / dt if dt > 0 else 0
        gaps.append(dt)
        if dt >= 8:
            jumps.append(
                {
                    "from": datetime.fromtimestamp(gps[i - 1]["t"] / 1000, tz=AUCKLAND).strftime("%H:%M:%S"),
                    "to": datetime.fromtimestamp(gps[i]["t"] / 1000, tz=AUCKLAND).strftime("%H:%M:%S"),
                    "gap_s": round(dt, 1),
                    "dist_m": round(dist, 1),
                    "implied_mps": round(implied, 2),
                }
            )
        if 2 <= dt <= 6 and dist > 0:
            speeds.append(implied)
    gs = sorted(gaps)
    print(
        f" median_gap={statistics.median(gaps):.2f}s p95={gs[int(0.95*(len(gs)-1))]:.2f}s"
        f" max={max(gaps):.1f}s gaps_ge_8s={sum(1 for g in gaps if g>=8)}"
    )
    if speeds:
        print(
            f" implied speed (2-6s gaps): median={statistics.median(speeds):.2f} m/s"
            f" p95={sorted(speeds)[int(0.95*(len(speeds)-1))]:.2f} m/s"
        )
    if jumps:
        print(" large gaps (>=8s) causing map jumps:")
        for j in jumps[-12:]:
            print(f"  {j['from']} -> {j['to']} gap={j['gap_s']}s dist={j['dist_m']}m implied={j['implied_mps']}m/s")


print("UTC", datetime.now(timezone.utc).isoformat())

# Live poll map 12 x 3s
print("\n=== Live map poll ===")
prev = None
for i in range(12):
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
    if not pos:
        print(i, "missing")
    else:
        row = {
            "fixAge": pos.get("fixAgeSec"),
            "displayAge": pos.get("displayFixAgeSec"),
            "lastSeen": pos.get("lastSeenAgoSec"),
            "lat": round(pos.get("latitude", 0), 5),
            "lon": round(pos.get("longitude", 0), 5),
            "rawSpd": round(pos.get("speed") or 0, 2),
            "displaySpd": round(pos.get("displaySpeedMps") or 0, 2),
            "pathSpd": round(pos.get("pathSpeedMps") or 0, 2),
            "smoothAge": pos.get("smoothFixAgeSec"),
        }
        jump = None
        if prev:
            dist = haversine_m(prev["latitude"], prev["longitude"], pos["latitude"], pos["longitude"])
            jump = round(dist, 1)
            implied = dist / max(pos.get("fixAgeSec") or 3, 1)
            row["poll_dist_m"] = jump
            row["dist_per_fixAge"] = round(implied, 2)
        print(i, row)
        prev = pos
    time.sleep(3)

# Recent session track last 45m
dash = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(SID))
track = dash.get("track") or []
now_ms = int(datetime.now(AUCKLAND).timestamp() * 1000)
t0 = now_ms - 45 * 60 * 1000
gps = [{"t": p["t"], "lat": p["lat"], "lon": p["lon"]} for p in track if p.get("lat") and p["t"] >= t0]
analyze_track(gps, "Last 45m NZ")

# Last 2 hours
t0 = now_ms - 120 * 60 * 1000
gps2 = [{"t": p["t"], "lat": p["lat"], "lon": p["lon"]} for p in track if p.get("lat") and p["t"] >= t0]
analyze_track(gps2, "Last 2h NZ")
