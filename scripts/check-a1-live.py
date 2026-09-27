#!/usr/bin/env python3
"""Quick A1 ingest health check from production API."""
import json
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = "A1"


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def to_ms(t) -> float:
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def main() -> None:
    print(f"=== Online / {UID} device ===")
    dev = get("/api/devices?windowSec=120&onlineSec=300&includeMetrics=1")
    d = next((x for x in dev.get("devices", []) if x.get("deviceId") == UID), None)
    if d:
        g = d.get("gps") or {}
        hb = d.get("heartbeat") or {}
        last = g.get("last") or {}
        sid = str(d.get("sessionId") or "")[:8]
        print(
            f"  online={d.get('online')} lastSeen={d.get('lastSeenAgoSec')}s session={sid}"
        )
        print(
            f"    gpsHz={g.get('rateHz')} count={g.get('count')} "
            f"fixAge={g.get('ageSec')}s displayAge={g.get('displayAgeSec')}s "
            f"ingestAgo={g.get('ingestAgoSec')}s"
        )
        print(
            f"    heartbeatHz={hb.get('rateHz')} hbAge={hb.get('ageSec')}s "
            f"bat={d.get('battery', {}).get('pct')}%"
        )
        print(f"    lat={last.get('lat')} lon={last.get('lon')} acc={last.get('acc')}")
    else:
        print(f"  {UID} not found")

    print("\n=== Map position ===")
    mp = get("/api/map-positions?onlineSec=300&staleSec=600&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    if p:
        print(
            f"  fixAge={p.get('fixAgeSec')}s lastSeen={p.get('lastSeenAgoSec')}s "
            f"lat={p.get('latitude')} lon={p.get('longitude')}"
        )
    else:
        print("  none")

    print(f"\n=== Recent {UID} sessions ===")
    sess = get(f"/api/history?list=sessions&uniqueId={UID}")
    for s in sess.get("sessions", [])[:4]:
        print(
            f"  {s['session_id'][:8]} started={s['started_at']} "
            f"samples={s.get('sample_count', '?')}"
        )

    sessions = sess.get("sessions", [])
    if sessions:
        cur = sessions[0]
        sid, st = cur["session_id"], cur["started_at"]
        to_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        route = get(f"/api/history?uniqueId={UID}&from={quote(st)}&to={quote(to_iso)}")
        gps_ts: list[float] = []
        hb = hb_gps = 0
        lags: list[float] = []
        for pt in route:
            if not isinstance(pt, dict):
                continue
            attrs = pt.get("attributes") or {}
            if attrs.get("heartbeat"):
                hb += 1
                if pt.get("latitude") is not None:
                    hb_gps += 1
            if pt.get("latitude") is None:
                continue
            ft = to_ms(pt.get("fixTime") or pt.get("deviceTime"))
            gps_ts.append(ft)
            stime = pt.get("serverTime")
            if stime:
                lags.append((to_ms(stime) - ft) / 1000)
        gps_ts.sort()
        print(f"  session {sid[:8]} gps={len(gps_ts)} heartbeats={hb} hb_with_gps={hb_gps}")
        if len(gps_ts) >= 2:
            gaps = [(gps_ts[i] - gps_ts[i - 1]) / 1000 for i in range(1, len(gps_ts))]
            gs = sorted(gaps)
            p95_i = min(int(0.95 * len(gs)), len(gs) - 1)
            big = sum(1 for g in gaps if g > 10)
            print(
                f"    gaps median={statistics.median(gaps):.2f}s "
                f"p95={gs[p95_i]:.2f}s max={max(gaps):.1f}s >10s={big}"
            )
        if lags:
            print(
                f"    server-fix lag median={statistics.median(lags):.1f}s "
                f"max={max(lags):.1f}s"
            )
        if gps_ts:
            now_ms = datetime.now(timezone.utc).timestamp() * 1000
            print(f"    latest fix age: {(now_ms - gps_ts[-1]) / 1000:.1f}s")

    times = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    interval = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    print(f"\n=== Poll {UID} every {interval:.0f}s ({times} samples) ===")
    prev_fix = None
    for i in range(times):
        dev = get("/api/devices?windowSec=120&onlineSec=300&includeMetrics=1")
        d = next((x for x in dev.get("devices", []) if x.get("deviceId") == UID), None)
        mp = get("/api/map-positions?onlineSec=300&staleSec=600")
        p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
        now = datetime.now(timezone.utc).strftime("%H:%M:%S")
        if d:
            g = d.get("gps") or {}
            fix_age = g.get("ageSec")
            new_fix = prev_fix is not None and fix_age is not None and fix_age < prev_fix - 2
            print(
                f"[{now}] seen={d.get('lastSeenAgoSec')}s "
                f"fixAge={fix_age}s display={g.get('displayAgeSec')}s "
                f"hz={g.get('rateHz')} count={g.get('count')} fresh={new_fix}"
            )
            prev_fix = fix_age
        if p:
            print(
                f"         map fixAge={p.get('fixAgeSec')}s "
                f"lat={p.get('latitude')} lon={p.get('longitude')}"
            )
        if i < times - 1:
            time.sleep(interval)


if __name__ == "__main__":
    main()
