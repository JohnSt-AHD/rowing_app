#!/usr/bin/env python3
"""Collect KRI input vs map output speeds and write JSON for plotting."""

import json
import math
import time
import urllib.request
from pathlib import Path

BASE = "https://rowing-app-recorder-pwa.vercel.app"
DEVICE = "TEST-KRI-RACE"
COURSE_GROUP = "2 km course"
KRI_DATA = "https://ahd-livestream.vercel.app/data/kri-sample-wrcp1-m1x-h1.json"
LANE = "ESP1"
POLL_SEC = 3
POLL_COUNT = 30
HEADERS = {"Accept": "application/json", "Authorization": "Bearer rnz"}
EARTH_R = 6371000
OUT_JSON = Path(__file__).resolve().parent.parent / "assets" / "crewsight" / "kri-speed-compare-data.json"


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def along_course_m(lat, lon, origin, bearing):
    def dist(a, b, c, d):
        p1, p2 = math.radians(a), math.radians(c)
        dl, dn = math.radians(c - a), math.radians(d - b)
        h = math.sin(dl / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dn / 2) ** 2
        return 2 * EARTH_R * math.asin(min(1, math.sqrt(h)))

    d = dist(origin["lat"], origin["lon"], lat, lon)
    brg = (
        math.degrees(
            math.atan2(
                math.sin(math.radians(lon - origin["lon"])) * math.cos(math.radians(lat)),
                math.cos(math.radians(origin["lat"])) * math.sin(math.radians(lat))
                - math.sin(math.radians(origin["lat"]))
                * math.cos(math.radians(lat))
                * math.cos(math.radians(lon - origin["lon"])),
            )
        )
        + 360
    ) % 360
    return max(0, d * math.cos(math.radians(((brg - bearing) + 540) % 360 - 180)))


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


def mps_to_split500(mps):
    if not mps or mps <= 0:
        return None
    t = 500 / mps
    return f"{int(t // 60)}:{round(t % 60):02d}"


def main():
    kri = json.loads(urllib.request.urlopen(KRI_DATA, timeout=60).read())
    boat = next(b for b in kri["boats"] if b["id"] == LANE)
    speed_at = build_speed_at(boat["points"])

    lines = fetch(f"{BASE}/api/timing-lines?courseGroup={urllib.parse.quote(COURSE_GROUP)}")[
        "lines"
    ]
    start = next(l for l in lines if l["lineType"] == "start")
    origin = {"lat": (start["lat1"] + start["lat2"]) / 2, "lon": (start["lon1"] + start["lon2"]) / 2}
    bearing = start["courseBearingDeg"]

    rows = []
    t0 = time.time()
    for i in range(POLL_COUNT):
        ps = fetch(f"{BASE}/api/map-positions?onlineSec=120&staleSec=3600")["positions"]
        p = next((x for x in ps if x.get("deviceId") == DEVICE), None)
        if not p:
            time.sleep(POLL_SEC)
            continue
        dist_m = along_course_m(p["latitude"], p["longitude"], origin, bearing)
        input_mps = speed_at(dist_m)
        raw = p.get("speed")
        path = p.get("pathSpeedMps")
        disp = p.get("displaySpeedMps")
        rows.append(
            {
                "tSec": round(time.time() - t0, 1),
                "distM": round(dist_m, 1),
                "inputMps": round(input_mps, 3) if input_mps else None,
                "rawMps": round(raw, 3) if raw is not None else None,
                "pathMps": round(path, 3) if path is not None else None,
                "displayMps": round(disp, 3) if disp is not None else None,
                "stale": bool(p.get("telemetryStale")),
            }
        )
        time.sleep(POLL_SEC)

    payload = {
        "deviceId": DEVICE,
        "lane": LANE,
        "courseGroup": COURSE_GROUP,
        "collectedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "pollSec": POLL_SEC,
        "kriProfile": [{"distance": pt["distance"], "speed": pt["speed"]} for pt in boat["points"]],
        "samples": rows,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {len(rows)} samples to {OUT_JSON}")


if __name__ == "__main__":
    import urllib.parse

    main()
