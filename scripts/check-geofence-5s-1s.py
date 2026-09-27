#!/usr/bin/env python3
"""User 5s + ggl 1s geofence — verify geofence speeds up reporting."""
import json
import statistics
import urllib.request
from collections import Counter

BASE = "https://rowing-app-recorder-pwa.vercel.app"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def dedupe(pts, min_gap=0.75):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap:
            out.append(p)
    return out


def band_pct(gaps, lo, hi):
    return 100 * sum(1 for g in gaps if lo <= g <= hi) / len(gaps) if gaps else 0


for uid in ("H6", "F4"):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    if not sessions:
        print(f"{uid}: no session")
        continue
    s = sessions[0]
    tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
    gps = sorted([p for p in tr if p.get("lat") is not None], key=lambda p: p["t"])
    ded = dedupe(gps)
    gaps = [(ded[i]["t"] - ded[i - 1]["t"]) / 1000 for i in range(1, len(ded))]
    dur = (gps[-1]["t"] - gps[0]["t"]) / 1000 if gps else 0
    park = sum(
        1
        for p in tr
        if isinstance(p, dict) and (p.get("attributes") or {}).get("inBoatPark")
    )
    med = statistics.median(gaps) if gaps else None
    pct_1 = band_pct(gaps, 0.75, 1.35)
    pct_5 = band_pct(gaps, 3.5, 6.5)
    if pct_1 >= 85 and med and 0.9 <= med <= 1.15:
        verdict = "PASS @1s (geofence override)"
    elif pct_5 >= 85 and med and 4 <= med <= 6:
        verdict = "FAIL — still @5s (user setting)"
    else:
        verdict = "MIXED"
    print(f"{uid} ({s['session_id'][:8]})  {verdict}")
    print(f"  span={dur/60:.1f}min  dedup={len(ded)}  rate={len(ded)/max(dur,1):.2f}/s")
    print(f"  med={med}s  1s_band={pct_1:.1f}%  5s_band={pct_5:.1f}%  inBoatPark={park}")
    print(f"  top gaps: {Counter(round(g, 2) for g in gaps).most_common(5)}")
    print()
