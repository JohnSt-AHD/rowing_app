#!/usr/bin/env python3
import json
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Accept": "application/json", "Authorization": "Bearer rnz"}

for i in range(8):
    req = urllib.request.Request(
        BASE + "/api/map-positions?onlineSec=300&staleSec=3600", headers=H
    )
    ps = json.loads(urllib.request.urlopen(req, timeout=60).read()).get("positions", [])
    hits = [p for p in ps if p.get("deviceId") == "TEST-KRI-RACE"]
    print(f"[{i}] entries={len(hits)}", end="")
    for p in hits:
        print(
            f" lat={p.get('latitude'):.5f} lon={p.get('longitude'):.5f}"
            f" fixAge={p.get('fixAgeSec')} spd={p.get('speed')}",
            end="",
        )
    print()
    time.sleep(2)
