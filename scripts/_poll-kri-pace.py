#!/usr/bin/env python3
import json
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Accept": "application/json", "Authorization": "Bearer rnz"}

for i in range(15):
    req = urllib.request.Request(
        BASE + "/api/map-positions?onlineSec=120&staleSec=3600", headers=H
    )
    d = json.loads(urllib.request.urlopen(req, timeout=60).read())
    p = next(
        (x for x in d.get("positions", []) if x.get("deviceId") == "TEST-KRI-RACE"), None
    )
    if p:
        print(
            f"[{i}] fixAge={p.get('fixAgeSec')} ingest={p.get('ingestAgoSec')} "
            f"stale={p.get('telemetryStale')} raw={p.get('speed')} "
            f"path={p.get('pathSpeedMps')} display={p.get('displaySpeedMps')} "
            f"online={p.get('online')}"
        )
    else:
        print(f"[{i}] absent")
    time.sleep(3)
