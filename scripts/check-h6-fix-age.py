#!/usr/bin/env python3
"""Inspect H6 fix timestamp vs ingest lag (explains high fix age on dashboard)."""
import json
import statistics
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def main() -> None:
    dev = get("/api/devices?windowSec=600&onlineSec=300&includeMetrics=1")
    for uid in ("H6", "F4"):
        d = next((x for x in dev.get("devices", []) if x.get("deviceId") == uid), None)
        if not d:
            print(f"{uid}: not found")
            continue
        gps = d.get("gps") or {}
        print(f"\n=== {uid} fleet metrics ===")
        print(f"  online={d.get('online')} lastSeen={d.get('lastSeenAgoSec')}s")
        print(
            f"  gps: rateHz={gps.get('rateHz')} ageSec={gps.get('ageSec')} "
            f"ingestAgoSec={gps.get('ingestAgoSec')} displayAgeSec={gps.get('displayAgeSec')}"
        )
        lag = None
        if gps.get("ageSec") is not None and gps.get("ingestAgoSec") is not None:
            lag = gps["ageSec"] - gps["ingestAgoSec"]
            print(f"  pipeline lag (fix age - ingest ago): {lag}s")

    for uid in ("H6", "F4"):
        sess = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])[0]
        tr = get(f"/api/history?format=dashboard&sessionId={sess['session_id']}").get("track") or []
        gps_pts = [p for p in tr if p.get("lat") is not None]
        if not gps_pts:
            continue
        print(f"\n=== {uid} recent sample timestamps (last 15) ===")
        now_ms = datetime.now(timezone.utc).timestamp() * 1000
        tail = gps_pts[-15:]
        lags = []
        for p in tail:
            t = p["t"]
            lag_s = (now_ms - t) / 1000
            lags.append(lag_s)
            ts = datetime.fromtimestamp(t / 1000, tz=NZ).strftime("%H:%M:%S")
            print(f"  t={ts} NZ  sample-age-now={lag_s:.0f}s")
        print(f"  median sample-age of last 15: {statistics.median(lags):.1f}s")

        gaps = [(gps_pts[i]["t"] - gps_pts[i - 1]["t"]) / 1000 for i in range(1, len(gps_pts))]
        print(f"  session gaps: median={statistics.median(gaps):.3f}s max={max(gaps):.1f}s")


if __name__ == "__main__":
    main()
