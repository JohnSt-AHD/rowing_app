#!/usr/bin/env python3
"""Today's on-water slice from long-running sessions — M1x TM & W2x EH."""
import json
import math
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
DEVICES = ["M1x TM", "W2x EH"]
# Jul 27 2026 NZ (UTC+12): 2026-07-26 12:00 UTC .. 2026-07-27 12:00 UTC
TODAY_START_MS = int(datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)
TODAY_END_MS = int(datetime(2026, 7, 27, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=120) as r:
        return json.load(r)


def hav(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def point_in_polygon(lat, lon, ring):
    x, y = lon, lat
    inside = False
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i][0], ring[i][1]
        y2, x2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1):
            inside = not inside
    return inside


def in_geofence(lat, lon, g):
    if g.get("shapeType", "circle") == "polygon":
        ring = g.get("polygonCoords") or []
        return len(ring) >= 3 and point_in_polygon(lat, lon, ring)
    return hav(lat, lon, float(g["centerLat"]), float(g["centerLon"])) <= float(g["radiusM"])


def fmt_utc(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def fmt_nz(ms):
    from datetime import timedelta
    nz = timezone(timedelta(hours=12))
    return datetime.fromtimestamp(ms / 1000, tz=nz).strftime("%H:%M NZ")


def interval_stats(track):
    if len(track) < 2:
        return None
    iv = [(track[i]["t"] - track[i - 1]["t"]) / 1000 for i in range(1, len(track))]
    tight = [x for x in iv if 0 < x <= 120]
    if not tight:
        return None
    s = sorted(tight)
    buckets = Counter()
    for x in tight:
        if x <= 5:
            buckets["1-5s"] += 1
        elif x <= 15:
            buckets["6-15s"] += 1
        elif x <= 35:
            buckets["16-35s"] += 1
        else:
            buckets[">35s"] += 1
    return {"med": round(s[len(s) // 2], 1), "min": round(min(tight), 1), "max": round(max(tight), 1), "buckets": dict(buckets)}


def path_speeds(track):
    spds = []
    dist = 0
    for i in range(1, len(track)):
        dt = (track[i]["t"] - track[i - 1]["t"]) / 1000
        if dt <= 0 or dt > 30:
            continue
        d = hav(track[i - 1]["lat"], track[i - 1]["lon"], track[i]["lat"], track[i]["lon"])
        dist += d
        if d >= 2:
            spds.append(d / dt)
    if not spds:
        return None, dist
    s = sorted(spds)
    return {"med": round(s[len(s) // 2], 2), "p90": round(s[int(len(s) * 0.9)], 2), "max": round(max(spds), 2)}, dist


def keeleys_report(track, keeleys):
    if not track:
        return "No GPS today"
    flags = [in_geofence(p["lat"], p["lon"], keeleys) for p in track]
    n_in = sum(flags)
    entries, exits = [], []
    prev = False
    for p, ins in zip(track, flags):
        if ins and not prev:
            entries.append(p["t"])
        if prev and not ins:
            exits.append(p["t"])
        prev = ins
    inside = [p for p, f in zip(track, flags) if f]
    outside = [p for p, f in zip(track, flags) if not f]
    ii = interval_stats(inside)
    io = interval_stats(outside)
    economy = ii and ii["med"] >= 8
    lines = [
        f"Inside Keeleys: {n_in}/{len(track)} pts ({round(100*n_in/len(track),1)}%)",
        f"Crossings: {len(entries)} entry, {len(exits)} exit",
    ]
    if entries:
        lines.append("  Entry times: " + ", ".join(fmt_nz(t) for t in entries))
    if exits:
        lines.append("  Exit times: " + ", ".join(fmt_nz(t) for t in exits))
    if ii:
        lines.append(f"  Intervals inside: med={ii['med']}s {ii['buckets']}")
    if io:
        lines.append(f"  Intervals outside: med={io['med']}s {io['buckets']}")
    if n_in > 0:
        lines.append("  Economy (~10s): " + ("YES" if economy else "NO — still ~4s inside zone"))
    else:
        lines.append("  Did not enter Keeleys today")
    return "\n".join(lines)


def analyze_device(device_id, keeleys):
    sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(device_id)).get("sessions") or []
    if not sessions:
        return None
    sid = sessions[0]["session_id"]
    meta = sessions[0]
    hist = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    all_track = [p for p in hist.get("track", []) if p.get("lat") is not None]
    track = [p for p in all_track if TODAY_START_MS <= p["t"] < TODAY_END_MS]

    if not track:
        return {"device": device_id, "error": "No GPS points in today window", "session": sid}

    legacy = not any(p.get("gpsProvider") or p.get("gpsSampleSource") for p in track)
    ist = interval_stats(track)
    accs = [p["acc"] for p in track if p.get("acc") is not None]
    ps, dist = path_speeds(track)
    phone = [p["speed"] for p in track if p.get("speed") and p["speed"] > 0]

    return {
        "device": device_id,
        "session": sid,
        "session_started": meta.get("started_at"),
        "legacy": legacy,
        "today_pts": len(track),
        "today_start": fmt_nz(track[0]["t"]),
        "today_end": fmt_nz(track[-1]["t"]),
        "intervals": ist,
        "accuracy": {
            "med": round(sorted(accs)[len(accs) // 2], 1) if accs else None,
            "max": round(max(accs), 1) if accs else None,
            "bad_pct": round(100 * sum(1 for a in accs if a > 20) / len(accs), 1) if accs else None,
        },
        "path_speed": ps,
        "distance_m": round(dist),
        "phone_speed_med": round(sorted(phone)[len(phone) // 2], 2) if phone else None,
        "keeleys": keeleys_report(track, keeleys),
    }


def main():
    keeleys = next(g for g in get("/api/geofences")["geofences"] if "keeley" in g["name"].lower())
    print(f"Today window: {fmt_utc(TODAY_START_MS)} -> {fmt_utc(TODAY_END_MS)}")
    print(f"Keeleys: economy {keeleys.get('economyGpsIntervalSec')}s\n")

    for did in DEVICES:
        r = analyze_device(did, keeleys)
        print("=" * 55)
        print(f"  {did}")
        print("=" * 55)
        if r is None:
            print("  No sessions\n")
            continue
        if r.get("error"):
            print(f"  {r['error']}\n")
            continue
        print(f"  Session {r['session'][:8]}… (started {r['session_started']})")
        print(f"  App: {'LEGACY' if r['legacy'] else 'DEBUG'}")
        print(f"  Today on water: {r['today_pts']} GPS pts, {r['today_start']} -> {r['today_end']}")
        print(f"  Distance today: ~{r['distance_m']/1000:.1f} km")
        i = r["intervals"]
        print(f"  Reporting: med={i['med']}s min={i['min']}s max={i['max']}s  {i['buckets']}")
        a = r["accuracy"]
        print(f"  Accuracy: med={a['med']}m max={a['max']}m bad(>20m)={a['bad_pct']}%")
        if r["path_speed"]:
            p = r["path_speed"]
            pace = 500 / p["med"] if p["med"] else 0
            print(f"  Path speed: med={p['med']} m/s p90={p['p90']} (~{pace:.0f}s/500m)")
        if r["phone_speed_med"]:
            print(f"  Phone speed (stored): med={r['phone_speed_med']} m/s")
        print(f"  Keeleys:\n    " + r["keeleys"].replace("\n", "\n    "))
        print()


if __name__ == "__main__":
    main()
