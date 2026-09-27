#!/usr/bin/env python3
"""Quick live reporting check for W2- KL."""
import json
import math
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2- KL"
NZ = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
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


def pct(a, p):
    if not a:
        return None
    k = (len(a) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(a) - 1)
    return a[f] if f == c else a[f] * (c - k) + a[c] * (k - f)


now = datetime.now(NZ)
print(f"=== {UID} live check {now.strftime('%Y-%m-%d %H:%M:%S')} NZ ===\n")

devs = get("/api/devices?windowSec=300&onlineSec=600&includeMetrics=1").get("devices") or []
d = next((x for x in devs if x.get("deviceId") == UID), None)
if not d:
    matches = [x.get("deviceId") for x in devs if "KL" in (x.get("deviceId") or "").upper()]
    print("Exact match not in devices. KL-like:", matches[:20])
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    pos_ids = [
        p.get("deviceId")
        for p in (mp.get("positions") or [])
        if "KL" in (p.get("deviceId") or "").upper() or "W2" in (p.get("deviceId") or "")
    ]
    print("Map KL/W2 ids:", pos_ids)
else:
    gps = (d.get("gps") or {}).get("last") or {}
    row = d.get("rowing") or {}
    meta = d.get("meta") or {}
    print("Devices API:")
    print(
        f"  lastSeenAgoSec={d.get('lastSeenAgoSec')} online={d.get('online')} "
        f"session={str(d.get('sessionId') or '')[:8]}"
    )
    print(
        f"  appVersion={d.get('appVersion') or d.get('version') or meta.get('appVersion')} "
        f"battery={d.get('battery') or (d.get('power') or {}).get('battery')}"
    )
    print(
        f"  GPS: lat={gps.get('lat')} lon={gps.get('lon')} "
        f"spd={gps.get('spd')} ({split500(gps.get('spd'))}) acc={gps.get('acc')}"
    )
    print(
        f"  strokeRate={row.get('strokeRate')} "
        f"economy={d.get('economyMode') or meta.get('economyMode')}"
    )

print("\n5 map polls (4s apart):")
for i in range(5):
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    dd = next(
        (
            x
            for x in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get(
                "devices", []
            )
            if x.get("deviceId") == UID
        ),
        None,
    )
    last = ((dd or {}).get("gps") or {}).get("last") or {}
    row = (dd or {}).get("rowing") or {}
    if not p and not dd:
        print(f"  [{i}] NOT FOUND")
    else:
        print(
            f"  [{i}] map spd={p.get('speed') if p else None} ({split500(p.get('speed') if p else None)}) "
            f"raw={last.get('spd')} ({split500(last.get('spd'))}) "
            f"stroke map={p.get('strokeRate') if p else None} dev={row.get('strokeRate')} "
            f"seen={dd.get('lastSeenAgoSec') if dd else None}s "
            f"stale={p.get('telemetryStale') if p else None} "
            f"fixAge={p.get('fixAgeSec') if p else None}s "
            f"src={p.get('sampleSource') or p.get('gpsSampleSource')}"
        )
    time.sleep(4)

enc = urllib.parse.quote(UID, safe="")
sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
print("\nSessions (latest 3):")
for s in sessions[:3]:
    started = s.get("started_at") or s.get("startedAt")
    ended = s.get("ended_at") or s.get("endedAt")
    print(
        f"  {str(s.get('session_id'))[:8]} started={started} ended={ended} "
        f"pts={s.get('point_count') or s.get('points')}"
    )

frm = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat().replace("+00:00", "Z")
to = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
track = get(
    f"/api/history?format=dashboard&uniqueId={enc}"
    f"&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
).get("track") or []
gps = sorted([p for p in track if p.get("lat") is not None and p.get("t")], key=lambda x: x["t"])
print(f"\nLast 15 min track: {len(track)} points, {len(gps)} with GPS")
if len(gps) >= 2:
    gaps = [(gps[i]["t"] - gps[i - 1]["t"]) / 1000 for i in range(1, len(gps))]
    dists = [
        haversine_m(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        for i in range(1, len(gps))
    ]
    big = [g for g in gaps if g >= 8]
    span = (gps[-1]["t"] - gps[0]["t"]) / 1000
    total = sum(dists)
    gs = sorted(gaps)
    print(
        f"  span={span:.0f}s path={total:.0f}m "
        f"path_spd={total / span if span else 0:.2f} m/s ({split500(total / span if span else None)})"
    )
    print(
        f"  GPS gaps: n={len(gaps)} med={pct(gs, 50):.1f}s "
        f"p90={pct(gs, 90):.1f}s max={max(gaps):.1f}s"
    )
    print(f"  gaps>=8s: {len(big)} (worst {max(gaps):.0f}s)")
    end_t = gps[-1]["t"]
    recent = [p for p in gps if p["t"] >= end_t - 120_000]
    if len(recent) >= 2:
        dist = sum(
            haversine_m(
                recent[i - 1]["lat"],
                recent[i - 1]["lon"],
                recent[i]["lat"],
                recent[i]["lon"],
            )
            for i in range(1, len(recent))
        )
        spanr = (recent[-1]["t"] - recent[0]["t"]) / 1000
        print(
            f"  Last ~120s: {len(recent)} fixes, {dist:.0f}m in {spanr:.0f}s -> "
            f"{dist / spanr:.2f} m/s ({split500(dist / spanr)})"
        )
    sources = Counter(
        (
            p.get("gpsSampleSource")
            or p.get("sampleSource")
            or p.get("gpsProvider")
            or "?"
        )
        for p in gps[-40:]
    )
    print(f"  recent sources: {dict(sources)}")
    age = (datetime.now(timezone.utc).timestamp() * 1000 - gps[-1]["t"]) / 1000
    print(
        f"  last GPS fix age: {age:.1f}s at "
        f"{datetime.fromtimestamp(gps[-1]['t'] / 1000, NZ).strftime('%H:%M:%S')} NZ"
    )
    print(
        f"  last lat/lon: {gps[-1].get('lat'):.6f},{gps[-1].get('lon'):.6f} "
        f"speed={gps[-1].get('speed')} stroke={gps[-1].get('strokeRate')}"
    )
elif gps:
    age = (datetime.now(timezone.utc).timestamp() * 1000 - gps[-1]["t"]) / 1000
    print(f"  only 1 GPS point, age={age:.1f}s")
else:
    print("  NO GPS in last 15 min")

if sessions:
    sid = sessions[0]["session_id"]
    dash = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}")
    tr = dash.get("track") or []
    print(f"\nLatest session {sid[:8]}: {len(tr)} track points total")
    # dump a few useful top-level keys
    for k in ("deviceId", "sessionId", "startedAt", "endedAt", "appVersion", "uniqueId"):
        if dash.get(k) is not None:
            print(f"  {k}={dash.get(k)}")
