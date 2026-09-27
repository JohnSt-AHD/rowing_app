#!/usr/bin/env python3
"""Trace M1x TM samples around inside-RNZ capsize events (27 Jul 2026 NZ)."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M1x TM"
SID = "315e22f9-3c4e-4a56-a82c-6d308f1623cd"
AUCKLAND = timezone(timedelta(hours=12))
RNZ = {"lat": -37.932381, "lon": 175.542613, "rad": 150}


def get(path: str):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fmt_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).astimezone(AUCKLAND).strftime(
        "%H:%M:%S"
    )


def dist_m(lat, lon):
    r = 6371000
    p1, p2 = math.radians(RNZ["lat"]), math.radians(lat)
    dlat = math.radians(lat - RNZ["lat"])
    dlon = math.radians(lon - RNZ["lon"])
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def analyze_window(label, t_center_ms, window_sec=300):
    frm = datetime.fromtimestamp((t_center_ms - window_sec * 1000) / 1000, tz=timezone.utc)
    to = datetime.fromtimestamp((t_center_ms + window_sec * 1000) / 1000, tz=timezone.utc)
    frm_s = frm.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to_s = to.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    data = get(
        f"/api/history?format=dashboard&sessionId={SID}&from={urllib.parse.quote(frm_s)}&to={urllib.parse.quote(to_s)}"
    )
    track = data.get("track") or []
    print(f"\n=== {label} ({fmt_ms(t_center_ms)} NZ) — {len(track)} points ===")

    gps_pts = [p for p in track if p.get("lat") is not None]
    caps = [p for p in track if p.get("capsize")]
    in_park = [p for p in track if (p.get("derived") or {}).get("inBoatPark") or p.get("inBoatPark")]

    print(f"  gps={len(gps_pts)} capsize={len(caps)} inBoatPark_flag={len(in_park)}")

    if len(gps_pts) >= 2:
        gaps = []
        for i in range(1, len(gps_pts)):
            gaps.append((gps_pts[i]["t"] - gps_pts[i - 1]["t"]) / 1000)
        gaps.sort()
        print(f"  GPS gaps (s): min={gaps[0]:.1f} med={gaps[len(gaps)//2]:.1f} max={gaps[-1]:.1f}")

    for p in caps:
        lat, lon = p.get("lat"), p.get("lon")
        d = dist_m(lat, lon) if lat is not None else None
        print(
            f"  CAPSIZE {fmt_ms(p['t'])} tilt={p.get('tiltDeg')} "
            f"dist={d:.0f}m" if d is not None else f"  CAPSIZE {fmt_ms(p['t'])} no GPS"
        )

    # Show samples ±60s around capsize
    near = [p for p in track if abs(p["t"] - t_center_ms) <= 60000]
    print(f"  samples ±60s: {len(near)}")
    for p in near[:20]:
        lat, lon = p.get("lat"), p.get("lon")
        d = dist_m(lat, lon) if lat is not None else None
        flags = []
        if p.get("capsize"):
            flags.append("capsize")
        if p.get("inBoatPark"):
            flags.append("inBoatPark")
        gps = f"{lat:.5f},{lon:.5f}" if lat is not None else "no-gps"
        extra = f" dist={d:.0f}m" if d is not None else ""
        print(f"    {fmt_ms(p['t'])} {gps} {' '.join(flags)}{extra}")


def main():
    # 06:29:17 and 06:47:03 NZ = 18:29:17 and 18:47:03 UTC on 26 Jul... 
    # Wait - Jul 27 06:29 NZ = Jul 26 18:29 UTC
    events = [
        ("Capsize 1", datetime(2026, 7, 27, 6, 29, 17, tzinfo=AUCKLAND)),
        ("Capsize 2", datetime(2026, 7, 27, 6, 47, 3, tzinfo=AUCKLAND)),
    ]
    for label, dt in events:
        analyze_window(label, int(dt.astimezone(timezone.utc).timestamp() * 1000))

    # Raw ingest samples around first event
    raw = get(f"/api/ingest?sessionId={SID}")
    samples = raw.get("samples") or []
    t1 = int(events[0][1].astimezone(timezone.utc).timestamp() * 1000)
    near = [s for s in samples if abs(s.get("t", 0) - t1) <= 120000]
    print(f"\n=== raw ingest ±2min capsize1: {len(near)} samples ===")
    for s in sorted(near, key=lambda x: x.get("t", 0))[:30]:
        d = s.get("derived") or {}
        g = s.get("gps") or {}
        lat, lon = g.get("lat"), g.get("lon")
        flags = []
        if d.get("capsize"):
            flags.append("capsize")
        if d.get("inBoatPark"):
            flags.append("inBoatPark")
        gps = f"{lat:.5f},{lon:.5f}" if lat is not None else "no-gps"
        print(f"  {fmt_ms(s['t'])} {gps} {' '.join(flags)}")


if __name__ == "__main__":
    main()
