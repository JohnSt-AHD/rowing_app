#!/usr/bin/env python3
"""W1x LS Aug 3 — Keeleys geofence entry vs reporting quality."""
import json
import math
import statistics
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
NZ = timezone(timedelta(hours=12))
DEVICE = "W1x LS"
TODAY = datetime.now(NZ).date()
START = int(datetime(TODAY.year, TODAY.month, TODAY.day, tzinfo=NZ).astimezone(timezone.utc).timestamp() * 1000)
END = START + 86400000


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=120) as r:
        return json.load(r)


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def in_poly(lat, lon, ring):
    x, y = lon, lat
    inside = False
    n = len(ring)
    for i in range(n):
        y1, x1 = ring[i][0], ring[i][1]
        y2, x2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if ((y1 > y) != (y2 > y)) and (x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-15) + x1):
            inside = not inside
    return inside


def in_g(lat, lon, g):
    if g.get("shapeType", "circle") == "polygon":
        ring = g.get("polygonCoords") or []
        return len(ring) >= 3 and in_poly(lat, lon, ring)
    return hav(lat, lon, float(g["centerLat"]), float(g["centerLon"])) <= float(g["radiusM"])


def stats(track, label):
    if len(track) < 2:
        return {"label": label, "pts": len(track)}
    gaps = []
    dists = []
    tele = 0
    for i in range(1, len(track)):
        dt = (track[i]["t"] - track[i - 1]["t"]) / 1000
        dist = hav(track[i - 1]["lat"], track[i - 1]["lon"], track[i]["lat"], track[i]["lon"])
        gaps.append(dt)
        dists.append(dist)
        if dt <= 8 and dist > 35:
            tele += 1
    gs = sorted(gaps)
    buckets = Counter(
        "1-5s" if x <= 5 else "6-15s" if x <= 15 else "16-35s" if x <= 35 else ">35s"
        for x in gaps
        if 0 < x <= 120
    )
    accs = [p.get("acc") for p in track if p.get("acc") is not None]
    return {
        "label": label,
        "pts": len(track),
        "med_gap_s": round(statistics.median(gaps), 1),
        "dup_pct": round(100 * sum(1 for d in dists if d < 0.5) / len(dists), 1),
        "med_dist_m": round(statistics.median(dists), 1),
        "teleports_35m_8s": tele,
        "acc_med_m": round(statistics.median(accs), 1) if accs else None,
        "acc_gt50_pct": round(100 * sum(1 for a in accs if a > 50) / len(accs), 1) if accs else None,
        "buckets": dict(buckets),
    }


def main():
    keeleys = next(g for g in get("/api/geofences")["geofences"] if "keeley" in g["name"].lower())
    economy = float(keeleys.get("economyGpsIntervalSec") or keeleys.get("economyIntervalSec") or 10)
    print(f"Keeleys: economy={economy}s suppress={keeleys.get('suppressRecording')} autoStop={keeleys.get('autoStopOnEnter')}")

    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(DEVICE)).get("sessions") or []
    if not sess:
        print("No session")
        return
    sid = sess[0]["session_id"]
    track = sorted(
        [
            p
            for p in get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get("track", [])
            if p.get("lat") and START <= p["t"] < END
        ],
        key=lambda x: x["t"],
    )
    print(f"\n{DEVICE} Aug 3 ({TODAY}): {len(track)} GPS pts, session {sid[:8]}")
    if len(track) < 2:
        return

    flags = [in_g(p["lat"], p["lon"], keeleys) for p in track]
    inside = [p for p, f in zip(track, flags) if f]
    outside = [p for p, f in zip(track, flags) if not f]

    entries = []
    exits = []
    prev = False
    for p, ins in zip(track, flags):
        if ins and not prev:
            entries.append(p["t"])
        if prev and not ins:
            exits.append(p["t"])
        prev = ins

    print("Keeleys entries:", [datetime.fromtimestamp(t / 1000, tz=NZ).strftime("%H:%M:%S") for t in entries])
    print("Keeleys exits:", [datetime.fromtimestamp(t / 1000, tz=NZ).strftime("%H:%M:%S") for t in exits])
    print("\nOutside lake:", stats(outside, "outside"))
    print("Inside Keeleys:", stats(inside, "inside"))
    print("Full session:", stats(track, "full"))

    inside_med = stats(inside, "").get("med_gap_s")
    if inside_med is not None:
        ok = 8 <= inside_med <= 15
        print(f"\nEconomy switch to ~{economy}s: {'YES' if ok else 'NO'} (inside med interval {inside_med}s)")

    if entries:
        e = entries[0]
        before = [p for p in track if e - 10 * 60 * 1000 <= p["t"] < e]
        after = [
            p
            for p in track
            if e <= p["t"] < e + 20 * 60 * 1000 and in_g(p["lat"], p["lon"], keeleys)
        ]
        print("\n--- First Keeleys crossing ---")
        print("10 min BEFORE entry (on lake, 1Hz):", stats(before, "pre"))
        print("20 min INSIDE after entry:", stats(after, "inside-after"))


if __name__ == "__main__":
    main()
