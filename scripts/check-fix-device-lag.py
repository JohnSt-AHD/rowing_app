#!/usr/bin/env python3
"""Dashboard 'fix Xs on device' warnings — fix age vs ingest lag."""
import json
import statistics
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
WARN_LAG_SEC = 20


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def main():
    print("=== Device cards (fix age vs ingest) ===\n")
    data = get("/api/devices?windowSec=120&onlineSec=180&includeMetrics=1")
    health = data.get("health") or {}
    print(f"Fleet: delayedGpsDevices={health.get('delayedGpsDevices')} avgGpsAge={health.get('avgGpsAgeSec')}s\n")

    for uid in ("H6", "F4"):
        d = next((x for x in data.get("devices", []) if x.get("deviceId") == uid), None)
        if not d:
            print(f"{uid}: not found\n")
            continue
        g = d.get("gps") or {}
        age = g.get("ageSec")
        ingest = g.get("ingestAgoSec")
        display = g.get("displayAgeSec")
        lag = (age - ingest) if age is not None and ingest is not None else None
        warn = lag is not None and lag > WARN_LAG_SEC
        print(f"{uid}: online={d.get('online')} lastSeen={d.get('lastSeenAgoSec')}s ingestHz={d.get('ingestRateHz')}")
        print(
            f"  gps rateHz={g.get('rateHz')} ageSec={age} ingestAgoSec={ingest} "
            f"displayAgeSec={display}"
        )
        if warn:
            print(f"  WARN: fix on device lag {lag}s (>{WARN_LAG_SEC}s)")
        elif lag is not None:
            print(f"  OK: pipeline lag {lag}s")
        else:
            print("  (no lag data)")

        sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
        if sessions:
            sid = sessions[0]["session_id"]
            tr = get(f"/api/history?format=dashboard&sessionId={sid}").get("track") or []
            gps = [p for p in tr if p.get("lat") is not None]
            if gps:
                last_age = (time.time() * 1000 - gps[-1]["t"]) / 1000
                tail = gps[-20:]
                gaps = [(tail[i]["t"] - tail[i - 1]["t"]) / 1000 for i in range(1, len(tail))]
                med = statistics.median(gaps) if gaps else None
                print(
                    f"  session {sid[:8]}: last GPS sample {last_age:.0f}s ago, "
                    f"tail median gap={med}s"
                )
                if last_age > 30 and (g.get("rateHz") or 0) > 0.5:
                    print("  → Likely stale sample.t while ingest/heartbeats still active")
                elif last_age > 30:
                    print("  → GPS uploads appear stalled")
        print()


if __name__ == "__main__":
    main()
