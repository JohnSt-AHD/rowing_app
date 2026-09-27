#!/usr/bin/env python3
"""Quick live check for A2 — map positions, ingest rate, history gaps."""
import json
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = sys.argv[1] if len(sys.argv) > 1 else "A2"
POLLS = int(sys.argv[2]) if len(sys.argv) > 2 else 6
INTERVAL = float(sys.argv[3]) if len(sys.argv) > 3 else 5.0


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=60) as r:
        return json.load(r)


def to_ms(t):
    if t is None:
        return None
    if isinstance(t, (int, float)):
        return float(t)
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


print(f"=== map-positions poll ({POLLS} x {INTERVAL}s) — {UID} ===")
prev_fix = None
prev_cnt = None
for i in range(POLLS):
    m = get("/api/map-positions?onlineSec=600&staleSec=3600")
    p = next((x for x in m.get("positions", []) if x.get("deviceId") == UID), None)
    d = get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1")
    dev = next((x for x in d.get("devices", []) if x.get("deviceId") == UID), None)
    cnt = (dev or {}).get("gps", {}).get("count")
    d_cnt = None if prev_cnt is None or cnt is None else cnt - prev_cnt
    if not p:
        print(f"[{i}] {UID} not on map")
    else:
        fix_ms = p.get("fixMs")
        d_fix = None if prev_fix is None or fix_ms is None else (fix_ms - prev_fix) / 1000
        parts = [
            f"[{i}] seen={p.get('lastSeenAgoSec')}s",
            f"fixAge={p.get('fixAgeSec')}s",
            f"speed={p.get('speed')}",
            f"stroke={p.get('strokeRate')}",
        ]
        if d_fix is not None:
            parts.append(f"dFix={d_fix:.1f}s")
        if d_cnt is not None:
            parts.append(f"+{d_cnt} samples/{INTERVAL:.0f}s")
        print(" ".join(parts))
        prev_fix = fix_ms
    prev_cnt = cnt
    if i < POLLS - 1:
        time.sleep(INTERVAL)

print(f"\n=== /api/devices {UID} ===")
if dev:
    gps = dev.get("gps") or {}
    print(
        f"online={dev.get('online')} seen={dev.get('lastSeenAgoSec')}s "
        f"gpsHz={gps.get('rateHz')} cnt={gps.get('count')} fixAge={gps.get('ageSec')}s "
        f"ingestAgo={gps.get('ingestAgoSec')}s session={str(dev.get('sessionId',''))[:8]}"
    )
    last = gps.get("last") or {}
    print(f"last fix: spd={last.get('spd')} acc={last.get('acc')} lat={last.get('lat')}")
else:
    print(f"{UID} not in device list")

print(f"\n=== history last 30 min ===")
now = datetime.now(timezone.utc)
frm = (now - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
to = now.isoformat().replace("+00:00", "Z")
route = get(f"/api/history?uniqueId={UID}&from={quote(frm)}&to={quote(to)}")
if not isinstance(route, list):
    print("unexpected response:", route)
else:
    pts = [p for p in route if isinstance(p, dict) and p.get("lat") is not None]
    print(f"GPS points: {len(pts)}")
    if len(pts) >= 2:
        times = [to_ms(p.get("t") or p.get("time")) for p in pts]
        gaps = [(times[i] - times[i - 1]) / 1000 for i in range(1, len(times))]
        near5 = sum(1 for g in gaps if 4 <= g <= 6)
        print(
            f"gaps (s): min={min(gaps):.1f} med={statistics.median(gaps):.1f} "
            f"max={max(gaps):.1f} | ~5s intervals: {near5}/{len(gaps)}"
        )
        spds = [p.get("spd") for p in pts if p.get("spd") is not None]
        if spds:
            print(f"speed m/s: last5={[round(s, 2) for s in spds[-5:]]}")
