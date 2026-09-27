#!/usr/bin/env python3
"""Check M1x TM + W2x EH: new APK debug, reporting, speed."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICES = ["M1x TM", "W2x EH"]
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
    s = 500 / float(v)
    return f"{int(s // 60)}:{s % 60:04.1f}"


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    x = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def ground_median(track, minutes=15):
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
        if dist >= 1:
            segs.append(dist / dt)
    return round(statistics.median(segs), 2) if len(segs) >= 5 else None


def analyze_gaps(track, minutes=30):
    now = int(datetime.now(AUCKLAND).timestamp() * 1000)
    gps = sorted(
        [p for p in track if p.get("lat") and p["t"] >= now - minutes * 60 * 1000],
        key=lambda x: x["t"],
    )
    if len(gps) < 2:
        return {"fixes": len(gps)}
    gaps = [(gps[i]["t"] - gps[i - 1]["t"]) / 1000 for i in range(1, len(gps))]
    gs = sorted(gaps)
    return {
        "fixes": len(gps),
        "median_gap_s": round(statistics.median(gaps), 2),
        "p95_gap_s": round(gs[int(0.95 * (len(gs) - 1))], 2),
        "max_gap_s": round(max(gaps), 1),
        "ge_8s": sum(1 for g in gaps if g >= 8),
        "micro_lt_0_75s": sum(1 for g in gaps if g < 0.75),
    }


def debug_from_samples(samples):
    gps = [s for s in samples if s.get("gps")]
    with_fix = sum(1 for s in gps if (s.get("gps") or {}).get("fixMs"))
    sources = {}
    providers = {}
    in_park = sum(1 for s in samples if (s.get("derived") or {}).get("inBoatPark"))
    for s in gps[-30:]:
        g = s.get("gps") or {}
        src = g.get("sampleSource") or "none"
        prov = g.get("provider") or "none"
        sources[src] = sources.get(src, 0) + 1
        providers[prov] = providers.get(prov, 0) + 1
    return {
        "samples": len(samples),
        "gps": len(gps),
        "with_fixMs": with_fix,
        "inBoatPark_samples": in_park,
        "sources_tail30": sources,
        "providers_tail30": providers,
    }


def check_device(uid):
    print(f"\n{'='*64}\n  {uid}\n{'='*64}")
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == uid), None)
    if not pos:
        print("  NOT on map")
        return

    legacy = pos.get("gpsFixMs") is None and pos.get("gpsProvider") is None and pos.get("gpsSampleSource") is None
    print(f"  online={pos.get('online')} lastSeen={pos.get('lastSeenAgoSec')}s fixAge={pos.get('fixAgeSec')}s")
    print(f"  APK: {'LEGACY (no map debug)' if legacy else 'DEBUG fields on map'}")

    debug_map = {
        k: pos.get(k)
        for k in [
            "gpsFixMs",
            "gpsFixAgeSec",
            "uploadLagSec",
            "gpsProvider",
            "gpsSampleSource",
            "ingestAgoSec",
            "displayFixAgeSec",
            "fixAgeSec",
        ]
        if pos.get(k) is not None
    }
    print("  map debug:", json.dumps(debug_map, default=str) if debug_map else "none")

    print(
        f"  speed recent={split500(pos.get('recentPathSpeedMps'))}"
        f" path={split500(pos.get('pathSpeedMps'))}"
        f" ticket={split500(pos.get('displaySpeedMps'))}"
        f" acc={round(pos.get('accuracy') or 0, 1)}m stroke={pos.get('displayStrokeRate')}"
    )

    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(uid)).get("sessions") or []
    s0 = sess[0]
    sid = s0["session_id"]
    started = s0.get("started_at")
    print(f"  session {sid[:8]} started={started} samples={s0.get('sample_count')}")

    track = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get("track") or []
    gaps = analyze_gaps(track, 30)
    ground = ground_median(track, 15)
    print(f"  reporting (30m): {gaps}")
    if ground:
        disp = pos.get("displaySpeedMps")
        print(f"  ground 15m: {ground} m/s ({split500(ground)}/500)")
        if disp:
            print(f"  ticket vs ground: {disp - ground:+.2f} m/s")

    # ingest memory samples if any
    try:
        raw = get("/api/ingest?sessionId=" + urllib.parse.quote(sid))
        dbg = debug_from_samples(raw.get("samples") or [])
        print(f"  ingest (server memory): {dbg}")
        tail = [s for s in (raw.get("samples") or []) if s.get("gps")][-3:]
        for s in tail:
            g = s.get("gps") or {}
            lag = None
            if g.get("fixMs") and s.get("t"):
                lag = round((s["t"] - g["fixMs"]) / 1000, 1)
            print(
                f"    upload fixMs={g.get('fixMs')} lag={lag}s"
                f" src={g.get('sampleSource')} prov={g.get('provider')}"
                f" inPark={(s.get('derived') or {}).get('inBoatPark')}"
            )
    except Exception as e:
        print(f"  ingest: {e}")

    # fixMs in DB track attrs if present
    recent_gps = [p for p in track if p.get("lat")][-5:]
    fix_ms_track = sum(1 for p in recent_gps if p.get("fixMs") or (p.get("attributes") or {}).get("gpsFixMs"))
    print(f"  track tail fixMs present: {fix_ms_track}/5 recent GPS points")

    # poll fixAge 4x
    ages, fix_ages, lags = [], [], []
    prev = None
    for i in range(4):
        mp2 = get("/api/map-positions?onlineSec=600&staleSec=7200")
        p2 = next(x for x in mp2["positions"] if x["deviceId"] == uid)
        ages.append(p2.get("fixAgeSec"))
        if p2.get("gpsFixAgeSec") is not None:
            fix_ages.append(p2.get("gpsFixAgeSec"))
        if p2.get("uploadLagSec") is not None:
            lags.append(p2.get("uploadLagSec"))
        prev = p2
        time.sleep(3)
    print(
        f"  poll fixAge med={statistics.median(ages) if ages else None}s max={max(ages) if ages else None}"
        f" gpsFixAge={fix_ages or 'n/a'} uploadLag={lags or 'n/a'}"
    )


def main():
    print(f"Check @ {datetime.now(AUCKLAND).strftime('%Y-%m-%d %H:%M:%S')} NZ")
    for uid in DEVICES:
        check_device(uid)


if __name__ == "__main__":
    main()
