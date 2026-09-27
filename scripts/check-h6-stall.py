#!/usr/bin/env python3
"""Watch H6 fixMs / coords for 20s to detect GPS stall."""
import json
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main() -> None:
    prev_fix_ms = None
    prev_lat = None
    for i in range(5):
        dev = get("/api/devices?windowSec=60&onlineSec=120&includeMetrics=1")
        h6 = next(d for d in dev["devices"] if d["deviceId"] == "H6")
        mp = get("/api/map-positions?onlineSec=120&staleSec=3600&predictMode=rowing")
        pos = next(p for p in mp["positions"] if p["deviceId"] == "H6")
        g = h6["gps"]
        fix_ms = pos.get("fixMs")
        lat = pos.get("latitude")
        moved = prev_lat is not None and lat != prev_lat
        new_fix = prev_fix_ms is not None and fix_ms != prev_fix_ms
        print(
            f"#{i + 1} seen={h6['lastSeenAgoSec']}s count={g.get('count')} "
            f"hz={g.get('rateHz')} fixAge={g.get('ageSec')}s display={g.get('displayAgeSec')}s "
            f"ingest={g.get('ingestAgoSec')}s newFix={new_fix} moved={moved}"
        )
        print(f"    map {lat},{pos.get('longitude')} fixMs={fix_ms}")
        prev_fix_ms = fix_ms
        prev_lat = lat
        time.sleep(4)


if __name__ == "__main__":
    main()
