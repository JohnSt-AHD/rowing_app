#!/usr/bin/env python3
"""Check M4x JS live GPS fixMs (satellite clock) vs upload clock."""
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M4x JS"
H = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def fmt_ms(ms):
    if ms is None:
        return "-"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%H:%M:%S.%f")[:-3] + "Z"


def main():
    dev = next(
        (d for d in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get("devices", []) if d.get("deviceId") == UID),
        None,
    )
    print(f"=== {UID} devices API ===")
    if not dev:
        print("device not found")
        return
    gps = dev.get("gps") or {}
    last = gps.get("last") or {}
    print(f"online={dev.get('online')} session={dev.get('sessionId')}")
    print(f"gps.ageSec={gps.get('ageSec')} gpsFixAgeSec={gps.get('gpsFixAgeSec')} uploadLagSec={gps.get('uploadLagSec')}")
    print(f"last.t (upload clock)={last.get('t')} -> {fmt_ms(last.get('t'))}")
    print(f"last.fixMs (satellite)={last.get('fixMs')} -> {fmt_ms(last.get('fixMs'))}")
    if last.get("t") and last.get("fixMs"):
        lag = round((last["t"] - last["fixMs"]) / 1000, 1)
        print(f"upload - fixMs = {lag}s")

    mp = next(
        (p for p in get("/api/map-positions?onlineSec=600&staleSec=3600&predictMode=rowing").get("positions", []) if p.get("deviceId") == UID),
        None,
    )
    print(f"\n=== {UID} map-positions ===")
    if mp:
        print(f"fixMs={mp.get('fixMs')} gpsFixMs={mp.get('gpsFixMs')} fixAgeSec={mp.get('fixAgeSec')} gpsFixAgeSec={mp.get('gpsFixAgeSec')} uploadLagSec={mp.get('uploadLagSec')}")
    else:
        print("not on map")

    enc = urllib.parse.quote(UID, safe="")
    sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
    if not sessions:
        print("\nno sessions")
        return
    sid = sessions[0]["session_id"]
    print(f"\n=== latest session {sid[:8]}… (last 5 track points) ===")
    payload = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}&limit=5")
    track = (payload.get("track") or [])[-5:]
    for p in track:
        t = p.get("t")
        fix = p.get("fixMs") or p.get("gpsFixMs")
        print(f"  t={fmt_ms(t)} fixMs={fmt_ms(fix)} lag={(t-fix)/1000 if t and fix else '-'}s lat={p.get('lat')}")


if __name__ == "__main__":
    main()
