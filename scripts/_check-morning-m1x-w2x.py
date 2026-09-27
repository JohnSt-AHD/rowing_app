#!/usr/bin/env python3
"""Morning live check: M1x TM + W2x EH reporting and speed accuracy."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICES = ["M1x TM", "W2x EH"]
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def split500(speed):
    if speed is None or speed < 0.25:
        return None
    sec = 500 / float(speed)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def analyze_window(gps, label):
    if len(gps) < 2:
        print(f"  {label}: only {len(gps)} fixes")
        return None
    gps = sorted(gps, key=lambda x: x["t"])
    segs = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = haversine_m(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        if dt > 0:
            segs.append({"dt": dt, "dist": dist, "spd": dist / dt})
    gaps = [s["dt"] for s in segs]
    gs = sorted(gaps)
    normal = [s for s in segs if 1.5 <= s["dt"] <= 8 and s["dist"] >= 1]
    span = (gps[-1]["t"] - gps[0]["t"]) / 1000
    total_dist = sum(s["dist"] for s in segs)
    accs = [p["acc"] for p in gps if p.get("acc") is not None]
    big = [s for s in segs if s["dt"] >= 8]
    return {
        "label": label,
        "fixes": len(gps),
        "span_min": round(span / 60, 1),
        "median_gap_s": round(statistics.median(gaps), 2),
        "p95_gap_s": round(gs[int(0.95 * (len(gs) - 1))], 2),
        "max_gap_s": round(max(gaps), 1),
        "gaps_ge_8s": len(big),
        "gaps_ge_10s": sum(1 for g in gaps if g >= 10),
        "micro_lt_0_75s": sum(1 for g in gaps if g < 0.75),
        "segment_med_mps": round(statistics.median([s["spd"] for s in normal]), 2) if normal else None,
        "path_mps": round(total_dist / span, 2) if span > 0 else None,
        "acc_med_m": round(statistics.median(accs), 1) if accs else None,
        "worst_gaps": [
            f"{s['dt']:.1f}s / {s['dist']:.0f}m / {s['spd']:.2f}m/s"
            for s in sorted(big, key=lambda x: x["dt"], reverse=True)[:4]
        ],
    }


def watch_device(device_id, polls=15, interval_s=3):
    ages, jumps, spikes = [], [], []
    prev = None
    for i in range(polls):
        mp = get("/api/map-positions?onlineSec=600&staleSec=7200")
        pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == device_id), None)
        if not pos:
            return {"found": False}
        ages.append(pos.get("fixAgeSec"))
        if prev:
            d = haversine_m(prev["latitude"], prev["longitude"], pos["latitude"], pos["longitude"])
            jumps.append(d)
            if (pos.get("fixAgeSec") or 0) >= 8 or d > 25:
                spikes.append({"fixAge": pos.get("fixAgeSec"), "jump_m": round(d, 1)})
        prev = pos
        time.sleep(interval_s)
    return {
        "found": True,
        "fixAge_med": round(statistics.median(ages), 1),
        "fixAge_max": max(ages),
        "fixAge_ge_8": sum(1 for a in ages if (a or 0) >= 8),
        "jump_med_m": round(statistics.median(jumps), 1) if jumps else None,
        "jump_max_m": round(max(jumps), 1) if jumps else None,
        "spikes": spikes,
    }


def check_device(device_id):
    print(f"\n{'='*64}\n  {device_id}\n{'='*64}")
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == device_id), None)
    if not pos:
        print("  NOT on map (offline or no GPS)")
        sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id))
        if sess.get("sessions"):
            s = sess["sessions"][0]
            print(f"  latest session {s['session_id'][:8]} ended={s.get('ended_at')} samples={s.get('sample_count')}")
        return

    legacy = pos.get("gpsFixMs") is None and pos.get("gpsProvider") is None
    print(f"  online={pos.get('online')}  app={'legacy' if legacy else 'debug/new'}")
    print(
        f"  lastSeen={pos.get('lastSeenAgoSec')}s  fixAge={pos.get('fixAgeSec')}s"
        f"  acc={round(pos.get('accuracy') or 0, 1)}m  stale={pos.get('telemetryStale')}"
    )
    disp, path = pos.get("displaySpeedMps"), pos.get("pathSpeedMps")
    print(
        f"  LIVE ticket(display) {round(disp or 0, 2)} m/s ({split500(disp)}/500)"
        f"  |  path30s {round(path or 0, 2)} m/s ({split500(path)}/500)"
    )
    print(
        f"  stroke={pos.get('displayStrokeRate') or pos.get('strokeRate')}"
        f"  capsize={pos.get('capsize')}"
    )

    sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get("sessions") or []
    if not sessions:
        print("  no sessions")
        return
    s0 = sessions[0]
    sid = s0["session_id"]
    track = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get("track") or []
    now_ms = int(datetime.now(AUCKLAND).timestamp() * 1000)

    # morning window: today from 05:00 NZ
    morning_start = int(datetime.now(AUCKLAND).replace(hour=5, minute=0, second=0, microsecond=0).timestamp() * 1000)
    gps_morning = [{"t": p["t"], "lat": p["lat"], "lon": p["lon"], "acc": p.get("acc")} for p in track if p.get("lat") and p["t"] >= morning_start]
    gps_30 = [p for p in gps_morning if p["t"] >= now_ms - 30 * 60 * 1000]
    gps_60 = [p for p in gps_morning if p["t"] >= now_ms - 60 * 60 * 1000]

    print(f"\n  session {sid[:8]} active={s0.get('ended_at') is None} started={s0.get('started_at')}")
    for stats in [
        analyze_window(gps_30, "last 30 min"),
        analyze_window(gps_60, "last 60 min"),
        analyze_window(gps_morning, "since 05:00 NZ"),
    ]:
        if not stats:
            continue
        print(f"\n  [{stats['label']}] fixes={stats['fixes']} span={stats['span_min']}min")
        print(
            f"    gap med={stats['median_gap_s']}s p95={stats['p95_gap_s']}s max={stats['max_gap_s']}s"
            f"  ge8s={stats['gaps_ge_8s']} ge10s={stats['gaps_ge_10s']} micro-bursts={stats['micro_lt_0_75s']}"
        )
        print(
            f"    ground segment med {stats['segment_med_mps']} m/s ({split500(stats['segment_med_mps'])}/500)"
            f"  |  overall path {stats['path_mps']} m/s ({split500(stats['path_mps'])}/500)"
            f"  |  acc med {stats['acc_med_m']}m"
        )
        if stats["worst_gaps"]:
            print(f"    worst gaps: {', '.join(stats['worst_gaps'])}")

        if stats["segment_med_mps"] and disp is not None:
            delta = disp - stats["segment_med_mps"]
            print(f"    display vs ground delta: {delta:+.2f} m/s", end="")
            if abs(delta) <= 0.4:
                print("  OK")
            elif abs(delta) <= 0.8:
                print("  OK-ish (EMA lag)")
            else:
                print("  WARN display diverging")

    print("\n  fixAge watch (~45s)...")
    w = watch_device(device_id, polls=15, interval_s=3)
    if w.get("found"):
        print(
            f"    fixAge med={w['fixAge_med']}s max={w['fixAge_max']}s ge8={w['fixAge_ge_8']}"
            f"  poll jump med={w['jump_med_m']}m max={w['jump_max_m']}m"
        )
        if w["spikes"]:
            print(f"    spikes: {w['spikes']}")


def main():
    print(f"Morning check — {datetime.now(AUCKLAND).strftime('%Y-%m-%d %H:%M:%S')} NZ")
    for d in DEVICES:
        check_device(d)


if __name__ == "__main__":
    main()
