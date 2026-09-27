#!/usr/bin/env python3
"""Live speed check for named devices."""
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
TARGETS = sys.argv[1:] if len(sys.argv) > 1 else ["M1x TM", "W2x EH"]


def get(path: str):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(speed):
    if speed is None or not isinstance(speed, (int, float)) or speed < 0.25:
        return None
    sec = 500 / float(speed)
    m = int(sec // 60)
    s = sec % 60
    return f"{m}:{s:04.1f}"


def main():
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    print("=== map-positions (now) ===")
    for uid in TARGETS:
        p = next((x for x in mp.get("positions", []) if x.get("deviceId") == uid), None)
        if not p:
            print(f"{uid}: not on map")
            continue
        spd = p.get("speed")
        print(
            f"{uid}: online={p.get('online')} speed={spd} m/s split={split500(spd)} /500 "
            f"fixAge={p.get('fixAgeSec')}s seen={p.get('lastSeenAgoSec')}s stroke={p.get('strokeRate')}"
        )

    devs = get("/api/devices?windowSec=600&onlineSec=3600&includeMetrics=1").get("devices", [])
    print("\n=== /api/devices ===")
    for uid in TARGETS:
        d = next((x for x in devs if x.get("deviceId") == uid), None)
        if not d:
            print(f"{uid}: not in device list")
            continue
        gps = d.get("gps") or {}
        last = gps.get("last") or {}
        spd = last.get("spd")
        print(
            f"{uid}: online={d.get('online')} seen={d.get('lastSeenAgoSec')}s "
            f"gpsHz={gps.get('rateHz')} cnt={gps.get('count')}"
        )
        print(
            f"  last GPS: speed={spd} m/s split={split500(spd)} "
            f"lat={last.get('lat')} fixAge={gps.get('ageSec')}s ingestAgo={gps.get('ingestAgoSec')}s"
        )
        row = d.get("rowing") or {}
        print(f"  stroke={row.get('strokeRate')} capsize={row.get('capsize')}")

    now = datetime.now(timezone.utc)
    frm = (now - timedelta(minutes=15)).isoformat().replace("+00:00", "Z")
    to = now.isoformat().replace("+00:00", "Z")
    print("\n=== last 15 min GPS samples ===")
    for uid in TARGETS:
        enc = urllib.parse.quote(uid, safe="")
        data = get(
            f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
        )
        track = data.get("track") or []
        speeds = [
            p.get("speed")
            for p in track
            if p.get("speed") is not None
            and p.get("speed") >= 0.25
            and p.get("lat") is not None
        ]
        if not speeds:
            print(f"{uid}: no GPS speeds in window (points={len(track)})")
            continue
        avg = sum(speeds) / len(speeds)
        mx = max(speeds)
        mn = min(speeds)
        recent = speeds[-20:]
        ravg = sum(recent) / len(recent)
        print(
            f"{uid}: samples={len(speeds)} avg={avg:.2f} m/s ({split500(avg)}/500) "
            f"recent20={ravg:.2f} m/s ({split500(ravg)}/500) min={mn:.2f} max={mx:.2f}"
        )


if __name__ == "__main__":
    main()
