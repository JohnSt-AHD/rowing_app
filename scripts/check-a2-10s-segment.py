#!/usr/bin/env python3
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def dedupe_burst(pts, min_gap_s=0.75):
    if not pts:
        return []
    out = [pts[0]]
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap_s:
            out.append(p)
    return out


sessions = get("/api/history?list=sessions&uniqueId=A2").get("sessions", [])
s = next(x for x in sessions if x["session_id"].startswith("1df4736a"))
tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
rows = sorted([{"t": p["t"]} for p in tr if p.get("lat")], key=lambda r: r["t"])

seg_start = datetime(2026, 7, 2, 8, 6, 23, tzinfo=NZ).timestamp() * 1000
seg_end = datetime(2026, 7, 2, 8, 13, 30, tzinfo=NZ).timestamp() * 1000
raw = [r for r in rows if seg_start <= r["t"] <= seg_end]
deduped = dedupe_burst(raw)

for label, pts in [("raw", raw), ("deduped (>=0.75s)", deduped)]:
    gaps = [(pts[i]["t"] - pts[i - 1]["t"]) / 1000 for i in range(1, len(pts))]
    dur = (pts[-1]["t"] - pts[0]["t"]) / 1000
    in10 = sum(1 for g in gaps if 8.0 <= g <= 12.5)
    in20 = sum(1 for g in gaps if 18.0 <= g <= 22.0)
    print(f"\n{label}: {len(pts)} pts over {dur:.0f}s ({dur/60:.1f} min)")
    if gaps:
        print(f"  gap median={statistics.median(gaps):.2f}s mean={statistics.mean(gaps):.2f}s")
        print(f"  10s band (8-12.5s): {in10}/{len(gaps)} = {100*in10/len(gaps):.1f}%")
        print(f"  ~20s band (18-22s): {in20}/{len(gaps)} = {100*in20/len(gaps):.1f}%")
        print(f"  top gaps: {Counter(round(g, 1) for g in gaps).most_common(6)}")
        print(f"  expected @10s: ~{dur/10:.0f} pts")
