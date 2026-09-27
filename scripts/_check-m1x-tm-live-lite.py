#!/usr/bin/env python3
import json
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICE = "M1x TM"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def gap_stats(ts_ms):
    ts = sorted(t for t in ts_ms if t)
    if len(ts) < 2:
        return None
    gaps = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
    gs = sorted(gaps)
    dur = (ts[-1] - ts[0]) / 1000
    return {
        "n": len(ts),
        "dur_sec": round(dur, 1),
        "median_gap": round(statistics.median(gaps), 2),
        "p95_gap": round(gs[int(0.95 * (len(gs) - 1))], 2),
        "max_gap": round(max(gaps), 2),
        "hz": round(len(ts) / dur, 3) if dur else 0,
        "gaps_le_1_5s": sum(1 for g in gaps if g <= 1.5),
        "gaps_1_5_to_4s": sum(1 for g in gaps if 1.5 < g <= 4.0),
        "gaps_gt_4s": sum(1 for g in gaps if g > 4.0),
    }


now = datetime.now(timezone.utc)
print("UTC now", now.isoformat())

# map-positions (lighter than listDevices)
try:
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
    print("\nMAP", json.dumps(pos, indent=2, default=str) if pos else "missing")
except Exception as e:
    print("MAP ERR", e)

# sessions
try:
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(DEVICE))
    sessions = sess.get("sessions") or []
    print("\nSESSIONS", len(sessions))
    if sessions:
        s0 = sessions[0]
        print(" latest", s0)
        sid = s0["session_id"]
        dash = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
        track = dash.get("track") or []
        gps = [p for p in track if p.get("lat") is not None]
        print(" track samples", len(track), "gps", len(gps))
        if len(track) >= 2:
            print(" all-sample gaps", gap_stats([p["t"] for p in track[-120:]]))
        if len(gps) >= 2:
            print(" gps gaps tail120", gap_stats([p["t"] for p in gps[-120:]]))
        print(" tail gps/fix:")
        for p in gps[-8:]:
            attrs = p.get("attributes") or {}
            print(
                " ",
                datetime.fromtimestamp(p["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S"),
                "uploadLag",
                attrs.get("uploadLagSec"),
                "fixAge",
                attrs.get("gpsFixAgeSec"),
                "fixMs",
                attrs.get("gpsFixMs") or p.get("fixMs"),
                "source",
                attrs.get("gpsSampleSource"),
            )
except Exception as e:
    print("SESSION ERR", e)

# recent route 20m
frm = (now - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
to = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
try:
    route = get(
        "/api/history?uniqueId="
        + urllib.parse.quote(DEVICE)
        + "&from="
        + urllib.parse.quote(frm)
        + "&to="
        + urllib.parse.quote(to)
    )
    positions = route.get("positions") or []
    print("\nROUTE 20m points", len(positions))
    if positions:
        ts = [p["t"] for p in positions if p.get("t")]
        print(" route gaps", gap_stats(ts))
except Exception as e:
    print("ROUTE ERR", e)

# devices narrow
for w in [30, 60, 120]:
    try:
        d = get(f"/api/devices?windowSec={w}&onlineSec={w}")
        dev = next((x for x in d.get("devices", []) if x.get("deviceId") == DEVICE), None)
        print(f"\nDEVICES window={w}", "found" if dev else "missing")
        if dev:
            print(json.dumps({k: dev.get(k) for k in ["online", "lastSeenAgoSec", "ingestRateHz", "totalSamples", "sessionId", "gps", "derived", "rowing"]}, indent=2, default=str))
        break
    except Exception as e:
        print(f"DEVICES window={w} ERR", e)
