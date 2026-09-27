#!/usr/bin/env python3
"""Analyze A2 moving test — session 343fd3ee, 7:20-7:30am NZST."""
import json
import statistics
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))
START_LOCAL = datetime(2026, 7, 1, 7, 20, tzinfo=NZ)
END_LOCAL = datetime(2026, 7, 1, 7, 30, tzinfo=NZ)
SESSION_FROM = "2026-06-30T19:21:07Z"
SESSION_TO = "2026-06-30T19:35:00Z"


def main():
    route = json.load(
        urllib.request.urlopen(
            BASE
            + f"/api/history?uniqueId=A2&from={quote(SESSION_FROM)}&to={quote(SESSION_TO)}",
            timeout=90,
        )
    )

    pts = []
    for pt in route:
        if not isinstance(pt, dict):
            continue
        lat = pt.get("latitude")
        lon = pt.get("longitude")
        ft = pt.get("fixTime") or pt.get("deviceTime")
        if lat is None or ft is None:
            continue
        ms = datetime.fromisoformat(str(ft).replace("Z", "+00:00")).timestamp() * 1000
        local = datetime.fromtimestamp(ms / 1000, tz=NZ)
        if START_LOCAL <= local <= END_LOCAL:
            pts.append(
                {
                    "t": ms,
                    "lat": lat,
                    "lon": lon,
                    "spd": pt.get("speed"),
                    "acc": pt.get("accuracy"),
                }
            )
    pts.sort(key=lambda p: p["t"])

    print("Session 343fd3ee — A2 moving test (v1.0.34)")
    print("Window: 7:20–7:30am NZST, 1 Jul 2026")
    print(f"Session started: 07:21:07 NZST  |  total points fetched: {len(route)}")
    print(f"GPS fixes in window: {len(pts)}")

    if not pts:
        print("No GPS in that window.")
        return

    gaps = [(pts[i]["t"] - pts[i - 1]["t"]) / 1000 for i in range(1, len(pts))]
    dur = (pts[-1]["t"] - pts[0]["t"]) / 1000
    dist = 0.0
    for i in range(1, len(pts)):
        dlat = (pts[i]["lat"] - pts[i - 1]["lat"]) * 111320
        dlon = (pts[i]["lon"] - pts[i - 1]["lon"]) * 111320 * 0.85
        dist += (dlat**2 + dlon**2) ** 0.5

    speeds = [p["spd"] for p in pts if p.get("spd") is not None]
    print(f"\nDuration: {dur:.0f}s  |  rate: {len(pts) / max(dur, 1):.2f} Hz")
    print(f"Distance: {dist:.0f} m ({dist / 1000:.2f} km)")
    if speeds:
        print(
            f"Speed: avg {statistics.mean(speeds) * 3.6:.1f} km/h  "
            f"max {max(speeds) * 3.6:.1f} km/h"
        )
    if gaps:
        p95 = sorted(gaps)[min(len(gaps) - 1, int(len(gaps) * 0.95))]
        print(
            f"Gaps: median {statistics.median(gaps):.2f}s  p95 {p95:.2f}s  "
            f"max {max(gaps):.1f}s  >10s: {sum(1 for g in gaps if g > 10)}"
        )

    l0 = datetime.fromtimestamp(pts[0]["t"] / 1000, tz=NZ)
    l1 = datetime.fromtimestamp(pts[-1]["t"] / 1000, tz=NZ)
    print(f"First fix {l0.strftime('%H:%M:%S')}  last fix {l1.strftime('%H:%M:%S')} NZST")
    print("\nTrack sample:")
    step = max(1, len(pts) // 8)
    for p in pts[::step][:10]:
        lt = datetime.fromtimestamp(p["t"] / 1000, tz=NZ).strftime("%H:%M:%S")
        spd_kmh = (p["spd"] or 0) * 3.6
        acc = p.get("acc")
        acc_s = f"acc={acc:.0f}m" if acc is not None else ""
        print(f"  {lt}  {p['lat']:.5f}, {p['lon']:.5f}  {spd_kmh:.0f} km/h  {acc_s}")

    ok = (
        len(pts) >= 100
        and dur >= 400
        and dist >= 500
        and (not gaps or statistics.median(gaps) <= 2.0)
        and sum(1 for g in gaps if g > 10) == 0
    )
    print("\nVerdict:", "GOOD — steady GPS while moving" if ok else "PARTIAL — some gaps or short window")


if __name__ == "__main__":
    main()
