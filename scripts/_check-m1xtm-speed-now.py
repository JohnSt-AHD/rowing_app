#!/usr/bin/env python3
"""Live speed accuracy check for M1x TM on RowSafe / CrewSight path."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M1x TM"
NZ = timezone(timedelta(hours=12))
OVERLAY = "https://traccar-overlay.vercel.app"


def get(base, path, token=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, headers=headers)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(s):
    if s is None or s < 0.25:
        return "—"
    sec = 500 / float(s)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def main():
    now = datetime.now(NZ)
    print(f"=== {UID} speed accuracy {now.strftime('%Y-%m-%d %H:%M:%S')} NZ ===\n")

    print("5 live polls (4s apart):")
    polls = []
    for i in range(5):
        mp = get(
            BASE,
            "/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing",
            TOKEN,
        )
        p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
        d = next(
            (
                x
                for x in get(
                    BASE,
                    "/api/devices?windowSec=120&onlineSec=600&includeMetrics=1",
                    TOKEN,
                ).get("devices", [])
                if x.get("deviceId") == UID
            ),
            None,
        )
        last = ((d or {}).get("gps") or {}).get("last") or {}
        row = (d or {}).get("rowing") or {}
        # RowSafe overlay snapshot (source=rowing)
        try:
            snap = get(
                OVERLAY,
                "/api/traccar?action=snapshot&source=rowing",
            )
            # find device by name
            pos_by_id = {}
            for pos in snap.get("positions") or []:
                pos_by_id[pos.get("deviceId")] = pos
            overlay_p = None
            for dev in snap.get("devices") or []:
                name = dev.get("name") or dev.get("uniqueId") or ""
                if name == UID:
                    overlay_p = pos_by_id.get(dev.get("id"))
                    break
            if overlay_p is None:
                # try uniqueId match on attributes
                for pos in snap.get("positions") or []:
                    attrs = pos.get("attributes") or {}
                    if attrs.get("uniqueId") == UID or pos.get("deviceName") == UID:
                        overlay_p = pos
                        break
        except Exception as e:
            overlay_p = None
            snap_err = str(e)
        else:
            snap_err = None

        map_spd = p.get("speed") if p else None
        raw_spd = last.get("spd")
        disp = (p or {}).get("displaySpeedMps") or (p.get("attributes") or {}).get("displaySpeedMps") if p else None
        path_attr = (p or {}).get("pathSpeedMps")
        if path_attr is None and p:
            path_attr = (p.get("attributes") or {}).get("pathSpeedMps")
        ov_spd = None
        if overlay_p:
            ov_spd = overlay_p.get("speed")
            attrs = overlay_p.get("attributes") or {}
            if ov_spd is None:
                ov_spd = attrs.get("speed")
        print(
            f"  [{i}] map={map_spd} ({split500(map_spd)}) rawGPS={raw_spd} ({split500(raw_spd)}) "
            f"disp={disp} pathAttr={path_attr} "
            f"stroke={p.get('strokeRate') if p else None}/{row.get('strokeRate')} "
            f"seen={d.get('lastSeenAgoSec') if d else None}s stale={p.get('telemetryStale') if p else None} "
            f"fixAge={p.get('fixAgeSec') if p else None}s src={p.get('sampleSource') or p.get('gpsSampleSource')} "
            f"overlaySpd={ov_spd}"
            + (f" overlayErr={snap_err}" if snap_err else "")
        )
        polls.append(
            {
                "t": time.time(),
                "map": map_spd,
                "raw": raw_spd,
                "lat": p.get("latitude") if p else last.get("lat"),
                "lon": p.get("longitude") if p else last.get("lon"),
            }
        )
        time.sleep(4)

    # Path speed from poll positions
    path_pts = [x for x in polls if x.get("lat") is not None and x.get("lon") is not None]
    if len(path_pts) >= 2:
        dist = sum(
            haversine_m(
                path_pts[i - 1]["lat"],
                path_pts[i - 1]["lon"],
                path_pts[i]["lat"],
                path_pts[i]["lon"],
            )
            for i in range(1, len(path_pts))
        )
        span = path_pts[-1]["t"] - path_pts[0]["t"]
        path_spd = dist / span if span > 0 else None
        print(
            f"\nPoll path (~{span:.0f}s): {dist:.1f}m -> {path_spd:.2f} m/s ({split500(path_spd)})"
        )
        maps = [x["map"] for x in polls if x.get("map") is not None]
        raws = [x["raw"] for x in polls if x.get("raw") is not None]
        if maps:
            avg_map = sum(maps) / len(maps)
            print(f"  avg map reported: {avg_map:.2f} m/s ({split500(avg_map)})  delta vs path={(avg_map - path_spd):+.2f} m/s")
        if raws:
            avg_raw = sum(raws) / len(raws)
            print(f"  avg raw GPS:      {avg_raw:.2f} m/s ({split500(avg_raw)})  delta vs path={(avg_raw - path_spd):+.2f} m/s")

    # Last 8 minutes history path vs reported
    utc = datetime.now(timezone.utc)
    frm = (utc - timedelta(minutes=8)).isoformat().replace("+00:00", "Z")
    to = utc.isoformat().replace("+00:00", "Z")
    enc = urllib.parse.quote(UID, safe="")
    track = get(
        BASE,
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}",
        TOKEN,
    ).get("track") or []

    gps = sorted([p for p in track if p.get("lat") is not None and p.get("t")], key=lambda x: x["t"])
    speeds = [p["speed"] for p in track if p.get("speed") is not None]
    print(f"\nLast 8 min history: {len(track)} pts, {len(gps)} GPS, {len(speeds)} speed samples")
    if speeds:
        print(
            f"  reported speed min={min(speeds):.2f} max={max(speeds):.2f} avg={sum(speeds)/len(speeds):.2f} "
            f"({split500(sum(speeds)/len(speeds))})"
        )
        print(f"  last 12 reported: {[round(x, 2) for x in speeds[-12:]]}")

    if len(gps) >= 2:
        # overall
        dist = sum(
            haversine_m(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
            for i in range(1, len(gps))
        )
        span = (gps[-1]["t"] - gps[0]["t"]) / 1000
        print(
            f"  path overall: {dist:.0f}m in {span:.0f}s -> {dist/span:.2f} m/s ({split500(dist/span)})"
        )

        # last 120s
        end_t = gps[-1]["t"]
        recent = [p for p in gps if p["t"] >= end_t - 120_000]
        if len(recent) >= 2:
            dist2 = sum(
                haversine_m(
                    recent[i - 1]["lat"],
                    recent[i - 1]["lon"],
                    recent[i]["lat"],
                    recent[i]["lon"],
                )
                for i in range(1, len(recent))
            )
            span2 = (recent[-1]["t"] - recent[0]["t"]) / 1000
            path2 = dist2 / span2 if span2 > 0 else None
            # reported speeds in same window
            rep = [
                p["speed"]
                for p in recent
                if p.get("speed") is not None and p["speed"] >= 0.25
            ]
            avg_rep = sum(rep) / len(rep) if rep else None
            print(
                f"  last ~120s path: {len(recent)} fixes, {dist2:.0f}m in {span2:.0f}s -> "
                f"{path2:.2f} m/s ({split500(path2)})"
            )
            if avg_rep is not None:
                print(
                    f"  last ~120s avg reported (moving): {avg_rep:.2f} m/s ({split500(avg_rep)}) "
                    f"delta={(avg_rep - path2):+.2f} m/s ({(avg_rep/path2 - 1)*100:+.1f}%)"
                )

            # segment comparison for gaps 2-5s
            segs = []
            for i in range(1, len(recent)):
                dt = (recent[i]["t"] - recent[i - 1]["t"]) / 1000
                d = haversine_m(
                    recent[i - 1]["lat"],
                    recent[i - 1]["lon"],
                    recent[i]["lat"],
                    recent[i]["lon"],
                )
                if 1.5 <= dt <= 6 and d >= 0.5:
                    path_s = d / dt
                    rep_s = recent[i].get("speed")
                    segs.append((path_s, rep_s, dt, d))
            if segs:
                path_only = [s[0] for s in segs]
                both = [(s[0], s[1]) for s in segs if s[1] is not None and s[1] >= 0.25]
                print(
                    f"  segment path speeds (n={len(path_only)}): "
                    f"med={statistics.median(path_only):.2f} avg={statistics.mean(path_only):.2f}"
                )
                if both:
                    deltas = [r - p for p, r in both]
                    ratios = [r / p for p, r in both if p > 0.3]
                    print(
                        f"  reported vs path segments (n={len(both)}): "
                        f"mean delta={statistics.mean(deltas):+.2f} m/s "
                        f"med delta={statistics.median(deltas):+.2f} m/s"
                    )
                    if ratios:
                        print(
                            f"  reported/path ratio: mean={statistics.mean(ratios):.3f} med={statistics.median(ratios):.3f}"
                        )

        age = (datetime.now(timezone.utc).timestamp() * 1000 - gps[-1]["t"]) / 1000
        print(
            f"  last GPS age={age:.1f}s at {datetime.fromtimestamp(gps[-1]['t']/1000, NZ).strftime('%H:%M:%S')} NZ "
            f"speed={gps[-1].get('speed')} stroke={gps[-1].get('strokeRate')} "
            f"src={gps[-1].get('gpsSampleSource')}"
        )


if __name__ == "__main__":
    main()
