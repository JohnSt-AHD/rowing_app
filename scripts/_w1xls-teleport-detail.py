#!/usr/bin/env python3
"""Correlate W1x LS teleports with accuracy and sample source."""
import json
import math
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


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def main():
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("W1x LS")).get("sessions") or []
    sid = sess[0]["session_id"]
    track = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get("track") or []
    gps = sorted([p for p in track if p.get("lat")], key=lambda x: x["t"])

    bad_acc = [p for p in gps if (p.get("acc") or 0) > 50]
    print(f"W1x LS today: {len(gps)} fixes, acc>50m: {len(bad_acc)} ({100*len(bad_acc)/len(gps):.1f}%)")

    tele = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        if dt <= 5 and dist > 30:
            ts = datetime.fromtimestamp(gps[i]["t"] / 1000, tz=AUCKLAND).strftime("%H:%M:%S")
            tele.append((dist, gps[i].get("acc"), gps[i - 1].get("acc"), ts))

    print(f"Teleports (>30m/5s): {len(tele)}")
    print("Worst 8:")
    for dist, acc, pacc, ts in sorted(tele, reverse=True)[:8]:
        print(f"  {ts} jump={dist:.0f}m acc={acc} prev_acc={pacc}")

    # duplicate streaks
    streak = 0
    max_streak = 0
    for i in range(1, len(gps)):
        dist = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        if dist < 0.5:
            streak += 1
            max_streak = max(max_streak, streak)
        else:
            streak = 0
    print(f"Max duplicate coord streak: {max_streak} fixes (~{max_streak}s at 1Hz)")


if __name__ == "__main__":
    main()
