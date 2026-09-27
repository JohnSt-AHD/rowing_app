#!/usr/bin/env python3
import json
import math
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
DEVICE = "M4X JS"


def get(path):
    req = urllib.request.Request(BASE + path, headers=H)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def hav(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def point_in_polygon(lat, lon, ring):
    x, y = lon, lat
    inside = False
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i][0], ring[i][1]
        y2, x2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1):
            inside = not inside
    return inside


def main():
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
    print("=== MAP POSITION ===")
    if not pos:
        print("NOT ONLINE / not found")
        return

    core = [
        "online",
        "lastSeenAgoSec",
        "ingestAgoSec",
        "latitude",
        "longitude",
        "accuracy",
        "smoothLatitude",
        "smoothLongitude",
        "smoothed",
        "speed",
        "pathSpeedMps",
        "displaySpeedMps",
        "course",
        "compass",
        "gpsProvider",
        "gpsSampleSource",
        "fixMs",
        "gpsFixMs",
        "fixAgeSec",
        "gpsFixAgeSec",
        "uploadLagSec",
        "displayFixAgeSec",
        "telemetryStale",
        "strokeRate",
        "displayStrokeRate",
        "capsize",
        "hr",
        "batteryPct",
        "heartbeatRateHz",
    ]
    for k in core:
        v = pos.get(k)
        if v is not None:
            print(f"  {k}: {v}")
    if pos.get("gpsFixMs"):
        ts = datetime.fromtimestamp(pos["gpsFixMs"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        print(f"  gpsFixMs UTC: {ts}")
    if pos.get("fixMs"):
        ts = datetime.fromtimestamp(pos["fixMs"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        print(f"  fixMs(upload) UTC: {ts}")

    lat, lon = pos.get("latitude"), pos.get("longitude")

    print("\n=== GEOFENCES ===")
    inside = []
    near = []
    for g in get("/api/geofences").get("geofences", []):
        if not g.get("enabled", True):
            continue
        name = g.get("name", "?")
        shape = g.get("shapeType", "circle")
        if shape == "polygon":
            ring = g.get("polygonCoords") or []
            if len(ring) < 3:
                continue
            inz = point_in_polygon(lat, lon, ring)
            clat = sum(p[0] for p in ring) / len(ring)
            clon = sum(p[1] for p in ring) / len(ring)
            dist = hav(lat, lon, clat, clon)
        else:
            clat = float(g["centerLat"])
            clon = float(g["centerLon"])
            rad = float(g["radiusM"])
            dist = hav(lat, lon, clat, clon)
            inz = dist <= rad
        if inz:
            inside.append(
                (
                    name,
                    g.get("economyGpsIntervalSec"),
                    g.get("suppressRecording"),
                    g.get("autoStopOnEnter"),
                )
            )
        elif dist < 500:
            near.append((name, int(dist)))

    if inside:
        print("  INSIDE:")
        for row in inside:
            print(f"    {row[0]} economyGps={row[1]}s suppress={row[2]} autoStop={row[3]}")
    else:
        print("  Not inside any geofence")
        print("  Nearest within 500m:", near[:3] if near else "(none)")

    print("\n=== DEVICES API ===")
    dev = next((d for d in get("/api/devices").get("devices", []) if d.get("deviceId") == DEVICE), None)
    if dev:
        gps = dev.get("gps") or {}
        print("  gps.present:", gps.get("present"))
        print("  gps.last:", json.dumps(gps.get("last"), indent=4))
        for k in ["ageSec", "gpsFixAgeSec", "uploadLagSec", "ingestAgoSec", "displayAgeSec", "rateHz", "count"]:
            print(f"  gps.{k}:", gps.get(k))
        rowing = dev.get("rowing") or {}
        print("  strokeRate:", rowing.get("strokeRate"), "valid:", rowing.get("strokeRateValid"))
        bat = dev.get("battery") or {}
        if bat:
            print("  battery:", bat)
    else:
        print("  not found")

    print("\n=== RECENT SESSION (reporting + debug) ===")
    sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(DEVICE)).get("sessions") or []
    if not sessions:
        print("  no sessions")
        return

    s0 = sessions[0]
    sid = s0["session_id"]
    ended = s0.get("ended_at")
    print(
        f"  session {sid[:8]}… started {s0['started_at']} "
        f"ended {ended or 'ACTIVE'} samples {s0['sample_count']}"
    )
    hist = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    track = [p for p in hist.get("track", []) if p.get("lat") is not None]
    if len(track) < 2:
        print("  insufficient GPS track")
        return

    ts = [p["t"] for p in track]
    intervals = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
    accs = [p["acc"] for p in track if p.get("acc") is not None]
    sources = Counter(p.get("gpsSampleSource") for p in track)
    providers = Counter(p.get("gpsProvider") for p in track)
    lats = [p["lat"] for p in track[-20:]]
    lons = [p["lon"] for p in track[-20:]]
    drift_m = hav(min(lats), min(lons), max(lats), max(lons)) if lats else 0

    print(f"  gps points: {len(track)}")
    print(
        f"  upload interval: min={min(intervals):.1f}s "
        f"med={sorted(intervals)[len(intervals) // 2]:.1f}s max={max(intervals):.1f}s"
    )
    if accs:
        print(
            f"  accuracy: min={min(accs):.1f}m med={sorted(accs)[len(accs) // 2]:.1f}m max={max(accs):.1f}m"
        )
    print(f"  sampleSource counts: {dict(sources)}")
    print(f"  provider counts: {dict(providers)}")
    print(f"  last-20 coord spread: {drift_m:.1f}m (stationary check)")

    fix_lags = []
    for p in track[-15:]:
        if p.get("fixMs") and p.get("t"):
            fix_lags.append((p["t"] - p["fixMs"]) / 1000)
    if fix_lags:
        print(f"  upload-fix lag (t-fixMs): min={min(fix_lags):.1f}s max={max(fix_lags):.1f}s")

    print("  last 3 points:")
    for p in track[-3:]:
        print(
            "   ",
            {k: p.get(k) for k in ["t", "lat", "lon", "acc", "compass", "fixMs", "gpsProvider", "gpsSampleSource"]},
        )

    print("\n=== HEALTH CHECKS ===")
    checks = []
    checks.append(("Online", pos.get("online") is True))
    checks.append(("Fresh ingest (<30s)", (pos.get("ingestAgoSec") or 999) < 30))
    checks.append(("GPS fix age reasonable (<60s)", (pos.get("gpsFixAgeSec") or 999) < 60))
    checks.append(("Fused provider", pos.get("gpsProvider") == "fused"))
    checks.append(("Debug sampleSource present", pos.get("gpsSampleSource") is not None))
    checks.append(("Compass present", pos.get("compass") is not None))
    checks.append(("Accuracy OK indoor (<25m)", (pos.get("accuracy") or 999) < 25))
    checks.append(("Not in geofence economy", len(inside) == 0))
    checks.append(("Path speed ~0 stationary", (pos.get("pathSpeedMps") or 0) < 0.5))
    checks.append(("No capsize alert", pos.get("capsize") is not True))
    checks.append(("Stationary drift <15m", drift_m < 15))
    for name, ok in checks:
        print(f"  {'PASS' if ok else 'WARN'} — {name}")


if __name__ == "__main__":
    main()
