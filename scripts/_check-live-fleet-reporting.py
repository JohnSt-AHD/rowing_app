#!/usr/bin/env python3
"""Check live RowSafe/map devices: accuracy, intervals, speed; flag debug vs legacy app."""
import json
import math
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def analyze_session(device_id):
    sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get("sessions") or []
    if not sessions:
        return None
    s0 = sessions[0]
    sid = s0["session_id"]
    active = s0.get("ended_at") is None
    hist = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    track = [p for p in hist.get("track", []) if p.get("lat") is not None]
    if len(track) < 2:
        return {"session_id": sid, "active": active, "gps_points": len(track)}

    ts = [p["t"] for p in track]
    intervals = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
    accs = [p["acc"] for p in track if p.get("acc") is not None]
    speeds = [p.get("speed") for p in track if p.get("speed") is not None]
    sources = Counter(p.get("gpsSampleSource") for p in track)
    providers = Counter(p.get("gpsProvider") for p in track)
    has_debug = any(p.get("gpsProvider") or p.get("gpsSampleSource") for p in track)

    return {
        "session_id": sid[:8],
        "active": active,
        "started": s0.get("started_at"),
        "samples": s0.get("sample_count"),
        "gps_points": len(track),
        "interval_min": round(min(intervals), 2),
        "interval_med": round(sorted(intervals)[len(intervals) // 2], 2),
        "interval_max": round(max(intervals), 2),
        "acc_min": round(min(accs), 1) if accs else None,
        "acc_med": round(sorted(accs)[len(accs) // 2], 1) if accs else None,
        "acc_max": round(max(accs), 1) if accs else None,
        "phone_spd_max": round(max(speeds), 2) if speeds else None,
        "phone_spd_med": round(sorted(speeds)[len(speeds) // 2], 2) if speeds else None,
        "has_debug_fields": has_debug,
        "sample_sources": dict(sources),
        "providers": dict(providers),
    }


def main():
    mp = get("/api/map-positions?onlineSec=300&staleSec=7200&predictMode=rowing")
    positions = mp.get("positions") or []
    online = [p for p in positions if p.get("online")]
    stale_live = [p for p in positions if not p.get("online") and (p.get("lastSeenAgoSec") or 9999) < 600]

    print("=== ONLINE DEVICES (last 5 min) ===")
    if not online:
        print("  (none strictly online)")
    for p in sorted(online, key=lambda x: x.get("deviceId", "")):
        did = p.get("deviceId")
        legacy = p.get("gpsProvider") is None and p.get("gpsSampleSource") is None
        app = "LEGACY (no debug fields)" if legacy else "DEBUG app"
        print(f"\n--- {did} [{app}] ---")
        for k in [
            "lastSeenAgoSec",
            "ingestAgoSec",
            "gpsFixAgeSec",
            "accuracy",
            "pathSpeedMps",
            "displaySpeedMps",
            "speed",
            "course",
            "gpsProvider",
            "gpsSampleSource",
            "compass",
            "strokeRate",
            "displayStrokeRate",
            "capsize",
            "latitude",
            "longitude",
        ]:
            v = p.get(k)
            if v is not None:
                print(f"  {k}: {v}")
        sess = analyze_session(did)
        if sess:
            print("  session:", json.dumps(sess, indent=4))

    if stale_live:
        print("\n=== RECENTLY ACTIVE (<10 min, now offline) ===")
        for p in sorted(stale_live, key=lambda x: x.get("lastSeenAgoSec", 9999)):
            did = p.get("deviceId")
            legacy = p.get("gpsProvider") is None and p.get("gpsSampleSource") is None
            print(
                f"  {did}: lastSeen {p.get('lastSeenAgoSec')}s ago, "
                f"acc={p.get('accuracy')}m, pathSpd={p.get('pathSpeedMps')}, "
                f"dispSpd={p.get('displaySpeedMps')}, legacy={legacy}"
            )

    print("\n=== ALL POSITIONS SUMMARY ===")
    for p in sorted(positions, key=lambda x: x.get("deviceId", "")):
        did = p.get("deviceId")
        legacy = p.get("gpsProvider") is None and p.get("gpsSampleSource") is None
        print(
            f"  {did}: online={p.get('online')} lastSeen={p.get('lastSeenAgoSec')}s "
            f"acc={p.get('accuracy')} path={p.get('pathSpeedMps')} disp={p.get('displaySpeedMps')} "
            f"legacy={legacy}"
        )


if __name__ == "__main__":
    main()
