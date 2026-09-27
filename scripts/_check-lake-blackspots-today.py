#!/usr/bin/env python3
"""Today's lake piece: GPS/cell gap analysis by distance from start."""
import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICES = ["M1x TM", "W2x EH"]
AUCKLAND = timezone(timedelta(hours=12))
TODAY_START = datetime(2026, 7, 30, 6, 30, 0, tzinfo=AUCKLAND)


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fmt(t_ms):
    return datetime.fromtimestamp(t_ms / 1000, tz=AUCKLAND).strftime("%H:%M:%S")


def hav(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    x = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def latest_session_id(uid):
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(uid)).get("sessions") or []
    return sess[0]["session_id"] if sess else None


def track(uid):
    sid = latest_session_id(uid)
    if not sid:
        return sid, []
    data = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    gps = sorted(
        [p for p in (data.get("track") or []) if p.get("lat") is not None and p.get("lon") is not None],
        key=lambda x: x["t"],
    )
    return sid, gps


def cum_dist(gps):
    d = [0.0]
    for i in range(1, len(gps)):
        d.append(d[-1] + hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"]))
    return d


def analyze_today(uid):
    sid, gps_all = track(uid)
    if not sid:
        print(f"\n  {uid}: no session")
        return
    t0_ms = int(TODAY_START.timestamp() * 1000)
    gps = [p for p in gps_all if p["t"] >= t0_ms]
    print(f"\n{'='*70}\n  {uid} session {sid[:8]} — TODAY from {TODAY_START.strftime('%H:%M')} NZ")
    print(f"{'='*70}")
    if len(gps) < 5:
        print("  insufficient today data")
        return

    dist = cum_dist(gps)
    total_km = dist[-1] / 1000
    span_min = (gps[-1]["t"] - gps[0]["t"]) / 60000
    print(f"  fixes={len(gps)}  span={span_min:.0f}min  track={total_km:.1f}km")
    print(f"  start ({gps[0]['lat']:.5f},{gps[0]['lon']:.5f})")
    print(f"  end   ({gps[-1]['lat']:.5f},{gps[-1]['lon']:.5f})")

    gaps = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        if dt <= 0:
            continue
        gaps.append({"dt": dt, "i": i, "km": dist[i] / 1000, "lat": gps[i]["lat"], "lon": gps[i]["lon"], "t": gps[i]["t"]})

    dts = [g["dt"] for g in gaps]
    print(
        f"  gap median={statistics.median(dts):.2f}s p95={sorted(dts)[int(0.95*(len(dts)-1))]:.2f}s"
        f" max={max(dts):.1f}s"
    )
    for thr in (8, 15, 30, 60):
        n = sum(1 for d in dts if d >= thr)
        print(f"  gaps >={thr}s: {n}")

    # By distance bins (every 2km)
    bin_w = 2.0
    max_km = math.ceil(total_km / bin_w) * bin_w
    print(f"\n  GAPS BY DISTANCE (2km bins from today's start):")
    for b in range(0, int(max_km), int(bin_w)):
        lo, hi = float(b), float(b + bin_w)
        seg = [g for g in gaps if lo <= g["km"] < hi]
        if not seg:
            continue
        med = statistics.median(g["dt"] for g in seg)
        g8 = sum(1 for g in seg if g["dt"] >= 8)
        g15 = sum(1 for g in seg if g["dt"] >= 15)
        lat = statistics.mean(g["lat"] for g in seg)
        lon = statistics.mean(g["lon"] for g in seg)
        flag = " ***" if g15 else (" *" if g8 >= 5 else "")
        print(f"    {lo:4.0f}-{hi:4.0f}km  n={len(seg):4d}  med={med:5.2f}s  >=8s={g8:3d}  >=15s={g15:2d}"
              f"  ~({lat:.4f},{lon:.4f}){flag}")

    # Real blackouts today only
    black = [g for g in gaps if g["dt"] >= 15]
    if black:
        print(f"\n  TODAY BLACKOUTS (>=15s):")
        for g in sorted(black, key=lambda x: -x["dt"])[:20]:
            print(f"    {fmt(g['t'])} gap={g['dt']:.0f}s @ km={g['km']:.1f} ({g['lat']:.5f},{g['lon']:.5f})")

    # Detect sustained 10s cadence (likely legacy interval, not coverage)
    ten_runs = []
    run = 0
    run_start = None
    for g in gaps:
        if 9.5 <= g["dt"] <= 10.5:
            if run == 0:
                run_start = g
            run += 1
        else:
            if run >= 5:
                ten_runs.append((run, run_start, g))
            run = 0
    if run >= 5:
        ten_runs.append((run, run_start, gaps[-1]))
    if ten_runs:
        print(f"\n  SUSTAINED ~10s CADENCE (>=5 fixes, likely interval not blackout):")
        for n, start, end in sorted(ten_runs, key=lambda x: -x[0])[:5]:
            print(
                f"    {n} fixes ~10s from km={start['km']:.1f} ({start['lat']:.5f},{start['lon']:.5f})"
                f" to km={end['km']:.1f}"
            )


def main():
    print(f"Today lake black-spot scan @ {datetime.now(AUCKLAND).strftime('%H:%M:%S')} NZ")
    for uid in DEVICES:
        analyze_today(uid)


if __name__ == "__main__":
    main()
