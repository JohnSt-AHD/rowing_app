#!/usr/bin/env python3
"""Compare RowSafe map API outputs vs KRI simulator ground truth for TEST-KRI-RACE."""

import json
import math
import statistics
import time
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
DEVICE = "TEST-KRI-RACE"
COURSE_GROUP = "2 km course"
KRI_DATA = "https://ahd-livestream.vercel.app/data/kri-sample-wrcp1-m1x-h1.json"
LANE = "ESP1"
POLL_SEC = 3
POLL_COUNT = 40
HEADERS = {"Accept": "application/json", "Authorization": "Bearer rnz"}
EARTH_R = 6371000


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1, math.sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = map(math.radians, (lat1, lat2))
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(lat, lon, brg, dist_m):
    if dist_m <= 0:
        return lat, lon
    d = dist_m / EARTH_R
    t = math.radians(brg)
    p1 = math.radians(lat)
    l1 = math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(t))
    l2 = l1 + math.atan2(
        math.sin(t) * math.sin(d) * math.cos(p1),
        math.cos(d) - math.sin(p1) * math.sin(p2),
    )
    return math.degrees(p2), math.degrees(l2)


def build_speed_at(points):
    pts = sorted(points, key=lambda p: p["distance"])

    def at(d):
        d = max(0, min(pts[-1]["distance"], d))
        if d <= pts[0]["distance"]:
            return pts[0]["speed"]
        for i in range(1, len(pts)):
            a, b = pts[i - 1], pts[i]
            if d <= b["distance"]:
                span = b["distance"] - a["distance"]
                if span <= 0:
                    return b["speed"]
                t = (d - a["distance"]) / span
                return a["speed"] + t * (b["speed"] - a["speed"])
        return pts[-1]["speed"]

    return at


def build_course(lines):
    group = [l for l in lines if l.get("courseGroup") == COURSE_GROUP and l.get("enabled", True)]
    group.sort(key=lambda l: l.get("sortOrder", 0))
    start = next(l for l in group if l.get("lineType") == "start")
    finish = next(l for l in group if l.get("lineType") == "finish")
    origin = {
        "lat": (start["lat1"] + start["lat2"]) / 2,
        "lon": (start["lon1"] + start["lon2"]) / 2,
    }
    bearing = start["courseBearingDeg"]
    course_m = finish["distanceM"]
    return origin, bearing, course_m


def along_course_m(lat, lon, origin, bearing):
    dist = haversine_m(origin["lat"], origin["lon"], lat, lon)
    brg = bearing_deg(origin["lat"], origin["lon"], lat, lon)
    delta = math.radians(((brg - bearing) + 540) % 360 - 180)
    return max(0, dist * math.cos(delta))


def pct_err(actual, expected):
    if actual is None or expected is None or not expected:
        return None
    return (actual - expected) / expected * 100


def split500(mps):
    if not mps or mps <= 0:
        return "—"
    t = 500 / mps
    return f"{int(t // 60)}:{round(t % 60):02d}/500"


def summarize(name, errs):
    vals = [abs(e) for e in errs if e is not None]
    if not vals:
        return f"  {name}: no data"
    return (
        f"  {name}: n={len(vals)}  avg|err|={statistics.mean(vals):.1f}%  "
        f"med|err|={statistics.median(vals):.1f}%  max|err|={max(vals):.1f}%"
    )


