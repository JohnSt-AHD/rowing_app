#!/usr/bin/env python3
"""Latest H6/F4 sessions — gap analysis for geofence < device tests."""
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def dedupe(pts, min_gap=0.75):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000.0 >= min_gap:
            out.append(p)
    return out


gfs = get("/api/geofences")["geofences"]
print("Geofences:")
for g in gfs:
    en = g.get("enabled", True)
    print(
        f"  {g['name']}: {g['economyIntervalSec']}s enabled={en} "
        f"center=({g.get('centerLat')},{g.get('centerLon')}) r={g.get('radiusM')}m"
    )

for uid in ["H6", "F4"]:
    sess = get(f"/api/history?list=sessions&uniqueId={uid}")["sessions"]
    if not sess:
        print(f"\n{uid}: no sessions")
        continue
    s = sess[0]
    sid = s["session_id"]
    tr = get(f"/api/history?format=dashboard&sessionId={sid}")["track"]
    gps = dedupe(sorted([p for p in tr if p.get("lat")], key=lambda p: p["t"]))
    if len(gps) < 2:
        print(f"\n{uid} {sid[:8]}: too few points ({len(gps)})")
        continue
    gaps = [(gps[i]["t"] - gps[i - 1]["t"]) / 1000.0 for i in range(1, len(gps))]
    med = statistics.median(gaps)
    start = datetime.fromtimestamp(gps[0]["t"] / 1000, tz=NZ)
    c1 = sum(1 for g in gaps if 0.8 <= g <= 1.3)
    c2 = sum(1 for g in gaps if 1.7 <= g <= 2.3)
    c5 = sum(1 for g in gaps if 4.5 <= g <= 5.5)
    print(
        f"\n{uid} session {sid[:8]} started {start.strftime('%Y-%m-%d %H:%M:%S')} NZ"
        f" n={len(gps)} med={med:.3f}s 1s={c1}/{len(gaps)} 2s={c2}/{len(gaps)} 5s={c5}/{len(gaps)}"
    )
    for label, n in [("first 30s", 30), ("first 60s", 60), ("first 120s", 120)]:
        sub = gaps[: min(n, len(gaps))]
        if not sub:
            continue
        c1s = sum(1 for g in sub if 0.8 <= g <= 1.3)
        c5s = sum(1 for g in sub if 4.5 <= g <= 5.5)
        print(
            f"  {label}: n={len(sub)} med={statistics.median(sub):.2f}s "
            f"1s={100*c1s/len(sub):.0f}% 5s={100*c5s/len(sub):.0f}% "
            f"gaps={[round(g, 1) for g in sub[:8]]}"
        )
    hist = Counter(round(g, 1) for g in gaps)
    print("  gap hist:", dict(sorted(hist.items())))
