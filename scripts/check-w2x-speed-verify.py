#!/usr/bin/env python3
"""Compare RowSafe/map reported speed vs distance/time for a device."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"


def get(path: str):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def split500(speed):
    if speed is None or speed < 0.25:
        return None
    sec = 500 / float(speed)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def analyze_track(track, label, minutes=10):
    pts = [
        p
        for p in track
        if p.get("lat") is not None and p.get("lon") is not None and p.get("t") is not None
    ]
    if len(pts) < 2:
        print(f"{label}: not enough GPS points ({len(pts)})")
        return

    cutoff = pts[-1]["t"] - minutes * 60 * 1000
    pts = [p for p in pts if p["t"] >= cutoff]
    if len(pts) < 2:
        print(f"{label}: not enough points in last {minutes} min")
        return

    seg_speeds = []
    reported = []
    total_dist = 0.0
    for i in range(1, len(pts)):
        p0, p1 = pts[i - 1], pts[i]
        dt = (p1["t"] - p0["t"]) / 1000.0
        if dt <= 0:
            continue
        dist = haversine_m(p0["lat"], p0["lon"], p1["lat"], p1["lon"])
        total_dist += dist
        if dt >= 1.0 and dist >= 1.0:
            seg_speeds.append(dist / dt)
        s0, s1 = p0.get("speed"), p1.get("speed")
        if s1 is not None and s1 >= 0:
            reported.append(float(s1))

    span_s = (pts[-1]["t"] - pts[0]["t"]) / 1000.0
    path_speed = total_dist / span_s if span_s > 0 else None
    seg_avg = sum(seg_speeds) / len(seg_speeds) if seg_speeds else None
    rep_avg = sum(reported) / len(reported) if reported else None

    print(f"\n=== {label} (last {minutes} min) ===")
    print(f"points={len(pts)} span={span_s:.0f}s distance={total_dist:.0f}m")
    print(
        f"path speed (total dist / total time): {path_speed:.2f} m/s ({split500(path_speed)}/500)"
        if path_speed
        else "path speed: n/a"
    )
    if seg_speeds:
        print(
            f"segment avg ({len(seg_speeds)} legs, dist>=1m): {seg_avg:.2f} m/s ({split500(seg_avg)}/500) "
            f"min={min(seg_speeds):.2f} max={max(seg_speeds):.2f}"
        )
    if reported:
        print(
            f"reported speed avg ({len(reported)} samples): {rep_avg:.2f} m/s ({split500(rep_avg)}/500) "
            f"min={min(reported):.2f} max={max(reported):.2f}"
        )
    if seg_avg and rep_avg:
        diff = rep_avg - seg_avg
        pct = 100 * diff / seg_avg if seg_avg else 0
        print(f"reported vs segment avg: {diff:+.2f} m/s ({pct:+.1f}%)")
    if path_speed and rep_avg:
        diff = rep_avg - path_speed
        pct = 100 * diff / path_speed if path_speed else 0
        print(f"reported vs path speed: {diff:+.2f} m/s ({pct:+.1f}%)")

    print("last 5 samples: t, reported m/s, segment m/s")
    for i in range(max(1, len(pts) - 5), len(pts)):
        p = pts[i]
        seg = None
        if i > 0:
            p0 = pts[i - 1]
            dt = (p["t"] - p0["t"]) / 1000.0
            dist = haversine_m(p0["lat"], p0["lon"], p["lat"], p["lon"])
            if dt > 0:
                seg = dist / dt
        ts = datetime.fromtimestamp(p["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        seg_s = f"{seg:.2f}" if seg is not None else "—"
        print(
            f"  {ts} rep={p.get('speed')} seg={seg_s} "
            f"lat={p.get('lat'):.5f} lon={p.get('lon'):.5f}"
        )


def main():
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    pos = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    print("=== /api/map-positions (RowSafe live map source) ===")
    if not pos:
        print(f"{UID}: not on map")
    else:
        spd = pos.get("speed")
        print(
            f"{UID}: online={pos.get('online')} speed={spd} m/s ({split500(spd)}/500) "
            f"fixAge={pos.get('fixAgeSec')}s seen={pos.get('lastSeenAgoSec')}s "
            f"lat={pos.get('latitude')} lon={pos.get('longitude')}"
        )

    snap = get("/api/snapshot?onlineSec=600")
    dev = next((d for d in snap.get("devices", []) if d.get("uniqueId") == UID or d.get("name") == UID), None)
    sp = None
    if dev:
        sp = next((p for p in snap.get("positions", []) if p.get("deviceId") == dev.get("id")), None)
    print("\n=== /api/snapshot (Traccar overlay / RowSafe) ===")
    if sp:
        attrs = sp.get("attributes") or {}
        spd = sp.get("speed")
        print(
            f"{UID}: speed={spd} m/s ({split500(spd)}/500) "
            f"attrs.speed={attrs.get('speed')} stroke={attrs.get('strokeRate')}"
        )
    else:
        print(f"{UID}: not in snapshot")

    now = datetime.now(timezone.utc)
    for mins in (5, 10, 15):
        frm = (now - timedelta(minutes=mins)).isoformat().replace("+00:00", "Z")
        to = now.isoformat().replace("+00:00", "Z")
        enc = urllib.parse.quote(UID, safe="")
        data = get(
            f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
        )
        analyze_track(data.get("track") or [], f"history GPS ({mins} min window)", minutes=mins)


if __name__ == "__main__":
    main()
