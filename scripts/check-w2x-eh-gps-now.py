#!/usr/bin/env python3
"""W2x EH live speed + GPS consistency check."""

import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}


def get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(s):
    if s is None or s < 0.25:
        return None
    t = 500 / float(s)
    return f"{int(t // 60)}:{t % 60:04.1f}"


def hav(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def main():
    now = datetime.now(timezone.utc)
    frm = (now - timedelta(minutes=12)).isoformat().replace("+00:00", "Z")
    to = now.isoformat().replace("+00:00", "Z")
    enc = urllib.parse.quote(UID, safe="")

    mp = get("/api/map-positions?onlineSec=600&staleSec=3600&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    dev = next(
        (
            x
            for x in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get(
                "devices", []
            )
            if x.get("deviceId") == UID
        ),
        None,
    )

    print(f"=== {UID} @ {now.strftime('%H:%M:%S')} UTC ===\n")
    if not p:
        print("Not on map right now.")
    else:
        raw = p.get("speed")
        path = p.get("pathSpeedMps")
        disp = p.get("displaySpeedMps")
        print(
            f"online={p.get('online')} stale={p.get('telemetryStale')} "
            f"seen={p.get('lastSeenAgoSec')}s fixAge={p.get('fixAgeSec')}s"
        )
        if raw:
            print(f"raw map speed:  {raw:.3f} m/s ({split500(raw)}/500)")
        if path:
            print(f"path pace 15s:  {path:.3f} m/s ({split500(path)}/500)")
        if disp:
            print(f"display EMA:    {disp:.3f} m/s ({split500(disp)}/500)")
        print(f"stroke map={p.get('strokeRate')} display={p.get('displayStrokeRate')}")

    if dev:
        gps = dev.get("gps") or {}
        last = gps.get("last") or {}
        print(
            f"\ndevice GPS: spd={last.get('spd')} rateHz={gps.get('rateHz')} "
            f"count={gps.get('count')} ingestAgo={gps.get('ingestAgoSec')}s acc={last.get('acc')}m"
        )

    track = get(
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    ).get("track") or []
    pts = [x for x in track if x.get("lat") is not None and x.get("lon") is not None and x.get("t")]
    pts.sort(key=lambda x: x["t"])
    print(f"\nLast 12 min: {len(pts)} GPS fixes")

    if len(pts) >= 2:
        gaps = [(pts[i]["t"] - pts[i - 1]["t"]) / 1000 for i in range(1, len(pts))]
        within2 = sum(1 for g in gaps if 1.5 <= g <= 2.5) / len(gaps) * 100
        within3 = sum(1 for g in gaps if g <= 3.5) / len(gaps) * 100
        big = sum(1 for g in gaps if g > 10)
        print(
            f"reporting: med={statistics.median(gaps):.2f}s mean={statistics.mean(gaps):.2f}s "
            f"max={max(gaps):.1f}s"
        )
        print(f"gaps 1.5-2.5s: {within2:.0f}%   at most 3.5s: {within3:.0f}%   over 10s: {big}")

        speeds = [x["speed"] for x in pts if x.get("speed") is not None and x["speed"] >= 0.25]
        seg = []
        for i in range(1, len(pts)):
            dt = (pts[i]["t"] - pts[i - 1]["t"]) / 1000
            if dt <= 0 or dt > 15:
                continue
            d = hav(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
            if d < 1:
                continue
            seg.append(d / dt)

        recent = pts[-60:] if len(pts) >= 60 else pts
        path_recent = None
        dist = 0.0
        span = 0.0
        if len(recent) >= 2:
            dist = sum(
                hav(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"])
                for i in range(1, len(recent))
            )
            span = (recent[-1]["t"] - recent[0]["t"]) / 1000
            path_recent = dist / span if span > 0 else None

        if speeds:
            print(
                f"phone speed field: avg={statistics.mean(speeds):.2f} ({split500(statistics.mean(speeds))}/500) "
                f"last={speeds[-1]:.2f} min={min(speeds):.2f} max={max(speeds):.2f}"
            )
        if seg:
            print(
                f"segment (pos/dt):  avg={statistics.mean(seg):.2f} ({split500(statistics.mean(seg))}/500) "
                f"last={seg[-1]:.2f}"
            )
        if path_recent:
            print(
                f"path last {len(recent)} fixes ({span:.0f}s): {path_recent:.2f} m/s "
                f"({split500(path_recent)}/500) over {dist:.0f}m"
            )

        mism = []
        for i in range(1, min(len(pts), 80)):
            dt = (pts[i]["t"] - pts[i - 1]["t"]) / 1000
            if dt <= 0 or dt > 15:
                continue
            d = hav(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
            if d < 1:
                continue
            segv = d / dt
            raw = pts[i].get("speed")
            if raw and raw >= 0.25:
                mism.append(abs(raw - segv) / segv * 100)
        if mism:
            print(
                f"raw vs segment error (recent segs): avg={statistics.mean(mism):.0f}% "
                f"med={statistics.median(mism):.0f}% max={max(mism):.0f}%"
            )

        accs = [x.get("accuracy") or x.get("acc") for x in pts if (x.get("accuracy") or x.get("acc"))]
        if accs:
            accs_sorted = sorted(accs)
            p95 = accs_sorted[int(len(accs_sorted) * 0.95)]
            print(f"GPS accuracy: med={statistics.median(accs):.1f}m p95={p95:.1f}m")

    print("\n=== Other online boats ===")
    for x in sorted(mp.get("positions", []), key=lambda z: z.get("deviceId", "")):
        if not x.get("online"):
            continue
        s = x.get("speed")
        ps = x.get("pathSpeedMps")
        pace = split500(ps or s)
        sid = x.get("deviceId")
        sr = x.get("strokeRate")
        seen = x.get("lastSeenAgoSec")
        raw_s = f"{s:.2f}" if s else "—"
        path_s = f"{ps:.2f}" if ps else "—"
        print(f"  {sid}: raw={raw_s} path={path_s} ({pace}/500) stroke={sr} seen={seen}s")


if __name__ == "__main__":
    main()
