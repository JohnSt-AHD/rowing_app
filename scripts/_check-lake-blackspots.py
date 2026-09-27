#!/usr/bin/env python3
"""Find GPS/cell black spots from reporting gaps — M1x TM + W2x EH."""
import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICES = ["M1x TM", "W2x EH"]
AUCKLAND = timezone(timedelta(hours=12))
GAP_BLACKOUT_S = 15  # treat as likely coverage/upload blackout


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fmt(t_ms):
    return datetime.fromtimestamp(t_ms / 1000, tz=AUCKLAND).strftime("%H:%M:%S")


def hav(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    x = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def session_track(uid):
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(uid)).get("sessions") or []
    if not sess:
        return None, []
    s0 = sess[0]
    data = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(s0["session_id"]))
    gps = sorted(
        [p for p in (data.get("track") or []) if p.get("lat") is not None and p.get("lon") is not None],
        key=lambda x: x["t"],
    )
    return s0, gps


def analyze_blackspots(uid, gps, session_info):
    print(f"\n{'='*70}\n  {uid}  session {session_info['session_id'][:8] if session_info else '?'}")
    print(f"  started {session_info.get('started_at') if session_info else '?'}")
    print(f"{'='*70}")
    if len(gps) < 2:
        print("  too few GPS points")
        return

    t0, t1 = gps[0]["t"], gps[-1]["t"]
    span_min = (t1 - t0) / 60000
    print(f"  GPS fixes: {len(gps)} over {span_min:.0f} min")
    print(
        f"  track extent: lat {min(p['lat'] for p in gps):.5f} .. {max(p['lat'] for p in gps):.5f}"
        f"  lon {min(p['lon'] for p in gps):.5f} .. {max(p['lon'] for p in gps):.5f}"
    )

    gaps = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        if dt <= 0:
            continue
        p0, p1 = gps[i - 1], gps[i]
        dist = hav(p0["lat"], p0["lon"], p1["lat"], p1["lon"])
        gaps.append(
            {
                "i": i,
                "dt": dt,
                "dist": dist,
                "lat0": p0["lat"],
                "lon0": p0["lon"],
                "lat1": p1["lat"],
                "lon1": p1["lon"],
                "t0": p0["t"],
                "t1": p1["t"],
                "implied_mps": dist / dt if dt else 0,
            }
        )

    gs = sorted(g["dt"] for g in gaps)
    normal = [g for g in gaps if g["dt"] <= 12]
    blackouts = [g for g in gaps if g["dt"] >= GAP_BLACKOUT_S]
    degraded = [g for g in gaps if 8 <= g["dt"] < GAP_BLACKOUT_S]

    print(
        f"  gap median={statistics.median(g['dt'] for g in gaps):.2f}s"
        f" p95={gs[int(0.95*(len(gs)-1))]:.2f}s max={max(g['dt'] for g in gaps):.1f}s"
    )
    print(
        f"  normal (<=12s): {len(normal)}  degraded (8-15s): {len(degraded)}"
        f"  blackouts (>={GAP_BLACKOUT_S}s): {len(blackouts)}"
    )

    if blackouts:
        print(f"\n  BLACKOUTS (>={GAP_BLACKOUT_S}s no GPS/upload):")
        for g in sorted(blackouts, key=lambda x: -x["dt"])[:15]:
            mid_lat = (g["lat0"] + g["lat1"]) / 2
            mid_lon = (g["lon0"] + g["lon1"]) / 2
            print(
                f"    {fmt(g['t0'])} -> {fmt(g['t1'])}  gap={g['dt']:.0f}s"
                f"  dist={g['dist']:.0f}m  implied={g['implied_mps']:.1f}m/s"
            )
            print(f"      from ({g['lat0']:.5f},{g['lon0']:.5f}) to ({g['lat1']:.5f},{g['lon1']:.5f})")
            print(f"      mid ({mid_lat:.5f},{mid_lon:.5f})")

    # Cluster blackouts/degraded by location (0.002 deg ~ 220m)
    def bucket(lat, lon):
        return (round(lat, 3), round(lon, 3))

    clusters = {}
    for g in blackouts + degraded:
        b = bucket((g["lat0"] + g["lat1"]) / 2, (g["lon0"] + g["lon1"]) / 2)
        clusters.setdefault(b, []).append(g)

    if clusters:
        print("\n  GAP CLUSTERS (degraded/blackout midpoints):")
        for (lat, lon), items in sorted(clusters.items(), key=lambda x: -len(x[1]))[:8]:
            max_gap = max(x["dt"] for x in items)
            print(f"    ({lat:.3f},{lon:.3f})  events={len(items)}  max_gap={max_gap:.0f}s")

    # Track "down lake" — assume lon increases or lat decreases; show gaps along route order
    print("\n  ROUTE TIMELINE (gaps >=8s along track):")
    for g in sorted([x for x in gaps if x["dt"] >= 8], key=lambda x: x["t0"]):
        print(
            f"    {fmt(g['t0'])} gap={g['dt']:.0f}s @ ({g['lat0']:.5f},{g['lon0']:.5f})"
            f" -> ({g['lat1']:.5f},{g['lon1']:.5f})"
        )

    # Live snapshot
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == uid), None)
    if pos:
        print(
            f"\n  LIVE NOW: ({pos.get('latitude'):.5f},{pos.get('longitude'):.5f})"
            f" fixAge={pos.get('fixAgeSec')}s lastSeen={pos.get('lastSeenAgoSec')}s"
            f" stale={pos.get('telemetryStale')}"
        )
        if pos.get("gpsFixAgeSec") is not None:
            print(
                f"    gpsFixAge={pos.get('gpsFixAgeSec')}s uploadLag={pos.get('uploadLagSec')}s"
            )


def main():
    print(f"Black-spot scan @ {datetime.now(AUCKLAND).strftime('%Y-%m-%d %H:%M:%S')} NZ")
    for uid in DEVICES:
        info, gps = session_track(uid)
        if info:
            analyze_blackspots(uid, gps, info)


if __name__ == "__main__":
    main()
