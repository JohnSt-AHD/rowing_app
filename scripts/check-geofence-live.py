#!/usr/bin/env python3
"""Check live device positions vs geofence and reporting interval."""
import json
import statistics
import urllib.request
from math import asin, cos, radians, sin, sqrt

BASE = "https://rowing-app-recorder-pwa.vercel.app"
EARTH_R = 6371000


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def dist_m(lat1, lon1, lat2, lon2):
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * EARTH_R * asin(sqrt(a))


def analyze_gaps(uid: str):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    if not sessions:
        return None
    s = sessions[0]
    sid = s["session_id"]
    tr = get(f"/api/history?format=dashboard&sessionId={sid}").get("track") or []
    gps = sorted([p for p in tr if p.get("lat") is not None], key=lambda p: p["t"])
    if len(gps) < 3:
        return None
    gaps = [(gps[i]["t"] - gps[i - 1]["t"]) / 1000 for i in range(1, len(gps))]
    tail = gaps[-30:] if len(gaps) >= 30 else gaps
    return {
        "session": sid[:8],
        "n": len(gps),
        "med_all": round(statistics.median(gaps), 2),
        "med_tail": round(statistics.median(tail), 2),
        "last_lat": gps[-1]["lat"],
        "last_lon": gps[-1]["lon"],
    }


def main():
    gfs = get("/api/geofences").get("geofences") or []
    print(f"Geofences: {len(gfs)}")
    for gf in gfs:
        print(
            f"  {gf['name']}: every {gf.get('economyIntervalSec')}s, "
            f"center=({gf['centerLat']}, {gf['centerLon']}), r={gf['radiusM']}m"
        )

    print("\n=== Fleet vs geofence ===")
    dev = get("/api/devices?windowSec=3600&onlineSec=600&includeMetrics=1")
    for uid in ("H6", "F4", "A2", "A3"):
        stats = analyze_gaps(uid)
        gps = {}
        lat = lon = None
        d = next((x for x in dev.get("devices", []) if x.get("deviceId") == uid), None)
        if d:
            lat, lon = d.get("lat"), d.get("lon")
            gps = d.get("gps") or {}
        if stats and (lat is None or lon is None):
            lat, lon = stats["last_lat"], stats["last_lon"]
        if lat is None or not gfs:
            print(f"  {uid}: no position")
            continue

        matches = []
        for gf in gfs:
            d_m = dist_m(lat, lon, gf["centerLat"], gf["centerLon"])
            inside = d_m <= gf["radiusM"]
            if inside:
                matches.append((gf["name"], gf["economyIntervalSec"], d_m))
        expected = matches[0][1] if matches else "user setting"
        med = stats["med_tail"] if stats else None
        match_txt = ", ".join(f"{n}({sec}s@{d:.0f}m)" for n, sec, d in matches) or "outside all"
        print(
            f"  {uid}: gpsHz={gps.get('rateHz')} zones={match_txt} "
            f"expected={expected}s observed_med={med}s"
        )
        if stats:
            print(
                f"       session={stats['session']} points={stats['n']} "
                f"pos=({lat:.6f},{lon:.6f})"
            )


if __name__ == "__main__":
    main()
