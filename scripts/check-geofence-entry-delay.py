#!/usr/bin/env python3
"""Timeline of gap sizes — find 5s stretches at session start (geofence speed-up delay)."""
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def analyze(uid):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    if not sessions:
        return
    s = sessions[0]
    tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
    gps = sorted([p for p in tr if p.get("lat") is not None], key=lambda p: p["t"])
    if len(gps) < 5:
        print(f"{uid}: insufficient data")
        return
    gaps = [(gps[i]["t"] - gps[i - 1]["t"]) / 1000 for i in range(1, len(gps))]
    t0 = gps[0]["t"]
    st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)

    print(f"\n=== {uid} session {s['session_id'][:8]} started {st.strftime('%H:%M:%S')} NZ ===")
    print(f"span={(gps[-1]['t']-t0)/60000:.1f}min  n={len(gps)}  med={statistics.median(gaps):.3f}s")

    for label, sec in [("first 60s", 60), ("first 120s", 120), ("full", 1e9)]:
        sub = [g for i, g in enumerate(gaps) if (gps[i + 1]["t"] - t0) / 1000 <= sec]
        if not sub:
            continue
        b1 = 100 * sum(1 for g in sub if 0.75 <= g <= 1.35) / len(sub)
        b5 = 100 * sum(1 for g in sub if 3.5 <= g <= 6.5) / len(sub)
        print(f"  {label}: n={len(sub)}  1s={b1:.0f}%  5s={b5:.0f}%  med={statistics.median(sub):.2f}s")

    # first 5s gap index
    for i, g in enumerate(gaps[:60]):
        if g >= 4.5:
            rel = (gps[i + 1]["t"] - t0) / 1000
            print(f"  first slow gap @ +{rel:.0f}s: {g:.2f}s")

    print(f"  gap histogram: {Counter(round(g, 1) for g in gaps).most_common(8)}")


for u in ("H6", "F4"):
    analyze(u)
