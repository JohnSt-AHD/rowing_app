#!/usr/bin/env python3
"""Poll H6 fleet + map three times to verify live monitor updates."""
import json
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main() -> None:
    prev_seen = None
    for i in range(3):
        dev = get("/api/devices?windowSec=120&onlineSec=180")
        h6 = next((d for d in dev.get("devices", []) if d.get("deviceId") == "H6"), None)
        mp = get("/api/map-positions?onlineSec=120&staleSec=600")
        pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == "H6"), None)
        if h6:
            g = h6.get("gps") or {}
            seen = h6.get("lastSeenAgoSec")
            delta = "" if prev_seen is None else f" (seen delta {seen - prev_seen:+d}s)"
            prev_seen = seen
            print(
                f"poll {i + 1}: lastSeen={seen}s{delta} gpsAge={g.get('ageSec')}s "
                f"gpsHz={g.get('rateHz')} ingestHz={h6.get('ingestRateHz')} "
                f"stroke={h6.get('rowing', {}).get('strokeRate')} online={h6.get('online')} "
                f"bat={h6.get('battery', {}).get('pct')}%"
            )
        if pos:
            print(
                f"         map fixAge={pos.get('fixAgeSec')}s "
                f"lat={pos.get('latitude')} lon={pos.get('longitude')} "
                f"stroke={pos.get('strokeRate')}"
            )
        time.sleep(5)


if __name__ == "__main__":
    main()
