#!/usr/bin/env python3
"""Trend W1x LS GPS reporting across recent sessions."""
import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def analyze(track):
    gps = sorted([p for p in track if p.get("lat") is not None], key=lambda x: x["t"])
    if len(gps) < 2:
        return None
    gaps = []
    dists = []
    tele = 0
    src = {}
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        gaps.append(dt)
        dists.append(dist)
        if dt <= 8 and dist > 35:
            tele += 1
    for p in gps[-50:]:
        attrs = p.get("attributes") or {}
        ss = attrs.get("sampleSource") or p.get("sampleSource") or "none"
        src[ss] = src.get(ss, 0) + 1
    return {
        "fixes": len(gps),
        "med_gap_s": round(statistics.median(gaps), 2),
        "med_dist_m": round(statistics.median(dists), 1),
        "dup_pct": round(100 * sum(1 for d in dists if d < 0.5) / len(dists), 1),
        "teleports_35m_8s": tele,
        "sources_tail50": src,
    }


def print_device(uid, limit=10):
    print(f"\n{'=' * 60}\n  {uid}\n{'=' * 60}")
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(uid)).get("sessions") or []
    for s in sess[:limit]:
        st = datetime.fromisoformat(str(s["started_at"]).replace("Z", "+00:00")).astimezone(AUCKLAND)
        track = get(
            "/api/history?format=dashboard&sessionId=" + urllib.parse.quote(s["session_id"])
        ).get("track") or []
        a = analyze(track)
        print(f"  {st.strftime('%Y-%m-%d %H:%M')} n={s.get('sample_count')} {a}")


def main():
    print_device("W1x LS", 15)
    print_device("M1x TM", 8)

    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    for uid in ["W1x LS", "M1x TM"]:
        pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == uid), None)
        if pos:
            print(f"\n  {uid} live: provider={pos.get('gpsProvider')} source={pos.get('gpsSampleSource')} "
                  f"acc={pos.get('accuracy')} fixAge={pos.get('fixAgeSec')}s")


if __name__ == "__main__":
    main()
