#!/usr/bin/env python3
"""Find GPS stall gaps in a device's recent session."""
import json
import statistics
import sys
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = sys.argv[1] if len(sys.argv) > 1 else "H6"
SESSION_PREFIX = sys.argv[2] if len(sys.argv) > 2 else None


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def to_ms(t) -> float:
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def main() -> None:
    sess = get(f"/api/history?list=sessions&uniqueId={UID}")
    sessions = sess.get("sessions", [])
    if not sessions:
        print(f"No sessions for {UID}")
        return

    if SESSION_PREFIX:
        cur = next(
            (s for s in sessions if s["session_id"].startswith(SESSION_PREFIX)),
            sessions[0],
        )
    else:
        cur = sessions[0]

    sid, st = cur["session_id"], cur["started_at"]
    to_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    route = get(f"/api/history?uniqueId={UID}&from={quote(st)}&to={quote(to_iso)}")

    gps: list[tuple[float, float, float]] = []
    hb = 0
    for p in route:
        if not isinstance(p, dict):
            continue
        attrs = p.get("attributes") or {}
        if attrs.get("heartbeat"):
            hb += 1
        if p.get("latitude") is None:
            continue
        gps.append(
            (
                to_ms(p.get("fixTime") or p.get("deviceTime")),
                p["latitude"],
                p["longitude"],
            )
        )

    gps.sort()
    print(f"=== {UID} session {sid[:8]} started {st} ===")
    print(f"GPS fixes: {len(gps)}  heartbeats in route: {hb}")

    if len(gps) < 2:
        return

    gaps = [(gps[i][0] - gps[i - 1][0]) / 1000 for i in range(1, len(gps))]
    gs = sorted(gaps)
    p95_i = min(int(0.95 * len(gs)), len(gs) - 1)
    dur = (gps[-1][0] - gps[0][0]) / 1000
    print(
        f"Duration: {dur/60:.1f} min  median gap: {statistics.median(gaps):.2f}s  "
        f"p95: {gs[p95_i]:.2f}s  max: {max(gaps):.0f}s"
    )

    print("\nGaps > 30s:")
    for i, gap in enumerate(gaps):
        if gap <= 30:
            continue
        t0 = datetime.fromtimestamp(gps[i][0] / 1000, tz=timezone.utc)
        t1 = datetime.fromtimestamp(gps[i + 1][0] / 1000, tz=timezone.utc)
        print(f"  {gap:.0f}s stall ending {t0.strftime('%H:%M:%S')}Z, resume {t1.strftime('%H:%M:%S')}Z")

    # First sustained stall after warm-up (skip first 60 fixes)
    for i, gap in enumerate(gaps):
        if i < 60:
            continue
        if gap > 30:
            elapsed = (gps[i][0] - gps[0][0]) / 60
            print(f"\nFirst stall after warm-up: {gap:.0f}s at +{elapsed:.1f} min into session")
            break


if __name__ == "__main__":
    main()
