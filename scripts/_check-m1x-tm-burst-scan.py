#!/usr/bin/env python3
import json
import statistics
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
SID = "315e22f9-3c4e-4a56-a82c-6d308f1623cd"
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def dedupe_burst(pts, min_gap_s=0.75):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap_s:
            out.append(p)
    return out


def analyze_gps(gps, label):
    if len(gps) < 2:
        print(label, "too few points", len(gps))
        return
    ts = sorted(p["t"] for p in gps)
    gaps = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
    gs = sorted(gaps)
    ded = dedupe_burst(gps)
    micro = [(ts[i], ts[i + 1], gaps[i]) for i in range(len(gaps)) if gaps[i] < 0.75]
    print(f"\n=== {label} ===")
    print(f" raw={len(gps)} deduped={len(ded)} dur_min={(ts[-1]-ts[0])/60000:.1f}")
    print(
        f" median={statistics.median(gaps):.2f}s p95={gs[int(0.95*(len(gs)-1))]:.2f}s"
        f" min={min(gaps):.2f}s max={max(gaps):.2f}s"
    )
    print(f" micro-bursts (<0.75s): {len(micro)}")
    if micro:
        print(" first 8 micro-bursts (NZ time):")
        for a, b, g in micro[:8]:
            print(
                " ",
                datetime.fromtimestamp(a / 1000, tz=AUCKLAND).strftime("%Y-%m-%d %H:%M:%S"),
                f"gap={g:.3f}s",
            )
    bands = Counter()
    for g in gaps:
        if g < 0.75:
            bands["<0.75s burst"] += 1
        elif g <= 1.5:
            bands["0.75-1.5s"] += 1
        elif g <= 4.5:
            bands["1.5-4.5s (economy)"] += 1
        elif g <= 12:
            bands["4.5-12s"] += 1
        else:
            bands[">12s stall"] += 1
    print(" gap bands:", dict(bands))


dash = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(SID))
track = dash.get("track") or []
gps_all = [p for p in track if p.get("lat") is not None]
print("session gps total", len(gps_all))

# Yesterday full day NZ
y0 = int(datetime(2026, 7, 27, 0, 0, 0, tzinfo=AUCKLAND).timestamp() * 1000)
y1 = int(datetime(2026, 7, 28, 0, 0, 0, tzinfo=AUCKLAND).timestamp() * 1000)
gps_yday = [p for p in gps_all if y0 <= p["t"] < y1]
analyze_gps(gps_yday, "Yesterday NZ full day")

# Today NZ
t0 = int(datetime(2026, 7, 28, 0, 0, 0, tzinfo=AUCKLAND).timestamp() * 1000)
t1 = int(datetime.now(AUCKLAND).timestamp() * 1000)
gps_today = [p for p in gps_all if t0 <= p["t"] <= t1]
analyze_gps(gps_today, "Today NZ so far")

# Live now
mp = get("/api/map-positions?onlineSec=600&staleSec=3600")
pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == "M1x TM"), None)
print("\n=== Live now ===")
print(json.dumps(pos, indent=2, default=str))

# Rolling 10-min windows yesterday with most micro-bursts
if gps_yday:
    by_window = {}
    for p in gps_yday:
        bucket = p["t"] // (10 * 60 * 1000)
        by_window.setdefault(bucket, []).append(p)
    scored = []
    for bucket, pts in by_window.items():
        pts = sorted(pts, key=lambda x: x["t"])
        if len(pts) < 2:
            continue
        gaps = [(pts[i]["t"] - pts[i - 1]["t"]) / 1000 for i in range(1, len(pts))]
        micro = sum(1 for g in gaps if g < 0.75)
        if micro:
            scored.append((micro, bucket, len(pts), statistics.median(gaps)))
    scored.sort(reverse=True)
    print("\n=== Yesterday 10-min windows with micro-bursts ===")
    for micro, bucket, n, med in scored[:6]:
        start = datetime.fromtimestamp(bucket * 600, tz=AUCKLAND)
        print(f" {start.strftime('%H:%M')} micro={micro} pts={n} median={med:.2f}s")

# capsize + stalls
caps = [p for p in track if p.get("capsize")]
print("\ncapsize points total", len(caps))
for p in caps[-10:]:
    t = datetime.fromtimestamp(p["t"] / 1000, tz=AUCKLAND)
    print(" ", t.strftime("%Y-%m-%d %H:%M:%S"))

if gps_yday:
    gps = sorted(gps_yday, key=lambda x: x["t"])
    print("\nYesterday stalls >60s:")
    for i in range(1, len(gps)):
        g = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        if g > 60:
            t = datetime.fromtimestamp(gps[i]["t"] / 1000, tz=AUCKLAND)
            print(f"  {g/60:.1f} min gap ending {t.strftime('%H:%M:%S')}")
