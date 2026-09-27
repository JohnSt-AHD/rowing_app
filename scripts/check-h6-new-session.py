#!/usr/bin/env python3
"""Wait for a new H6 session and analyze its GPS performance."""
import json
import statistics
import sys
import time
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


def analyze_route(route, label: str) -> None:
    gps: list[float] = []
    accs: list[float] = []
    hb = park = 0
    for p in route:
        if not isinstance(p, dict):
            continue
        attrs = p.get("attributes") or {}
        if attrs.get("heartbeat"):
            hb += 1
        if attrs.get("inBoatPark"):
            park += 1
        if p.get("latitude") is None:
            continue
        gps.append(to_ms(p.get("fixTime") or p.get("deviceTime")))
        acc = attrs.get("accuracy", p.get("accuracy"))
        if acc is not None:
            accs.append(float(acc))
    print(label)
    if len(gps) < 2:
        print(f"  gps fixes: {len(gps)}  heartbeats: {hb}  boatPark: {park}")
        return
    gps.sort()
    gaps = [(gps[i] - gps[i - 1]) / 1000 for i in range(1, len(gps))]
    dur = (gps[-1] - gps[0]) / 1000
    gs = sorted(gaps)
    t0 = datetime.fromtimestamp(gps[0] / 1000, tz=timezone.utc)
    t1 = datetime.fromtimestamp(gps[-1] / 1000, tz=timezone.utc)
    print(f"  gps fixes: {len(gps)}  heartbeats: {hb}  boatPark: {park}")
    print(f"  duration: {dur:.0f}s ({dur / 60:.1f} min)  avg: {len(gps) / dur:.3f} Hz")
    print(
        f"  gaps — median: {statistics.median(gaps):.2f}s  "
        f"p95: {gs[int(0.95 * len(gs))]:.2f}s  max: {max(gaps):.1f}s  "
        f">2s: {sum(1 for g in gaps if g > 2)}  >5s: {sum(1 for g in gaps if g > 5)}"
    )
    print(f"  UTC {t0.strftime('%H:%M:%S')} to {t1.strftime('%H:%M:%S')}")
    if accs:
        sa = sorted(accs)
        print(
            f"  accuracy m — median: {statistics.median(accs):.1f}  "
            f"p95: {sa[int(0.95 * len(sa))]:.1f}  max: {max(accs):.1f}"
        )


def main() -> None:
    wait_sec = int(sys.argv[1]) if len(sys.argv) > 1 else 180
    poll_sec = 8
    polls = max(1, wait_sec // poll_sec)

    sess0 = get("/api/history?list=sessions&uniqueId=H6")
    prev = sess0.get("sessions", [{}])[0] if sess0.get("sessions") else None
    prev_id = prev.get("session_id") if prev else None
    print("=== Before ===")
    if prev:
        print(
            f"  latest: {prev['session_id'][:8]}  started {prev['started_at']}  "
            f"samples={prev.get('sample_count', '?')}"
        )
    else:
        print("  no prior session")

    print(f"\nPolling every {poll_sec}s for up to {poll_sec * polls}s...")
    cur = prev
    for i in range(polls):
        sess = get("/api/history?list=sessions&uniqueId=H6")
        sessions = sess.get("sessions", [])
        if not sessions:
            print(f"  poll {i + 1}: no sessions yet")
            time.sleep(poll_sec)
            continue
        cur = sessions[0]
        sid = cur["session_id"]
        if sid != prev_id:
            print(f"\n*** NEW SESSION ***  {sid[:8]}  started {cur['started_at']}")
            break
        print(
            f"  poll {i + 1}: {sid[:8]}  samples={cur.get('sample_count', '?')}  "
            f"started={cur['started_at']}"
        )
        time.sleep(poll_sec)

    if not cur:
        print("No session found.")
        return

    dev = get("/api/devices?windowSec=120&onlineSec=180&includeMetrics=1")
    h6 = next((d for d in dev.get("devices", []) if d.get("deviceId") == "H6"), None)
    print("\n=== Live snapshot ===")
    if h6:
        g = h6.get("gps") or {}
        last = g.get("last") or {}
        print(
            f"  online={h6.get('online')}  lastSeen={h6.get('lastSeenAgoSec')}s  "
            f"session={str(h6.get('sessionId', ''))[:8]}"
        )
        print(
            f"  gpsHz={g.get('rateHz')}  ingestHz={h6.get('ingestRateHz')}  "
            f"fixAge={g.get('ageSec')}s  displayAge={g.get('displayAgeSec')}s  "
            f"ingestAgo={g.get('ingestAgoSec')}s  acc={last.get('acc')}  count={g.get('count')}"
        )
        print(
            f"  stroke={h6.get('rowing', {}).get('strokeRate')}  "
            f"bat={h6.get('battery', {}).get('pct')}%"
        )

    mp = get("/api/map-positions?onlineSec=120&staleSec=600&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == "H6"), None)
    if pos:
        print(
            f"  map fixAge={pos.get('fixAgeSec')}s  smoothed={pos.get('smoothed')}  "
            f"lat={pos.get('latitude')}  lon={pos.get('longitude')}"
        )

    sid = cur["session_id"]
    st = cur["started_at"]
    from_ms = to_ms(st) - 30_000
    to_ms_end = to_ms(st) + 4 * 3600 * 1000
    from_iso = datetime.fromtimestamp(from_ms / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    to_iso = datetime.fromtimestamp(to_ms_end / 1000, tz=timezone.utc).isoformat().replace(
        "+00:00", "Z"
    )
    route = get(f"/api/history?uniqueId=H6&from={quote(from_iso)}&to={quote(to_iso)}")
    analyze_route(route, f"\n=== Session {sid[:8]} ({st}) ===")


if __name__ == "__main__":
    main()
