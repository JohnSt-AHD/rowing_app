#!/usr/bin/env python3
"""Analyze latest H6/F4 session for geofence interval switch."""
import json
import math
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    to_rad = lambda d: d * math.pi / 180
    dlat = to_rad(lat2 - lat1)
    dlon = to_rad(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(min(1, math.sqrt(a)))


def seg_stats(pts, label):
    if len(pts) < 2:
        print(f"  {label}: too few points ({len(pts)})")
        return
    gaps = [(pts[i]["t"] - pts[i - 1]["t"]) / 1000 for i in range(1, len(pts))]
    c1 = sum(1 for g in gaps if 0.75 <= g <= 1.35)
    c10 = sum(1 for g in gaps if 7.5 <= g <= 12.5)
    print(
        f"  {label}: n={len(pts)} med={statistics.median(gaps):.2f}s "
        f"1s={100 * c1 / len(gaps):.0f}% 10s={100 * c10 / len(gaps):.0f}% "
        f"top={Counter(round(g, 1) for g in gaps).most_common(3)}"
    )


gfs = get("/api/geofences")["geofences"]
print("Geofences:")
for g in gfs:
    print(
        f"  {g['name']}: {g['economyIntervalSec']}s enabled={g.get('enabled', True)} "
        f"({g.get('centerLat')},{g.get('centerLon')}) r={g.get('radiusM')}m"
    )

test = next((g for g in gfs if g["name"] == "Test"), None)
if not test:
    raise SystemExit("No Test geofence")

clat, clon, radius = test["centerLat"], test["centerLon"], test["radiusM"]

for uid in ("H6", "F4"):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    if not sessions:
        print(f"\n{uid}: no sessions")
        continue

    s = sessions[0]
    sid = s["session_id"]
    tr = sorted(
        [p for p in get(f"/api/history?format=dashboard&sessionId={sid}").get("track", []) if p.get("lat")],
        key=lambda p: p["t"],
    )
    start = datetime.fromtimestamp(tr[0]["t"] / 1000, tz=NZ)
    end = datetime.fromtimestamp(tr[-1]["t"] / 1000, tz=NZ)
    print(f"\n=== {uid} session {sid[:8]} ===")
    print(f"  {start.strftime('%Y-%m-%d %H:%M:%S')} -> {end.strftime('%H:%M:%S')} NZ ({len(tr)} pts)")

    inside = [p for p in tr if haversine_m(p["lat"], p["lon"], clat, clon) <= radius]
    print(f"  Points inside Test geofence: {len(inside)}/{len(tr)} ({100 * len(inside) / len(tr):.1f}%)")

    entry_t = inside[0]["t"] if inside else None
    if entry_t:
        t_in = datetime.fromtimestamp(entry_t / 1000, tz=NZ)
        p_in = inside[0]
        d_in = haversine_m(p_in["lat"], p_in["lon"], clat, clon)
        print(f"  First inside Test at {t_in.strftime('%H:%M:%S')} dist={d_in:.0f}m")
        before = [p for p in tr if p["t"] < entry_t]
        after = [p for p in tr if p["t"] >= entry_t]
        seg_stats(before, "Before geofence entry")
        seg_stats(after, "After geofence entry")
    else:
        print("  Never entered Test geofence by GPS track")
        # nearest approach
        nearest = min(tr, key=lambda p: haversine_m(p["lat"], p["lon"], clat, clon))
        d_min = haversine_m(nearest["lat"], nearest["lon"], clat, clon)
        t_near = datetime.fromtimestamp(nearest["t"] / 1000, tz=NZ)
        print(f"  Nearest to Test: {d_min:.0f}m at {t_near.strftime('%H:%M:%S')}")

    gaps_10 = [
        (i, (tr[i]["t"] - tr[i - 1]["t"]) / 1000)
        for i in range(1, len(tr))
        if 7.5 <= (tr[i]["t"] - tr[i - 1]["t"]) / 1000 <= 12.5
    ]
    print(f"  10s gaps total: {len(gaps_10)}")
    if gaps_10:
        i0, g0 = gaps_10[0]
        t0 = datetime.fromtimestamp(tr[i0]["t"] / 1000, tz=NZ)
        d0 = haversine_m(tr[i0]["lat"], tr[i0]["lon"], clat, clon)
        print(f"  First 10s gap: {t0.strftime('%H:%M:%S')} ({g0:.1f}s) inside={d0 <= radius} dist={d0:.0f}m")

    cut = tr[-1]["t"] - 5 * 60 * 1000
    seg_stats([p for p in tr if p["t"] >= cut], "Last 5 min")

    # inBoatPark in uploaded attributes if present
    route = get(f"/api/history?uniqueId={uid}&from={s['started_at']}&to=2099-01-01T00:00:00.000Z")
    park = 0
    if isinstance(route, list):
        for p in route:
            if isinstance(p, dict) and (p.get("attributes") or {}).get("inBoatPark"):
                park += 1
    print(f"  Uploaded inBoatPark flags: {park}")

    if uid == "F4" and entry_t:
        print("  F4 after-entry 2-min buckets:")
        after_pts = [p for p in tr if p["t"] >= entry_t]
        t0 = entry_t
        while t0 < after_pts[-1]["t"]:
            t1 = t0 + 120_000
            chunk = [p for p in after_pts if t0 <= p["t"] < t1]
            if len(chunk) >= 2:
                gaps = [(chunk[i]["t"] - chunk[i - 1]["t"]) / 1000 for i in range(1, len(chunk))]
                c1 = sum(1 for g in gaps if 0.75 <= g <= 1.35)
                c10 = sum(1 for g in gaps if 7.5 <= g <= 12.5)
                c20 = sum(1 for g in gaps if 18 <= g <= 22)
                ts = datetime.fromtimestamp(t0 / 1000, tz=NZ).strftime("%H:%M")
                print(
                    f"    {ts}: pts={len(chunk)} 1s={100 * c1 / len(gaps):.0f}% "
                    f"10s={100 * c10 / len(gaps):.0f}% 20s={100 * c20 / len(gaps):.0f}% "
                    f"med={statistics.median(gaps):.1f}s"
                )
            t0 = t1
