#!/usr/bin/env python3
"""Print 500 m split table for KRI lane speed profile used by simulate-kri-race-device.mjs."""

import json
import urllib.request

KRI = "https://ahd-livestream.vercel.app/data/kri-sample-wrcp1-m1x-h1.json"
LANE = "ESP1"
M1X_REF_2K_SEC = 383.6


def speed_at(d, points):
    pts = sorted(points, key=lambda p: p["distance"])
    d = max(0, min(pts[-1]["distance"], d))
    if d <= pts[0]["distance"]:
        return pts[0]["speed"]
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        if d <= b["distance"]:
            span = b["distance"] - a["distance"]
            if span <= 0:
                return b["speed"]
            t = (d - a["distance"]) / span
            return a["speed"] + t * (b["speed"] - a["speed"])
    return pts[-1]["speed"]


def split500(mps):
    if not mps or mps <= 0:
        return "—"
    sec = 500 / mps
    return f"{int(sec // 60)}:{round(sec % 60):02d}"


def main():
    data = json.loads(urllib.request.urlopen(KRI, timeout=30).read())
    boat = next(b for b in data["boats"] if b["id"] == LANE)
    points = boat["points"]

    print(f"KRI source: {data.get('event')} {data.get('round')} race {data.get('race')}")
    print(f"Lane: {LANE} (rank {boat.get('rank')}) — drives TEST-KRI-RACE simulator")
    print()
    print(f"{'Segment':<14} {'Avg m/s':>8} {'/500m':>8} {'Prognostic':>12}")
    print("-" * 46)

    for lo in range(0, 2000, 500):
        hi = lo + 500
        speeds = [speed_at(lo + i + 0.5, points) for i in range(500)]
        avg = sum(speeds) / len(speeds)
        prog = (M1X_REF_2K_SEC / (2000 / avg)) * 100
        print(f"{lo:>4}–{hi:<4} m {avg:8.3f} {split500(avg):>8} {prog:10.1f}%")

    total_speeds = [speed_at(i + 0.5, points) for i in range(2000)]
    total_avg = sum(total_speeds) / len(total_speeds)
    total_split = split500(total_avg)
    total_prog = (M1X_REF_2K_SEC / (2000 / total_avg)) * 100
    print("-" * 46)
    print(f"{'0–2000 m':<14} {total_avg:8.3f} {total_split:>8} {total_prog:10.1f}%")
    est_2k = 2000 / total_avg
    print(f"\nEstimated 2 km time from profile: {int(est_2k//60)}:{est_2k%60:04.1f}")

    print("\nRaw KRI sample points (interpolated between these):")
    print(f"{'Distance':>8}  {'m/s':>6}  {'/500m':>8}")
    for p in sorted(points, key=lambda x: x["distance"]):
        print(f"{p['distance']:>7} m  {p['speed']:6.3f}  {split500(p['speed']):>8}")


if __name__ == "__main__":
    main()
