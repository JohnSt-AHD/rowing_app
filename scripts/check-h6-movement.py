#!/usr/bin/env python3
"""Check whether H6 GPS coordinates are updating on the server."""
import json
import statistics
import urllib.request
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def to_ms(t) -> float:
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def main() -> None:
    now = datetime.now(timezone.utc)
    frm = (now - timedelta(minutes=15)).isoformat().replace("+00:00", "Z")
    to = now.isoformat().replace("+00:00", "Z")
    route = get(f"/api/history?uniqueId=H6&from={quote(frm)}&to={quote(to)}")

    fixes = []
    for p in route:
        if not isinstance(p, dict) or p.get("latitude") is None:
            continue
        fixes.append(
            {
                "t": to_ms(p.get("fixTime") or p.get("deviceTime")),
                "lat": p["latitude"],
                "lon": p["longitude"],
                "acc": (p.get("attributes") or {}).get("accuracy", p.get("accuracy")),
            }
        )

    print(f"=== H6 GPS last 15 min ({now.strftime('%H:%M:%S')} UTC) ===")
    print(f"fixes: {len(fixes)}")
    if not fixes:
        print("NO GPS fixes in last 15 minutes")
    else:
        fixes.sort(key=lambda f: f["t"])
        lats = [f["lat"] for f in fixes]
        lons = [f["lon"] for f in fixes]
        lat_m = abs(max(lats) - min(lats)) * 111_000
        lon_m = abs(max(lons) - min(lons)) * 85_000
        gaps = [(fixes[i]["t"] - fixes[i - 1]["t"]) / 1000 for i in range(1, len(fixes))]
        last = fixes[-1]
        last_age = (now.timestamp() * 1000 - last["t"]) / 1000
        print(f"position spread: ~{lat_m:.1f}m lat, ~{lon_m:.1f}m lon")
        if gaps:
            print(
                f"gaps: median {statistics.median(gaps):.1f}s  max {max(gaps):.0f}s  "
                f"last fix {last_age:.0f}s ago"
            )
        print("\nLast 8 fixes:")
        for f in fixes[-8:]:
            ts = datetime.fromtimestamp(f["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
            acc = f"{f['acc']:.1f}m" if f["acc"] is not None else "?"
            print(f"  {ts}  {f['lat']:.7f},{f['lon']:.7f}  acc={acc}")

    dev = get("/api/devices?windowSec=120&onlineSec=180&includeMetrics=1")
    h6 = next((d for d in dev.get("devices", []) if d.get("deviceId") == "H6"), None)
    mp = get("/api/map-positions?onlineSec=180&staleSec=3600&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == "H6"), None)

    print("\n=== Live API ===")
    if h6:
        g = h6.get("gps") or {}
        print(
            f"online={h6.get('online')}  lastSeen={h6.get('lastSeenAgoSec')}s  "
            f"gpsInWindow={g.get('count')}  gpsHz={g.get('rateHz')}  "
            f"fixAge={g.get('ageSec')}s  displayAge={g.get('displayAgeSec')}s"
        )
        last = g.get("last") or {}
        print(f"fleet last: {last.get('lat')},{last.get('lon')} acc={last.get('acc')}")
    if pos:
        print(
            f"map: {pos.get('latitude')},{pos.get('longitude')}  "
            f"fixAge={pos.get('fixAgeSec')}s  smooth={pos.get('smoothLatitude')},{pos.get('smoothLongitude')}"
        )


if __name__ == "__main__":
    main()
