#!/usr/bin/env python3
"""Quick H7 ingest health check from production API."""
import json
import statistics
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"


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
    from_ms = to_ms(st) - 30_000
    to_ms_end = to_ms(st) + 2 * 3600 * 1000
    from_iso = datetime.fromtimestamp(from_ms / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    to_iso = datetime.fromtimestamp(to_ms_end / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    route = get(f"/api/history?uniqueId={uid}&from={quote(from_iso)}&to={quote(to_iso)}")
    gps_ts: list[float] = []
    ingest_ts: list[float] = []
    fix_vs_ingest: list[float] = []
    coords: list[tuple] = []
    for p in route:
        if not isinstance(p, dict) or p.get("latitude") is None:
            continue
        ft = to_ms(p.get("fixTime") or p.get("deviceTime"))
        it = to_ms(p.get("serverTime") or p.get("deviceTime") or p.get("fixTime"))
        gps_ts.append(ft)
        ingest_ts.append(it)
        fix_vs_ingest.append((it - ft) / 1000)
        attrs = p.get("attributes") or {}
        coords.append((p.get("latitude"), p.get("longitude"), attrs.get("accuracy")))
    print(f"  session {sid[:8]} gps fixes: {len(gps_ts)}")
    if len(gps_ts) >= 2:
        gaps = [(gps_ts[i] - gps_ts[i - 1]) / 1000 for i in range(1, len(gps_ts))]
        gs = sorted(gaps)
        print(
            f"    fixTime gaps median={statistics.median(gaps):.2f}s "
            f"p95={gs[int(0.95 * len(gs))]:.2f}s max={max(gaps):.1f}s"
        )
    if fix_vs_ingest:
        fv = sorted(fix_vs_ingest)
        now = datetime.now(timezone.utc).timestamp() * 1000
        print(
            f"    serverTime-fixTime lag: median={statistics.median(fix_vs_ingest):.1f}s "
            f"p95={fv[int(0.95 * len(fv))]:.1f}s max={max(fix_vs_ingest):.1f}s "
            f"last={fix_vs_ingest[-1]:.1f}s"
        )
        print(
            f"    latest fixTime age: {(now - gps_ts[-1]) / 1000:.1f}s  "
            f"latest ingest age: {(now - ingest_ts[-1]) / 1000:.1f}s"
        )
        print(f"    latest coord: {coords[-1]}")
        if len(coords) >= 5:
            print(f"    last 5 coords: {coords[-5:]}")


def main() -> None:
    print("=== Online / H6+H7 devices ===")
    dev = get("/api/devices?windowSec=120&onlineSec=300&includeMetrics=1")
    for d in sorted(dev.get("devices", []), key=lambda x: x.get("lastSeenAgoSec", 9999)):
        if d.get("online") or d.get("deviceId") in ("H6", "H7"):
            show_device(d)

    print("\n=== Map positions ===")
    mp = get("/api/map-positions?onlineSec=300&staleSec=600&predictMode=rowing")
    for p in mp.get("positions", []):
        if p.get("deviceId") in ("H6", "H7") or p.get("online"):
            print(
                f"  {p.get('deviceId')}: lat={p.get('latitude')} lon={p.get('longitude')} "
                f"fixAge={p.get('fixAgeSec')}s lastSeen={p.get('lastSeenAgoSec')}s "
                f"smoothed={p.get('smoothed')} online={p.get('online')}"
            )

    print("\n=== Positions API (registry) ===")
    pos = get("/api/positions?onlineSec=300")
    for p in pos.get("positions", []) or []:
        uid = p.get("uniqueId") or p.get("deviceId")
        if uid in ("H6", "H7"):
            print(
                f"  {uid}: lat={p.get('latitude')} lon={p.get('longitude')} "
                f"fixTime={p.get('fixTime')} course={p.get('course')}"
            )

    for uid in ("H7", "H6"):
        analyze_session(uid)


def poll_h7(times: int = 4, interval: float = 5.0) -> None:
    print(f"\n=== Poll H7 every {interval:.0f}s ({times} samples) ===")
    for i in range(times):
        dev = get("/api/devices?windowSec=120&onlineSec=300&includeMetrics=1")
        h7 = next((d for d in dev.get("devices", []) if d.get("deviceId") == "H7"), None)
        mp = get("/api/map-positions?onlineSec=300&staleSec=600")
        pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == "H7"), None)
        now = datetime.now(timezone.utc).strftime("%H:%M:%S")
        if h7:
            g = h7.get("gps") or {}
            print(
                f"[{now}] lastSeen={h7.get('lastSeenAgoSec')}s "
                f"fixAge={g.get('ageSec')}s displayAge={g.get('displayAgeSec')}s "
                f"ingestAgo={g.get('ingestAgoSec')}s gpsHz={g.get('rateHz')} count={g.get('count')}"
            )
        if pos:
            print(
                f"         map fixAge={pos.get('fixAgeSec')}s "
                f"lat={pos.get('latitude')} lon={pos.get('longitude')}"
            )
        if i < times - 1:
            import time

            time.sleep(interval)


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "poll":
        poll_h7()
    else:
        main()
        poll_h7()
