#!/usr/bin/env python3
"""Live reporting + speed accuracy for W2- KL and W2x EH."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
TARGETS = ["W2- KL", "W2x EH", "W2-KL", "W2 KL"]
AUCKLAND = timezone(timedelta(hours=12))


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


def split500(speed):
    if speed is None or speed < 0.25:
        return None
    sec = 500 / float(speed)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def resolve_device_ids():
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    positions = mp.get("positions") or []
    found = []
    for p in positions:
        did = p.get("deviceId") or ""
        upper = did.upper()
        if did in ("W2- KL", "W2x EH") or "W2" in upper and ("KL" in upper or "EH" in upper):
            if did not in [x[0] for x in found]:
                found.append((did, p))
    # prefer exact names
    ordered = []
    for name in ("W2- KL", "W2x EH"):
        match = next((p for did, p in found if did == name), None)
        if match:
            ordered.append((name, match))
    for did, p in found:
        if did not in [n for n, _ in ordered]:
            ordered.append((did, p))
    return ordered, positions


def analyze_track(device_id, minutes=45):
    sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get(
        "sessions"
    ) or []
    if not sessions:
        return None
    s0 = sessions[0]
    sid = s0["session_id"]
    dash = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    track = dash.get("track") or []
    now_ms = int(datetime.now(AUCKLAND).timestamp() * 1000)
    cutoff = now_ms - minutes * 60 * 1000
    gps = sorted(
        [p for p in track if p.get("lat") is not None and p.get("t", 0) >= cutoff],
        key=lambda x: x["t"],
    )
    if len(gps) < 2:
        return {"session_id": sid[:8], "gps_points": len(gps), "active": s0.get("ended_at") is None}

    segs = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = haversine_m(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        if dt > 0:
            segs.append({"dt": dt, "dist": dist, "spd": dist / dt})

    gaps = [s["dt"] for s in segs]
    gs = sorted(gaps)
    normal = [s for s in segs if 2 <= s["dt"] <= 5 and s["dist"] >= 1]
    span = (gps[-1]["t"] - gps[0]["t"]) / 1000
    total_dist = sum(s["dist"] for s in segs)
    big_gaps = [s for s in segs if s["dt"] >= 8]

    has_fix_ms = sum(1 for p in gps if p.get("fixMs") or (p.get("attributes") or {}).get("gpsFixMs"))
    has_debug = any(p.get("gpsSampleSource") or p.get("gpsProvider") for p in gps)

    return {
        "session_id": sid[:8],
        "active": s0.get("ended_at") is None,
        "started": s0.get("started_at"),
        "sample_count": s0.get("sample_count"),
        "gps_points": len(gps),
        "span_min": round(span / 60, 1),
        "median_gap_s": round(statistics.median(gaps), 2),
        "p95_gap_s": round(gs[int(0.95 * (len(gs) - 1))], 2),
        "max_gap_s": round(max(gaps), 1),
        "gaps_ge_8s": len(big_gaps),
        "gaps_ge_10s": sum(1 for g in gaps if g >= 10),
        "micro_bursts_lt_0_75s": sum(1 for g in gaps if g < 0.75),
        "segment_median_mps": round(statistics.median([s["spd"] for s in normal]), 2) if normal else None,
        "path_mps": round(total_dist / span, 2) if span > 0 else None,
        "accuracy_m_med": round(statistics.median([p["acc"] for p in gps if p.get("acc") is not None]), 1)
        if any(p.get("acc") is not None for p in gps)
        else None,
        "has_fix_ms": has_fix_ms,
        "has_debug_fields": has_debug,
        "big_gaps_tail": [
            {
                "gap_s": round(s["dt"], 1),
                "dist_m": round(s["dist"], 1),
                "implied_mps": round(s["spd"], 2),
            }
            for s in sorted(big_gaps, key=lambda x: x["dt"], reverse=True)[:5]
        ],
    }


def watch_fix_age(device_id, polls=20, interval_s=3):
    ages = []
    jumps = []
    prev = None
    spikes = []
    for i in range(polls):
        mp = get("/api/map-positions?onlineSec=600&staleSec=7200")
        pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == device_id), None)
        if not pos:
            break
        fa = pos.get("fixAgeSec")
        ages.append(fa)
        if prev:
            d = haversine_m(prev["latitude"], prev["longitude"], pos["latitude"], pos["longitude"])
            jumps.append(d)
            if (fa or 0) >= 8 or d > 25:
                spikes.append(
                    {
                        "i": i,
                        "fixAge": fa,
                        "jump_m": round(d, 1),
                        "display": round(pos.get("displaySpeedMps") or 0, 2),
                        "path": round(pos.get("pathSpeedMps") or 0, 2),
                    }
                )
        prev = pos
        time.sleep(interval_s)
    return {
        "fixAge_min": min(ages) if ages else None,
        "fixAge_med": round(statistics.median(ages), 1) if ages else None,
        "fixAge_max": max(ages) if ages else None,
        "fixAge_ge_8": sum(1 for a in ages if (a or 0) >= 8),
        "fixAge_ge_10": sum(1 for a in ages if (a or 0) >= 10),
        "poll_jump_med_m": round(statistics.median(jumps), 1) if jumps else None,
        "poll_jump_max_m": round(max(jumps), 1) if jumps else None,
        "spikes": spikes,
    }


def print_device(name, pos):
    legacy = pos.get("gpsProvider") is None and pos.get("gpsSampleSource") is None
    app = "legacy APK" if legacy and pos.get("gpsFixMs") is None else "debug/newer APK"
    print(f"\n{'='*60}")
    print(f"  {name}  [{app}]")
    print(f"{'='*60}")
    print(
        f" online={pos.get('online')} lastSeen={pos.get('lastSeenAgoSec')}s"
        f" fixAge={pos.get('fixAgeSec')}s displayAge={pos.get('displayFixAgeSec')}s"
    )
    print(
        f" gpsFixAge={pos.get('gpsFixAgeSec')} uploadLag={pos.get('uploadLagSec')}"
        f" acc={round(pos.get('accuracy') or 0, 1)}m"
    )
    disp = pos.get("displaySpeedMps")
    path = pos.get("pathSpeedMps")
    raw = pos.get("speed")
    print(
        f" speed ticket(display)={disp} ({split500(disp)}/500)"
        f" path30s={path} ({split500(path)}/500)"
        f" speedField={raw}"
    )
    print(
        f" stroke={pos.get('displayStrokeRate') or pos.get('strokeRate')}"
        f" capsize={pos.get('capsize')} stale={pos.get('telemetryStale')}"
    )
    print(
        f" lat={round(pos.get('latitude', 0), 5)} lon={round(pos.get('longitude', 0), 5)}"
        f" provider={pos.get('gpsProvider')} source={pos.get('gpsSampleSource')}"
    )

    hist = analyze_track(name, minutes=45)
    if hist:
        print("\n Session track (last 45m):")
        for k, v in hist.items():
            if k != "big_gaps_tail":
                print(f"  {k}: {v}")
        if hist.get("big_gaps_tail"):
            print("  worst gaps:")
            for g in hist["big_gaps_tail"]:
                print(f"    {g}")

    print("\n Live fixAge watch (~60s)...")
    watch = watch_fix_age(name, polls=20, interval_s=3)
    for k, v in watch.items():
        if k != "spikes":
            print(f"  {k}: {v}")
    if watch.get("spikes"):
        print("  notable poll spikes:")
        for s in watch["spikes"]:
            print(f"    {s}")

    # Speed sanity: compare display vs segment median
    if hist and hist.get("segment_median_mps") and disp is not None:
        diff = disp - hist["segment_median_mps"]
        print(
            f"\n Speed check: display vs 45m segment median"
            f" delta={diff:+.2f} m/s ({split500(abs(diff))} per 500m pace units)"
        )
        if abs(diff) > 0.8:
            print("  => display pace differs noticeably from ground-track (EMA lag or recent speed change)")


def main():
    print(f"Check at {datetime.now(AUCKLAND).strftime('%Y-%m-%d %H:%M:%S')} NZ")
    devices, all_pos = resolve_device_ids()
    if not devices:
        print("No W2 KL / W2x EH on map. All device IDs:")
        for p in sorted(all_pos, key=lambda x: x.get("deviceId", "")):
            print(" ", p.get("deviceId"), "online=", p.get("online"), "lastSeen=", p.get("lastSeenAgoSec"))
        return

    for name, pos in devices:
        if name == "W2x EH" or "EH" in name:
            print_device(name, pos)
        elif "KL" in name.upper():
            print_device(name, pos)

    # Ensure both targets covered
    seen = {n for n, _ in devices}
    for want in ("W2- KL", "W2x EH"):
        if want not in seen:
            print(f"\n*** {want} not found on map ***")
            # fuzzy search sessions
            sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(want))
            sessions = sess.get("sessions") or []
            print(f"  sessions in DB: {len(sessions)}")
            if sessions:
                print(f"  latest: {sessions[0]}")


if __name__ == "__main__":
    main()
