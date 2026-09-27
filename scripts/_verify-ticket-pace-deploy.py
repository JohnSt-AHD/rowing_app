#!/usr/bin/env python3
"""Verify deployed ticket pace: recentPathSpeedMps + displaySpeedMps vs ground."""
import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def split500(v):
    if v is None or v < 0.25:
        return None
    s = 500 / v
    return f"{int(s // 60)}:{s % 60:04.1f}"


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat = math.radians(c - a)
    dlon = math.radians(d - b)
    x = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def ground_segment_median(device_id, minutes=15):
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get(
        "sessions"
    ) or []
    if not sess:
        return None
    sid = sess[0]["session_id"]
    track = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get(
        "track"
    ) or []
    now = int(datetime.now(AUCKLAND).timestamp() * 1000)
    gps = sorted(
        [p for p in track if p.get("lat") and p["t"] >= now - minutes * 60 * 1000],
        key=lambda x: x["t"],
    )
    segs = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        if not (1.5 <= dt <= 12):
            continue
        dist = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        if dist >= 1 and dt > 0:
            segs.append(dist / dt)
    if len(segs) < 3:
        return None
    return round(statistics.median(segs), 2)


def main():
    print(f"Deploy check @ {datetime.now(AUCKLAND).strftime('%H:%M:%S')} NZ\n")
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    positions = mp.get("positions") or []
    active = [p for p in positions if p.get("online")]
    active.sort(key=lambda x: x.get("deviceId", ""))

    if not active:
        print("No online devices on map.")
        return

    has_recent_field = False
    print(f"Online devices: {len(active)}\n")

    for p in active:
        did = p.get("deviceId")
        recent = p.get("recentPathSpeedMps")
        path = p.get("pathSpeedMps")
        disp = p.get("displaySpeedMps")
        if recent is not None:
            has_recent_field = True
        ground = ground_segment_median(did)

        print(f"--- {did} ---")
        print(
            f"  fixAge={p.get('fixAgeSec')}s acc={round(p.get('accuracy') or 0, 1)}m"
            f" stroke={p.get('displayStrokeRate') or p.get('strokeRate')}"
        )
        print(
            f"  recentPathSpeedMps: {recent} ({split500(recent)}/500)"
            if recent is not None
            else "  recentPathSpeedMps: MISSING (deploy not live?)"
        )
        print(f"  pathSpeedMps (30s): {path} ({split500(path)}/500)")
        print(f"  displaySpeedMps (ticket): {disp} ({split500(disp)}/500)")
        if ground:
            print(f"  ground segment med (15m): {ground} ({split500(ground)}/500)")
            if disp is not None:
                delta = disp - ground
                ok = abs(delta) <= 0.45
                print(
                    f"  ticket vs ground delta: {delta:+.2f} m/s"
                    f"  {'OK' if ok else 'still lagging/spiking'}"
                )
            if recent is not None and ground:
                dr = recent - ground
                print(f"  recent vs ground delta: {dr:+.2f} m/s")
        print()

    print("=" * 50)
    if has_recent_field:
        print("Deploy LIVE: recentPathSpeedMps present on API.")
    else:
        print("Deploy NOT visible yet: recentPathSpeedMps missing on all devices.")
        print("(Vercel may still be building, or cache warming.)")


if __name__ == "__main__":
    main()
