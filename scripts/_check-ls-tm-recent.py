#!/usr/bin/env python3
"""Investigate LS vs TM recent reporting / distance."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
NZ = timezone(timedelta(hours=12))


def get(path):
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


def pct(a, p):
    if not a:
        return None
    k = (len(a) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(a) - 1)
    return a[f] if f == c else a[f] * (c - k) + a[c] * (k - f)


def analyze_track(track, label):
    gps = sorted(
        [p for p in track if p.get("lat") is not None and p.get("t")],
        key=lambda x: x["t"],
    )
    print(f"\n--- {label}: {len(track)} points, {len(gps)} with GPS ---")
    if len(gps) < 2:
        if gps:
            t = datetime.fromtimestamp(gps[0]["t"] / 1000, NZ)
            print(f"  only 1 GPS @ {t.strftime('%Y-%m-%d %H:%M:%S')} NZ")
        else:
            print("  NO GPS")
        return

    gaps = [(gps[i]["t"] - gps[i - 1]["t"]) / 1000 for i in range(1, len(gps))]
    dists = [
        haversine_m(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        for i in range(1, len(gps))
    ]
    span = (gps[-1]["t"] - gps[0]["t"]) / 1000
    total = sum(dists)
    gs = sorted(gaps)
    big = [g for g in gaps if g >= 8]
    print(
        f"  span={span/60:.1f} min  path={total:.0f}m  "
        f"start={datetime.fromtimestamp(gps[0]['t']/1000, NZ).strftime('%H:%M:%S')} "
        f"end={datetime.fromtimestamp(gps[-1]['t']/1000, NZ).strftime('%H:%M:%S')} NZ"
    )
    print(
        f"  gaps: n={len(gaps)} med={pct(gs,50):.1f}s p90={pct(gs,90):.1f}s max={max(gaps):.0f}s  gaps>=8s={len(big)}"
    )
    print(f"  first lat/lon={gps[0]['lat']:.6f},{gps[0]['lon']:.6f}")
    print(f"  last  lat/lon={gps[-1]['lat']:.6f},{gps[-1]['lon']:.6f}")
    speeds = [p.get("speed") for p in gps if p.get("speed") is not None]
    strokes = [p.get("strokeRate") for p in gps if p.get("strokeRate") is not None]
    if speeds:
        print(f"  speed samples={len(speeds)} last10={[round(x,2) for x in speeds[-10:]]}")
    if strokes:
        print(f"  stroke samples={len(strokes)} last10={strokes[-10:]}")
    # motion-only count
    motion = [p for p in track if p.get("lat") is None]
    print(f"  non-GPS samples in track: {len(motion)}")


def main():
    now = datetime.now(NZ)
    print(f"=== LS / TM check {now.strftime('%Y-%m-%d %H:%M:%S')} NZ ===\n")

    # Live devices
    try:
        devs = get("/api/devices?windowSec=172800&onlineSec=172800&includeMetrics=1").get(
            "devices"
        ) or []
    except Exception as e:
        print("devices API failed:", e)
        devs = []

    candidates = []
    print("Live/recent devices (LS/TM/W1/M1):")
    for d in devs:
        did = d.get("deviceId") or ""
        up = did.upper()
        if any(x in up for x in ("LS", "TM", "W1", "M1")):
            print(
                f"  {did!r} online={d.get('online')} lastSeen={d.get('lastSeenAgoSec')}s "
                f"session={str(d.get('sessionId') or '')[:8]}"
            )
            candidates.append(did)

    # History device list
    hist = get("/api/history?list=devices")
    hdevs = hist.get("devices") or []
    print(f"\nHistory devices total={len(hdevs)}")
    for d in hdevs:
        uid = d.get("uniqueId") or d.get("unique_id") or d.get("name") or ""
        up = str(uid).upper()
        if any(x in up for x in ("LS", "TM")):
            print(
                f"  {uid!r} samples={d.get('sampleCount') or d.get('point_count') or d.get('count')} "
                f"from={d.get('firstSampleAt') or d.get('min_t') or d.get('firstSeen')} "
                f"to={d.get('lastSampleAt') or d.get('max_t') or d.get('lastSeen')}"
            )
            if uid not in candidates:
                candidates.append(uid)

    # Prefer exact-ish matches
    targets = []
    for c in candidates:
        cu = c.upper()
        if "LS" in cu or "TM" in cu:
            targets.append(c)
    if not targets:
        targets = candidates

    print(f"\nTargets: {targets}")

    for uid in targets:
        enc = urllib.parse.quote(uid, safe="")
        print(f"\n========== {uid} ==========")
        sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
        print(f"Sessions ({len(sessions)} listed, showing up to 8):")
        for s in sessions[:8]:
            sid = str(s.get("session_id") or s.get("sessionId") or "")
            started = s.get("started_at") or s.get("startedAt")
            ended = s.get("ended_at") or s.get("endedAt")
            print(f"  {sid[:8]} started={started} ended={ended} pts={s.get('point_count') or s.get('points')}")

        # Last 2 NZ calendar days
        for day_offset in (0, 1, 2):
            day = (now - timedelta(days=day_offset)).date()
            start_local = datetime(day.year, day.month, day.day, 0, 0, 0, tzinfo=NZ)
            end_local = start_local + timedelta(days=1)
            frm = start_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            to = end_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            dash = get(
                f"/api/history?format=dashboard&uniqueId={enc}"
                f"&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
            )
            track = dash.get("track") or []
            analyze_track(track, f"{uid} NZ day {day.isoformat()}")

        # Latest session detail if any
        if sessions:
            sid = sessions[0].get("session_id") or sessions[0].get("sessionId")
            if sid:
                dash = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}")
                track = dash.get("track") or []
                analyze_track(track, f"{uid} latest session {str(sid)[:8]}")
                # sample keys from a few points
                for p in (track[:1] + track[-1:]):
                    print(f"  sample keys: {sorted(p.keys())}")


if __name__ == "__main__":
    main()
