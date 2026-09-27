#!/usr/bin/env python3
"""Poll a device session and compare GPS pattern to W1x LS baseline."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
AUCKLAND = timezone(timedelta(hours=12))

W1X_BASELINE = {
    "interval_med": 1.0,
    "dup_pct": 79.9,
    "teleports_35m_8s": 76,
    "acc_med": 10.0,
    "acc_max": 356.9,
    "acc_gt50_pct": 29.0,
}


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def analyze_track(track):
    gps = sorted([p for p in track if p.get("lat") is not None], key=lambda x: x["t"])
    if len(gps) < 2:
        return {"fixes": len(gps)}
    gaps = []
    dists = []
    tele = 0
    accs = [p.get("acc") for p in gps if p.get("acc") is not None]
    src = {}
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        gaps.append(dt)
        dists.append(dist)
        if dt <= 8 and dist > 35:
            tele += 1
    for p in gps[-20:]:
        ss = p.get("gpsSampleSource") or (p.get("attributes") or {}).get("sampleSource") or "none"
        src[ss] = src.get(ss, 0) + 1
    return {
        "fixes": len(gps),
        "interval_med": round(statistics.median(gaps), 2),
        "dup_pct": round(100 * sum(1 for d in dists if d < 0.5) / len(dists), 1),
        "med_dist_m": round(statistics.median(dists), 1),
        "max_jump_m": round(max(dists), 1),
        "teleports_35m_8s": tele,
        "acc_med": round(statistics.median(accs), 1) if accs else None,
        "acc_max": round(max(accs), 1) if accs else None,
        "acc_gt50_pct": round(100 * sum(1 for a in accs if a > 50) / len(accs), 1) if accs else 0,
        "sources_tail20": src,
    }


def map_row(device_id):
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == device_id), None)
    if not pos:
        return None
    return {
        "online": pos.get("online"),
        "acc": round(pos.get("accuracy") or 0, 1),
        "provider": pos.get("gpsProvider"),
        "source": pos.get("gpsSampleSource"),
        "fixAge": pos.get("fixAgeSec"),
        "lat": pos.get("latitude"),
        "lon": pos.get("longitude"),
        "speed": pos.get("speed"),
        "path": pos.get("pathSpeedMps"),
    }


def poll_device(device_id, polls=8, gap_s=5):
    print(f"\n{'=' * 60}\n  LIVE POLL: {device_id} ({polls}x every {gap_s}s)\n{'=' * 60}")
    jumps = []
    prev = None
    rows = []
    for i in range(polls):
        row = map_row(device_id)
        sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get("sessions") or []
        track = []
        if sess:
            track = get(
                "/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sess[0]["session_id"])
            ).get("track") or []
        a = analyze_track(track)
        if row:
            if prev and row["lat"] and prev["lat"]:
                jump = hav(prev["lat"], prev["lon"], row["lat"], row["lon"])
                row["poll_jump_m"] = round(jump, 1)
                jumps.append(jump)
            prev = row
            rows.append(row)
        now = datetime.now(AUCKLAND).strftime("%H:%M:%S")
        print(f"  [{now}] poll {i+1}: map={row} session={a}")
        if i < polls - 1:
            time.sleep(gap_s)
    if jumps:
        print(
            f"  map poll jumps: med={statistics.median(jumps):.1f}m max={max(jumps):.1f}m "
            f"(n={len(jumps)})"
        )
    return rows, a


def compare(device_id):
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get("sessions") or []
    if not sess:
        print(f"No session for {device_id}")
        return
    st = datetime.fromisoformat(str(sess[0]["started_at"]).replace("Z", "+00:00")).astimezone(AUCKLAND)
    print(f"\nSession started {st.strftime('%Y-%m-%d %H:%M:%S')} NZ, samples={sess[0].get('sample_count')}")
    _, final = poll_device(device_id, polls=10, gap_s=5)
    print(f"\n  {device_id} final session stats: {final}")
    print(f"  W1x LS baseline (on water, 1Hz): {W1X_BASELINE}")
    same_pattern = (
        final.get("interval_med") == 1.0
        and final.get("dup_pct", 0) > 50
        and final.get("teleports_35m_8s", 0) > 5
    )
    print(
        f"\n  Same bad pattern as W1x LS? {'LIKELY YES' if same_pattern else 'NO — different so far'}"
    )
    if final.get("fixes", 0) < 30:
        print("  (Short session — re-run poll after 2–3 min for a firmer read.)")


if __name__ == "__main__":
    compare("M4x JS")
