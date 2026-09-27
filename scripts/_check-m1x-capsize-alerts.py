#!/usr/bin/env python3
"""M1x TM capsize samples vs server alert state (today NZ)."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M1x TM"
AUCKLAND = timezone(timedelta(hours=12))


def get(path: str):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fmt_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).astimezone(AUCKLAND).strftime(
        "%Y-%m-%d %H:%M:%S %Z"
    )


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def main():
    geofences = get("/api/geofences").get("geofences", [])
    rnz = next((g for g in geofences if "RNZ" in (g.get("name") or "")), None)
    print("=== RNZ geofence ===")
    print(json.dumps(rnz, indent=2) if rnz else "not found")

    try:
        devs = get("/api/devices?windowSec=3600&onlineSec=3600").get("devices", [])
    except Exception as e:
        print("devices API failed:", e)
        devs = []
    d = next((x for x in devs if x.get("deviceId") == UID), None)
    print("\n=== M1x TM device capsize fields ===")
    if d:
        keys = sorted(k for k in d if "capsize" in k.lower() or k in ("deviceId", "lastSeenAt", "geofenceName", "economyMode"))
        print({k: d.get(k) for k in keys})

    day_start = datetime(2026, 7, 27, 0, 0, 0, tzinfo=AUCKLAND).astimezone(timezone.utc)
    frm = day_start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    enc = urllib.parse.quote(UID, safe="")
    data = get(
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    )
    print("\n=== dashboard today ===")
    print(
        "pointCount",
        data.get("pointCount"),
        "capsizeSampleCount",
        data.get("capsizeSampleCount"),
        "incidents",
        len(data.get("capsizeEvents") or []),
    )

    clat = rnz.get("centerLat", -37.932381) if rnz else -37.932381
    clon = rnz.get("centerLon", 175.542613) if rnz else 175.542613
    rad = rnz.get("radiusM", 150) if rnz else 150

    caps = [p for p in (data.get("track") or []) if p.get("capsize")]
    print("\nCapsize samples today:")
    for p in caps:
        lat, lon = p.get("lat"), p.get("lon")
        inside = "unknown"
        if lat is not None and lon is not None:
            dist = haversine(lat, lon, clat, clon)
            if dist <= rad:
                inside = f"inside RNZ ({dist:.0f}m from centre)"
            else:
                inside = f"outside RNZ ({dist:.0f}m, {dist - rad:.0f}m beyond edge)"
        loc = f"{lat:.6f}, {lon:.6f}" if lat is not None else "no GPS"
        print(f"  {fmt_ms(p['t'])}  {loc}  tilt={p.get('tiltDeg')}  {inside}")

    lb = get("/api/history?list=logbook&days=2&tz=Pacific/Auckland")
    for day in lb.get("days", []):
        if day.get("date") == "2026-07-27":
            print("\n=== logbook 2026-07-27 ===")
            print("capsizeCount:", day.get("capsizeCount"))

    snap = get("/api/map-positions")
    print("\n=== map-positions capsize sticky ===")
    for dev in snap.get("devices", []):
        if dev.get("deviceId") == UID:
            print(
                {
                    k: dev.get(k)
                    for k in dev
                    if "capsize" in k.lower() or k in ("deviceId", "capsize")
                }
            )


if __name__ == "__main__":
    main()
