#!/usr/bin/env python3
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
NZ = timezone(timedelta(hours=12))
UID = "W2- KL"


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=90) as r:
        return __import__("json").load(r)


print("=== 30s live poll ===")
for i in range(6):
    dev = next(
        x
        for x in get("/api/devices?windowSec=900&onlineSec=3600&includeMetrics=1")["devices"]
        if x["deviceId"] == UID
    )
    mp = next(
        x
        for x in get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")["positions"]
        if x["deviceId"] == UID
    )
    g = (dev.get("gps") or {}).get("last") or {}
    t = g.get("t")
    ts = datetime.fromtimestamp(t / 1000, NZ).strftime("%H:%M:%S") if t else "?"
    print(
        f"{i} seen={dev.get('lastSeenAgoSec')}s gpsAge={dev.get('gps', {}).get('ageSec')} "
        f"fixAge={mp.get('fixAgeSec')} lastFix={ts} online={mp.get('online')} "
        f"stale={mp.get('telemetryStale')} spd={mp.get('displaySpeedMps')}"
    )
    time.sleep(5)

sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(UID))["sessions"]
    if s["session_id"].startswith("be01b0da")
)
tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"]
last_gps = max(p for p in tr if p.get("lat") is not None)
after = [p for p in tr if p["t"] > last_gps["t"]]
print(
    f"last gps {datetime.fromtimestamp(last_gps['t']/1000, NZ).strftime('%H:%M:%S')} "
    f"after={len(after)} samples"
)
for p in after[-10:]:
    print(
        " ",
        datetime.fromtimestamp(p["t"] / 1000, NZ).strftime("%H:%M:%S"),
        "gps" if p.get("lat") else "no-gps",
        "stroke",
        p.get("strokeRate"),
    )
