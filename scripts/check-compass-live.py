#!/usr/bin/env python3
"""Check live RNZ ingest for compass fields."""
import json
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.status, json.load(r)


def main() -> None:
    print("=== Online devices (last 3 min) ===")
    _, dev = get("/api/devices?windowSec=300&onlineSec=180&includeMetrics=1")
    devices = dev.get("devices") or []
    print(f"count: {len(devices)}")
    for d in sorted(devices, key=lambda x: x.get("lastSeenAgoSec", 9999)):
        gps = d.get("gps") or {}
        print(
            f"  {d.get('deviceId')}: online={d.get('online')} "
            f"lastSeen={d.get('lastSeenAgoSec')}s "
            f"gpsHz={gps.get('rateHz')} count={gps.get('count')}"
        )

    print("\n=== Latest positions (compass in attributes) ===")
    _, pos = get("/api/positions?onlineSec=180")
    positions = pos.get("positions") or []
    print(f"count: {len(positions)} persisted={pos.get('persisted')}")
    for p in positions:
        attrs = p.get("attributes") or {}
        compass = attrs.get("compass")
        has_compass = compass is not None
        print(
            f"  {p.get('uniqueId')}: course={p.get('course')} "
            f"compass={compass} has_compass={has_compass} "
            f"speed={p.get('speed')} fix={p.get('fixTime')}"
        )

    print("\n=== Recent sessions ===")
    _, sess = get("/api/history?list=sessions")
    sessions = (sess.get("sessions") or [])[:10]
    for s in sessions:
        print(
            f"  {s.get('unique_id')} {str(s.get('session_id', ''))[:8]} "
            f"started={s.get('started_at')} samples={s.get('sample_count')}"
        )

    # Drill into most recent session with samples for raw gps.compass
    if sessions:
        sid = sessions[0]["session_id"]
        uid = sessions[0]["unique_id"]
        print(f"\n=== Raw samples for latest session {uid} / {sid[:8]} ===")
        _, dash = get(
            f"/api/history?format=dashboard&sessionId={sid}&windowSec=600"
        )
        samples = dash.get("samples") or []
        gps_samples = [s for s in samples if s.get("gps")]
        with_compass = [
            s for s in gps_samples
            if s.get("gps", {}).get("compass") is not None
        ]
        print(f"gps samples: {len(gps_samples)} with compass: {len(with_compass)}")
        for s in (with_compass or gps_samples)[-5:]:
            g = s.get("gps") or {}
            print(
                f"  t={s.get('t')} lat={g.get('lat')} hdg={g.get('hdg')} "
                f"compass={g.get('compass')} spd={g.get('spd')}"
            )


if __name__ == "__main__":
    main()
