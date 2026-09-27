#!/usr/bin/env python3
"""Quick GPS gap check for a dashboard history JSON file."""
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
if not path:
    print("usage: check-morning-gps.py <dashboard-history.json>")
    raise SystemExit(1)

data = json.loads(path.read_text(encoding="utf-8"))
pts = [p for p in data.get("track", []) if p.get("lat") is not None]
pts.sort(key=lambda p: p["t"])
if not pts:
    print("no GPS points")
    raise SystemExit(0)

seg = pts[-80:]
print(f"{data.get('uniqueId', '?')} — last {len(seg)} GPS points")
big = []
for i, p in enumerate(seg):
    if i == 0:
        continue
    gap = (seg[i]["t"] - seg[i - 1]["t"]) / 1000
    if gap > 15:
        t = datetime.fromtimestamp(seg[i]["t"] / 1000, tz=timezone.utc)
        big.append((gap, t))
        print(f"  gap {gap:.0f}s before {t.strftime('%Y-%m-%d %H:%M:%S')}Z")

if len(seg) >= 2:
    gaps = [(seg[i]["t"] - seg[i - 1]["t"]) / 1000 for i in range(1, len(seg))]
    print(
        f"median gap {statistics.median(gaps):.1f}s  "
        f"p95 {sorted(gaps)[int(0.95 * len(gaps))]:.1f}s  "
        f"max {max(gaps):.0f}s"
    )

last = datetime.fromtimestamp(seg[-1]["t"] / 1000, tz=timezone.utc)
now = datetime.now(timezone.utc)
print(f"last fix {last.isoformat()} ({(now - last).total_seconds():.0f}s ago)")
