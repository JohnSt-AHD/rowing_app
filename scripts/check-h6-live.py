#!/usr/bin/env python3
"""Quick H6 ingest health check from production API."""
import json
import statistics
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"


def get(url: str):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def to_ms(t) -> float:
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def analyze_route(route, label: str) -> None:
    gps: list[float] = []
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
    print(f"  duration: {dur / 60:.1f} min  avg: {len(gps) / dur:.3f} Hz")
    print(
        f"  gaps — median: {statistics.median(gaps):.2f}s  "
        f"p95: {gs[int(0.95 * len(gs))]:.2f}s  max: {max(gaps):.1f}s  "
        f">2s: {sum(1 for g in gaps if g > 2)}"
    )
    print(f"  UTC {t0.strftime('%H:%M:%S')} to {t1.strftime('%H:%M:%S')}")


def main() -> None:
    sess = get(f"{BASE}/api/history?list=sessions&uniqueId=H6")
    print("=== Recent H6 sessions ===")
    for s in sess.get("sessions", [])[:6]:
        print(
            s["session_id"][:8],
            s["started_at"],
            "samples",
            s.get("sample_count", "?"),
        )

    dev = get(f"{BASE}/api/devices?windowSec=600&onlineSec=180&includeMetrics=1")
    h6 = next((d for d in dev.get("devices", []) if d.get("deviceId") == "H6"), None)
    print("\n=== H6 fleet snapshot ===")
    if h6:
        gps = h6.get("gps") or {}
        hb = h6.get("heartbeat") or {}
        print(f"  online: {h6.get('online')}  last seen: {h6.get('lastSeenAgoSec')}s ago")
        print(
            f"  gps: {gps.get('rateHz', 0)} Hz  fix age: {gps.get('ageSec')}s  "
            f"in window: {gps.get('count', 0)}"
        )
        print(f"  heartbeat: {hb.get('rateHz', 0)} Hz  age: {hb.get('ageSec')}s")

    for s in sess.get("sessions", [])[:3]:
        sid = s["session_id"]
        st = s["started_at"]
        from_ms = to_ms(st) - 30_000
        to_ms_end = to_ms(st) + 3 * 3600 * 1000
        from_iso = datetime.fromtimestamp(from_ms / 1000, tz=timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        to_iso = datetime.fromtimestamp(to_ms_end / 1000, tz=timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        route = get(
            f"{BASE}/api/history?uniqueId=H6&from={quote(from_iso)}&to={quote(to_iso)}"
        )
        analyze_route(route, f"\n=== Session {sid[:8]} ({st}) ===")

    route = get(
        f"{BASE}/api/history?uniqueId=H6&from=2026-06-03T08:40:00.000Z&to=2026-06-03T10:00:00.000Z"
    )
    analyze_route(route, "\n=== All H6 GPS today after 08:40 UTC ===")


if __name__ == "__main__":
    main()