def main():
    kri = fetch(KRI_DATA)
    boat = next(b for b in kri["boats"] if b["id"] == LANE)
    speed_at = build_speed_at(boat["points"])

    timing = fetch(f"{BASE}/api/timing-lines?courseGroup={urllib.parse.quote(COURSE_GROUP)}")
    origin, bearing, course_m = build_course(timing["lines"])

    print(f"Map output vs input — {DEVICE} ({LANE} KRI profile)")
    print(f"Course: {course_m:.0f} m @ {bearing:.1f}°  polling {POLL_COUNT}x every {POLL_SEC}s\n")
    print(
        f"{'#':>3}  {'dist':>5}  {'input':>6}  {'raw':>6}  {'map':>6}  "
        f"{'path':>6}  {'disp':>6}  {'posOff':>6}  notes"
    )
    print("-" * 72)

    rows = []
    for i in range(POLL_COUNT):
        try:
            mp = fetch(f"{BASE}/api/map-positions?onlineSec=120&staleSec=3600")
            p = next((x for x in mp.get("positions", []) if x.get("deviceId") == DEVICE), None)
        except Exception as e:
            print(f"{i:3d}  poll error: {e}")
            time.sleep(POLL_SEC)
            continue

        if not p:
            print(f"{i:3d}  device not on map")
            time.sleep(POLL_SEC)
            continue

        lat = p.get("latitude")
        lon = p.get("longitude")
        dist_m = along_course_m(lat, lon, origin, bearing) if lat and lon else None
        input_mps = speed_at(dist_m) if dist_m is not None else None

        raw = p.get("speed")
        path = p.get("pathSpeedMps")
        disp = p.get("displaySpeedMps")
        sm_lat = p.get("smoothLatitude")
        sm_lon = p.get("smoothLongitude")
        pos_off = haversine_m(lat, lon, sm_lat, sm_lon) if None not in (lat, lon, sm_lat, sm_lon) else None

        notes = []
        if p.get("telemetryStale"):
            notes.append("stale")
        if p.get("smoothed"):
            notes.append("smoothed")
        if path is None:
            notes.append("no-path")
        if disp is None:
            notes.append("no-disp")

        rows.append(
            {
                "dist_m": dist_m,
                "input_mps": input_mps,
                "raw": raw,
                "path": path,
                "disp": disp,
                "pos_off_m": pos_off,
            }
        )

        def fmt(v):
            return f"{v:5.2f}" if v is not None else "    —"

        pos_str = f"{pos_off:5.1f}m" if pos_off is not None else "     —"
        print(
            f"{i:3d}  {dist_m:5.0f}m  {fmt(input_mps)}  {fmt(raw)}  {fmt(raw)}  "
            f"{fmt(path)}  {fmt(disp)}  {pos_str}"
            + (f"  [{','.join(notes)}]" if notes else "")
        )

        time.sleep(POLL_SEC)

    print("\n=== Summary vs KRI input speed (gps.spd ground truth) ===")
    input_vals = [r["input_mps"] for r in rows if r["input_mps"]]
    if input_vals:
        print(
            f"  Distance range: {min(r['dist_m'] for r in rows if r['dist_m'] is not None):.0f}–"
            f"{max(r['dist_m'] for r in rows if r['dist_m'] is not None):.0f} m"
        )
        print(f"  Input speed range: {min(input_vals):.2f}–{max(input_vals):.2f} m/s")

    print(summarize("Raw GPS (ingest)", [pct_err(r["raw"], r["input_mps"]) for r in rows]))
    print(
        summarize(
            "Path pace (60s window)",
            [pct_err(r["path"], r["input_mps"]) for r in rows if r["path"] is not None],
        )
    )
    print(
        summarize(
            "Display pace (EMA)",
            [pct_err(r["disp"], r["input_mps"]) for r in rows if r["disp"] is not None],
        )
    )

    offs = [r["pos_off_m"] for r in rows if r["pos_off_m"] is not None]
    if offs:
        print(
            f"\n=== Map marker position (raw vs smooth/predicted) ===\n"
            f"  Offset: avg={statistics.mean(offs):.2f} m  med={statistics.median(offs):.2f} m  "
            f"max={max(offs):.2f} m"
        )

    path_null = sum(1 for r in rows if r["path"] is None)
    disp_null = sum(1 for r in rows if r["disp"] is None)
    print(
        f"\n=== Availability ===\n"
        f"  pathSpeedMps null: {path_null}/{len(rows)} polls\n"
        f"  displaySpeedMps null: {disp_null}/{len(rows)} polls"
    )

    print("\n=== Layer guide ===")
    print("  Input     = KRI ESP1 speed at projected course distance (simulator gps.spd)")
    print("  Raw       = last ingest gps.spd on /api/map-positions")
    print("  Path      = 60s track distance/time (coach/course pace primary)")
    print("  Display   = EMA(a=0.2) on path pace + 45s hold")
    print("  Pos offset = metres between raw fix and smooth/predicted map marker")


if __name__ == "__main__":
    import urllib.parse

    main()
