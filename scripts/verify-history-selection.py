#!/usr/bin/env python3
"""Verify History timeline crop filters data (mirrors history-track.ts logic)."""
import json
import math
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
SESSION_ID = "343fd3ee-fd11-47da-bf93-3dbbed331aca"


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000
    to_rad = math.radians
    d_lat = to_rad(lat2 - lat1)
    d_lon = to_rad(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * r * math.asin(min(1, math.sqrt(a)))


def enrich(points):
    out = []
    cum = 0.0
    for i, p in enumerate(points):
        if i > 0:
            prev = points[i - 1]
            if None not in (p["lat"], p["lon"], prev["lat"], prev["lon"]):
                cum += haversine_m(prev["lat"], prev["lon"], p["lat"], p["lon"])
        out.append({**p, "cumDistM": cum})
    return out


def in_time(p, t0, t1):
    return t0 <= p["t"] <= t1


def filter_points(points, t0, t1, distance_mode=False, dist_start=0, dist_window=500):
    end = dist_start + dist_window
    out = []
    for p in points:
        if not in_time(p, t0, t1):
            continue
        if distance_mode and not (dist_start <= p["cumDistM"] <= end):
            continue
        out.append(p)
    return out


def main():
    url = f"{BASE}/api/history?format=dashboard&sessionId={SESSION_ID}"
    with urllib.request.urlopen(url, timeout=90) as resp:
        payload = json.load(resp)

    raw = payload.get("track") or []
    points = []
    for pt in raw:
        lat = pt.get("lat") if "lat" in pt else pt.get("latitude")
        lon = pt.get("lon") if "lon" in pt else pt.get("longitude")
        t = pt.get("t")
        if t is None:
            ft = pt.get("fixTime") or pt.get("deviceTime")
            if ft:
                from datetime import datetime

                t = datetime.fromisoformat(str(ft).replace("Z", "+00:00")).timestamp() * 1000
        if t is None:
            continue
        points.append(
            {
                "t": float(t),
                "lat": lat,
                "lon": lon,
                "speed": pt.get("speed"),
                "strokeRate": pt.get("strokeRate"),
            }
        )

    points.sort(key=lambda p: p["t"])
    enriched = enrich(points)
    t_min = enriched[0]["t"]
    t_max = enriched[-1]["t"]
    total_dist = enriched[-1]["cumDistM"]
    full = len(enriched)

    # Crop middle third of session
    span = t_max - t_min
    t0 = t_min + span / 3
    t1 = t_min + 2 * span / 3
    cropped = filter_points(enriched, t0, t1)
    cropped_count = len(cropped)

    # Distance window on full time range
    dist_window = min(500, total_dist / 2)
    dist_crop = filter_points(enriched, t_min, t_max, True, 0, dist_window)

    print(f"Session {SESSION_ID[:8]}…")
    print(f"  Full range: {full} points, {total_dist:.0f} m, {(span/1000):.0f}s")
    print(f"  Time crop (middle third): {cropped_count} points ({100*cropped_count/full:.0f}%)")
    print(f"  Distance window 0–{dist_window:.0f}m: {len(dist_crop)} points")

    ok = True
    if cropped_count >= full:
        print("FAIL: time crop did not reduce points")
        ok = False
    if cropped_count < 10:
        print("FAIL: time crop too aggressive")
        ok = False
    if len(dist_crop) >= full and total_dist > dist_window:
        print("FAIL: distance window did not reduce points")
        ok = False
    if not dist_crop:
        print("FAIL: distance window empty")
        ok = False

    if ok:
        print("PASS: selection filtering behaves as expected (auto-update would use this client-side)")
    else:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
