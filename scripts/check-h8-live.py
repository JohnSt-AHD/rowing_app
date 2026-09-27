#!/usr/bin/env python3
"""Quick H8 ingest health check from production API."""
import json
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = "H8"


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def to_ms(t) -> float:
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def show_device(d) -> None:
    g = d.get("gps") or {}
    last = g.get("last") or {}
    sid = str(d.get("sessionId") or "")[:8]
    print(
        f"  deviceId={d.get('deviceId')} online={d.get('online')} "
        f"lastSeen={d.get('lastSeenAgoSec')}s session={sid}"
    )
    print(
        f"    gpsHz={g.get('rateHz')} count={g.get('count')} "
        f"fixAge={g.get('ageSec')}s displayAge={g.get('displayAgeSec')}s "
        f"ingestAgo={g.get('ingestAgoSec')}s"
    )
    print(f"    lat={last.get('lat')} lon={last.get('lon')} acc={last.get('acc')}")
    print(
        f"    stroke={d.get('rowing', {}).get('strokeRate')} "
        f"bat={d.get('battery', {}).get('pct')}%"
    )


def analyze_session(uid: str) -> None:
    print(f"\n=== Recent {uid} sessions ===")
    sess = get(f"/api/history?list=sessions&uniqueId={uid}")
    for s in sess.get("sessions", [])[:4]:
        print(
            f"  {s['session_id'][:8]} started={s['started_at']} "
            f"samples={s.get('sample_count', '?')}"
        )
    sessions = sess.get("sessions", [])
    if not sessions:
        return
    cur = sessions[0]
    sid, st = cur["session_id"], cur["started_at"]
    from_iso = (
        datetime.fromisoformat(st.replace("Z", "+00:00"))
        .astimezone(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )
    to_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    route = get(f"/api/history?uniqueId={uid}&from={quote(from_iso)}&to={quote(to_iso)}")
    gps_ts: list[float] = []
    lags: list[float] = []
    coords: list[tuple] = []
    for p in route:
        if not isinstance(p, dict) or p.get("latitude") is None:
            continue
        ft = to_ms(p.get("fixTime") or p.get("deviceTime"))
        stime = p.get("serverTime")
        gps_ts.append(ft)
        if stime:
            lags.append((to_ms(stime) - ft) / 1000)
        coords.append((p.get("latitude"), p.get("longitude")))
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    print(f"  session {sid[:8]} gps fixes: {len(gps_ts)}")
    if len(gps_ts) >= 2:
        gaps = [(gps_ts[i] - gps_ts[i - 1]) / 1000 for i in range(1, len(gps_ts))]
        gs = sorted(gaps)
        p95_i = min(int(0.95 * len(gs)), len(gs) - 1)
        print(
            f"    gaps median={statistics.median(gaps):.2f}s "
            f"p95={gs[p95_i]:.2f}s max={max(gaps):.1f}s"
        )
    if lags:
        fv = sorted(lags)
        p95_i = min(int(0.95 * len(fv)), len(fv) - 1)
        print(
            f"    server-fix lag median={statistics.median(lags):.1f}s "
            f"p95={fv[p95_i]:.1f}s max={max(lags):.1f}s last={lags[-1]:.1f}s"
        )
        print(f"    latest fix age: {(now_ms - gps_ts[-1]) / 1000:.1f}s")
        print(f"    latest coord: {coords[-1]}")
        if len(coords) >= 5:
            print(f"    last 5 coords: {coords[-5:]}")


def poll(uid: str, times: int = 4, interval: float = 5.0) -> None:
    print(f"\n=== Poll {uid} every {interval:.0f}s ({times} samples) ===")
    for i in range(times):
        dev = get("/api/devices?windowSec=120&onlineSec=300&includeMetrics=1")
        d = next((x for x in dev.get("devices", []) if x.get("deviceId") == uid), None)
        mp = get("/api/map-positions?onlineSec=300&staleSec=600")
        p = next((x for x in mp.get("positions", []) if x.get("deviceId") == uid), None)
        now = datetime.now(timezone.utc).strftime("%H:%M:%S")
        if d:
            g = d.get("gps") or {}
            print(
                f"[{now}] lastSeen={d.get('lastSeenAgoSec')}s "
                f"fixAge={g.get('ageSec')}s displayAge={g.get('displayAgeSec')}s "
                f"ingestAgo={g.get('ingestAgoSec')}s gpsHz={g.get('rateHz')} count={g.get('count')}"
            )
        if p:
            print(
                f"         map fixAge={p.get('fixAgeSec')}s "
                f"lat={p.get('latitude')} lon={p.get('longitude')}"
            )
        if i < times - 1:
            time.sleep(interval)


def main() -> None:
    print(f"=== Online / {UID} device ===")
    dev = get("/api/devices?windowSec=120&onlineSec=300&includeMetrics=1")
    d = next((x for x in dev.get("devices", []) if x.get("deviceId") == UID), None)
    if d:
        show_device(d)
    else:
        print(f"  {UID} not found")

    print("\n=== Map position ===")
    mp = get("/api/map-positions?onlineSec=300&staleSec=600&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    if p:
        print(
            f"  fixAge={p.get('fixAgeSec')}s lastSeen={p.get('lastSeenAgoSec')}s "
            f"smoothed={p.get('smoothed')} lat={p.get('latitude')} lon={p.get('longitude')}"
        )
    else:
        print("  none")

    analyze_session(UID)
    poll(UID)


if __name__ == "__main__":
    main()
