#!/usr/bin/env python3
"""Quick production health check: cache, pace, devices."""
import json
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.status, dict(r.headers), json.load(r)


def split500(m):
    if m is None or m < 0.25:
        return "-"
    s = 500 / float(m)
    return f"{int(s // 60)}:{s % 60:04.1f}"


def main():
    _, _, ping = get("/api/ping")
    print("=== PING ===")
    print(f"storage={ping.get('storage')} persisted={ping.get('persisted')}")

    print("\n=== MAP-POSITIONS CACHE (3 polls) ===")
    for i in range(3):
        req = urllib.request.Request(
            BASE + "/api/map-positions?onlineSec=120&staleSec=3600&predictMode=rowing",
            headers=H,
        )
        with urllib.request.urlopen(req, timeout=90) as r:
            body = json.load(r)
            c = body.get("cache", {})
            print(
                f"  poll {i + 1}: X-Cache={r.headers.get('X-Map-Positions-Cache')} "
                f"enabled={c.get('enabled')} hit={c.get('hit')} ageMs={c.get('ageMs')}"
            )
        time.sleep(0.4)

    _, _, mp = get("/api/map-positions?onlineSec=120&staleSec=3600&predictMode=rowing")
    positions = mp.get("positions") or []
    online = [p for p in positions if p.get("online")]
    print("\n=== MAP POSITIONS ===")
    print(f"devices={len(positions)} online={len(online)} activeCount={mp.get('activeCount')}")
    windows = sorted({p.get("pathPaceWindowSec") for p in online if p.get("pathPaceWindowSec")})
    print(f"pathPaceWindowSec (online): {windows}")

    for uid in ["W2x EH"]:
        p = next((x for x in positions if x.get("deviceId") == uid), None)
        if not p:
            print(f"\n{uid}: not in map response")
            continue
        print(f"\n=== {uid} ===")
        print(f"online={p.get('online')} stale={p.get('telemetryStale')}")
        print(
            f"path30={split500(p.get('pathSpeedMps'))} "
            f"display={split500(p.get('displaySpeedMps'))} "
            f"speed={split500(p.get('speed'))}"
        )
        print(f"pathPaceWindowSec={p.get('pathPaceWindowSec')}")

    _, _, dev = get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1")
    devices = dev.get("devices") or []
    print("\n=== DEVICES API (first 8) ===")
    print(f"count={len(devices)} online={sum(1 for d in devices if d.get('online'))}")
    for d in devices[:8]:
        gps = d.get("gps") or {}
        last = gps.get("last") or {}
        print(
            f"  {d.get('deviceId')}: online={d.get('online')} "
            f"path={d.get('pathSpeedMps')} display={d.get('displaySpeedMps')} "
            f"gps.spd={last.get('spd')}"
        )


if __name__ == "__main__":
    main()
