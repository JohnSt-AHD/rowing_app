#!/usr/bin/env python3
"""Analyze M4x JS drive test around 15:45 NZ."""
import json
import statistics
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M4x JS"
NZ = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def gap_stats(pts):
    gaps = [(pts[i]["t"] - pts[i - 1]["t"]) / 1000 for i in range(1, len(pts)) if pts[i]["t"] > pts[i - 1]["t"]]
    steady = [g for g in gaps if g >= 0.75]
    return gaps, steady


enc = urllib.parse.quote(UID)
sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []

print("=== Recent M4x JS sessions ===")
for s in sessions[:10]:
    st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    en = s.get("ended_at")
    end = (
        datetime.fromisoformat(en.replace("Z", "+00:00")).astimezone(NZ)
        if en
        else None
    )
    end_s = end.strftime("%H:%M:%S") if end else "open"
    print(
        f"{s['session_id'][:8]}  {st.strftime('%Y-%m-%d %H:%M:%S')}–{end_s} NZ  "
        f"samples={s.get('sample_count')}"
    )

win_start = datetime(2026, 8, 3, 15, 30, tzinfo=NZ)
win_end = datetime(2026, 8, 3, 16, 15, tzinfo=NZ)
drive_start = datetime(2026, 8, 3, 15, 40, tzinfo=NZ)
drive_end = datetime(2026, 8, 3, 16, 0, tzinfo=NZ)

print()
print("=== Sessions overlapping 15:30–16:15 NZ ===")
for s in sessions:
    st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    en = s.get("ended_at")
    end = (
        datetime.fromisoformat(en.replace("Z", "+00:00")).astimezone(NZ)
        if en
        else datetime.now(NZ)
    )
    if st > win_end or end < win_start:
        continue

    sid = s["session_id"]
    tr = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}").get("track") or []
    pts = sorted([p for p in tr if p.get("lat") is not None], key=lambda p: p["t"])
    if len(pts) < 2:
        print(f"{sid[:8]}: too few points ({len(pts)})")
        continue

    gaps, steady = gap_stats(pts)
    dur_min = (pts[-1]["t"] - pts[0]["t"]) / 60000
    med = statistics.median(steady) if steady else None
    top = Counter(round(g, 1) for g in steady).most_common(10)

    t0 = int(drive_start.timestamp() * 1000)
    t1 = int(drive_end.timestamp() * 1000)
    win = [p for p in pts if t0 <= p["t"] <= t1]
    _, wsteady = gap_stats(win) if len(win) > 1 else ([], [])
    wmed = statistics.median(wsteady) if wsteady else None

    print(f"\n{sid[:8]}  start={st.strftime('%H:%M:%S')}  pts={len(pts)}  dur={dur_min:.1f}min")
    print(f"  all: med={med}s  stalls>10s={sum(1 for g in gaps if g>10)}  stalls>30s={sum(1 for g in gaps if g>30)}")
    print(f"  top steady gaps: {top}")
    if win:
        srcs = Counter(p.get("sampleSource") or "?" for p in win).most_common()
        print(f"  15:40–16:00: {len(win)} pts  med={wmed}s  src={srcs}")
        print(f"  window gaps: {[round(g, 1) for g in wsteady[:20]]}")
