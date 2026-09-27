#!/usr/bin/env python3
import json
import sys
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = sys.argv[1] if len(sys.argv) > 1 else "A2"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 8


def get():
    with urllib.request.urlopen(
        BASE + "/api/devices?windowSec=300&onlineSec=600&includeMetrics=1", timeout=60
    ) as r:
        return json.load(r)


for i in range(N):
    d = get()
    x = next((z for z in d.get("devices", []) if z.get("deviceId") == UID), None)
    if x:
        g = x.get("gps") or {}
        hb = x.get("heartbeat") or {}
        print(
            f"[{i}] seen={x.get('lastSeenAgoSec')}s "
            f"fixAge={g.get('ageSec')} display={g.get('displayAgeSec')} "
            f"hz={g.get('rateHz')} cnt={g.get('count')} "
            f"hbHz={hb.get('rateHz')} sess={str(x.get('sessionId', ''))[:8]}"
        )
    else:
        print(f"[{i}] {UID} not found")
    time.sleep(5)
