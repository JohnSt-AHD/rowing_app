#!/usr/bin/env python3
import json
import math
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=90) as r:
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


def in_geofence(lat, lon, g):
    shape = g.get("shapeType", "circle")
    if shape == "polygon":
        ring = g.get("polygonCoords") or []
        return len(ring) >= 3 and point_in_polygon(lat, lon, ring)
    clat, clon, rad = float(g["centerLat"]), float(g["centerLon"]), float(g["radiusM"])
    return hav(lat, lon, clat, clon) <= rad


def analyze_recent(device_id, minutes=15):
    sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get("sessions") or []
    if not sessions:
        return None
    sid = sessions[0]["session_id"]
    hist = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    track = [p for p in hist.get("track", []) if p.get("lat") is not None]
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    cutoff = now_ms - minutes * 60 * 1000
    recent = [p for p in track if p["t"] >= cutoff]
    if len(recent) < 2:
        return {"points": len(recent)}

    intervals = [(recent[i]["t"] - recent[i - 1]["t"]) / 1000 for i in range(1, len(recent))]
    tight = [x for x in intervals if x <= 120]
    buckets = Counter()
    for x in tight:
        if x <= 3:
            buckets["1-3s"] += 1
        elif x <= 8:
            buckets["4-8s"] += 1
        elif x <= 20:
            buckets["9-20s"] += 1
        elif x <= 40:
            buckets["21-40s"] += 1
        else:
            buckets[">40s"] += 1

    ts_sorted = sorted(tight) if tight else []
    return {
        "session": sid[:8],
        "active": sessions[0].get("ended_at") is None,
        "points": len(recent),
        "interval_med": round(ts_sorted[len(ts_sorted) // 2], 1) if ts_sorted else None,
        "interval_min": round(min(tight), 1) if tight else None,
        "interval_max": round(max(tight), 1) if tight else None,
        "buckets": dict(buckets),
        "last8": recent[-8:],
    }


def main():
    geofences = get("/api/geofences").get("geofences") or []
    keeleys = [g for g in geofences if "keeley" in (g.get("name") or "").lower()]
    print("=== KEELEYS GEOFENCE(S) ===")
    for g in keeleys:
        print(
            f"  {g.get('name')}: enabled={g.get('enabled')} "
            f"economyGps={g.get('economyGpsIntervalSec')}s "
            f"economyUpload={g.get('economyUploadIntervalSec')}s "
            f"suppress={g.get('suppressRecording')} autoStop={g.get('autoStopOnEnter')}"
        )

    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    positions = mp.get("positions") or []

    print("\n=== DEVICES vs KEELEYS ===")
    online_in = []
    for p in positions:
        lat, lon = p.get("latitude"), p.get("longitude")
        if lat is None:
            continue
        inside_keeleys = [g for g in keeleys if g.get("enabled", True) and in_geofence(lat, lon, g)]
        if inside_keeleys:
            online_in.append((p, inside_keeleys[0]))
            legacy = p.get("gpsProvider") is None and p.get("gpsSampleSource") is None
            print(f"\n--- {p.get('deviceId')} INSIDE {inside_keeleys[0].get('name')} ---")
            print(f"  app: {'LEGACY' if legacy else 'DEBUG'}")
            for k in [
                "online", "lastSeenAgoSec", "ingestAgoSec", "gpsFixAgeSec",
                "accuracy", "pathSpeedMps", "displaySpeedMps", "speed",
                "latitude", "longitude",
            ]:
                v = p.get(k)
                if v is not None:
                    print(f"  {k}: {v}")

            a = analyze_recent(p.get("deviceId"), minutes=20)
            if a:
                print(f"  recent 20min: points={a.get('points')} med={a.get('interval_med')}s "
                      f"min={a.get('interval_min')}s max={a.get('interval_max')}s buckets={a.get('buckets')}")
                print("  last uploads:")
                for pt in a.get("last8", [])[-6:]:
                    ts = datetime.fromtimestamp(pt["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
                    print(f"    {ts} acc={pt.get('acc')}")

    if not online_in:
        print("  No device currently positioned inside Keeleys geofence.")
        print("\n  Online devices:")
        for p in [x for x in positions if x.get("online")]:
            print(
                f"    {p.get('deviceId')}: lastSeen={p.get('lastSeenAgoSec')}s "
                f"lat={p.get('latitude')} lon={p.get('longitude')}"
            )


if __name__ == "__main__":
    main()
