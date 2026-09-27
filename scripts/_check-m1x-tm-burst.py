#!/usr/bin/env python3
import json
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


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def gap_stats(ts_ms):
    ts = sorted(t for t in ts_ms if t)
    if len(ts) < 2:
        return None
    gaps = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
    gs = sorted(gaps)
    dur = (ts[-1] - ts[0]) / 1000
    burst_windows = 0
    for i, t0 in enumerate(ts):
        cnt = sum(1 for t in ts if t0 <= t <= t0 + 5000)
        if cnt >= 4:
            burst_windows += 1
    return {
        "n": len(ts),
        "dur_min": round(dur / 60, 1),
        "median_gap": round(statistics.median(gaps), 2),
        "p95_gap": round(gs[int(0.95 * (len(gs) - 1))], 2),
        "max_gap": round(max(gaps), 2),
        "hz": round(len(ts) / dur, 3) if dur else 0,
        "le_1s": sum(1 for g in gaps if g <= 1.0),
        "le_1_5s": sum(1 for g in gaps if g <= 1.5),
        "1_5_to_4s": sum(1 for g in gaps if 1.5 < g <= 4.0),
        "gt_4s": sum(1 for g in gaps if g > 4.0),
        "burst_5s_ge4": burst_windows,
    }


def fmt_nz(ms):
    return datetime.fromtimestamp(ms / 1000, tz=AUCKLAND).strftime("%Y-%m-%d %H:%M:%S")


def analyze_range(label, frm, to):
    data = get(
        f"/api/history?format=dashboard&sessionId={SID}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    )
    track = data.get("track") or []
    gps = [p for p in track if p.get("lat") is not None]
    all_ts = [p["t"] for p in track]
    gps_ts = [p["t"] for p in gps]
    print(f"\n=== {label} samples={len(track)} gps={len(gps)} ===")
    if all_ts:
        print(" all-sample", gap_stats(all_ts))
    if gps_ts:
        print(" gps-only", gap_stats(gps_ts))
    if gps_ts:
        gaps = []
        ts = sorted(gps_ts)
        for i in range(1, len(ts)):
            gaps.append((ts[i] - ts[i - 1]) / 1000)
        if gaps:
            # show worst burst clusters
            worst = sorted(range(len(gaps)), key=lambda i: gaps[i])[:5]
            print(" shortest gps gaps (burst hints):")
            for i in worst:
                print(f"  {fmt_nz(ts[i])} -> {fmt_nz(ts[i+1])} gap={gaps[i]:.2f}s")


# Live poll map
print("=== Live map poll (8 x 3s) ===")
prev = None
for i in range(8):
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
    if not pos:
        print(i, "missing")
    else:
        row = {
            "fixAge": pos.get("fixAgeSec"),
            "display": pos.get("displayFixAgeSec"),
            "lastSeen": pos.get("lastSeenAgoSec"),
            "fixMs": pos.get("gpsFixMs"),
            "uploadLag": pos.get("uploadLagSec"),
            "speed": round(pos.get("displaySpeedMps") or 0, 2),
        }
        delta = None
        if prev and pos.get("fixMs"):
            delta = pos["fixMs"] - prev.get("fixMs", 0)
        print(i, row, "fixMs_delta_ms" if delta is None else f"fixMs_delta={delta}ms")
        prev = pos
    time.sleep(3)

# Yesterday NZ morning + afternoon windows (capsize was ~06:29, ~06:47 NZ on Jul 27)
for label, start_nz, mins in [
    ("Yesterday NZ 06:00-07:30 (capsize window)", "2026-07-27T06:00:00+12:00", 90),
    ("Yesterday NZ 12:00-13:00", "2026-07-27T12:00:00+12:00", 60),
    ("Today NZ last 30m", None, 30),
]:
    if start_nz:
        start = datetime.fromisoformat(start_nz).astimezone(timezone.utc)
        end = start + timedelta(minutes=mins)
    else:
        end = datetime.now(timezone.utc)
        start = end - timedelta(minutes=mins)
    frm = start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to = end.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    analyze_range(label, frm, to)

# Compare with another live device if present
mp = get("/api/map-positions?onlineSec=600&staleSec=3600")
others = [p for p in mp.get("positions", []) if p.get("deviceId") != DEVICE][:3]
print("\n=== Other online devices (reference) ===")
for p in others:
    print(
        p.get("deviceId"),
        "fixAge",
        p.get("fixAgeSec"),
        "fixMs",
        p.get("gpsFixMs"),
        "lastSeen",
        p.get("lastSeenAgoSec"),
    )
