#!/usr/bin/env python3
import json
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M4x JS"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


for i in range(5):
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    d = next(
        (
            x
            for x in get("/api/devices?windowSec=600&onlineSec=3600&includeMetrics=1").get(
                "devices", []
            )
            if x.get("deviceId") == UID
        ),
        None,
    )
    gps = d.get("gps") or {} if d else {}
    last = gps.get("last") or {}
    row = d.get("rowing") or {} if d else {}
    print(
        f"[{i}] map={p.get('speed') if p else None} m/s "
        f"gps={last.get('spd')} m/s fixAge={gps.get('ageSec')}s "
        f"stroke={row.get('strokeRate')} acc={last.get('acc')}"
    )
    time.sleep(4)
