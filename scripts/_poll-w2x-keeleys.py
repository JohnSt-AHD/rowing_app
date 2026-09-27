#!/usr/bin/env python3
import json
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
DEVICE = "W2x EH"


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=90) as r:
        return json.load(r)


def recent_stats(minutes=3):
    sid = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(DEVICE))["sessions"][0]["session_id"]
    track = [
        p
        for p in get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get("track", [])
        if p.get("lat")
    ]
    now = int(datetime.now(timezone.utc).timestamp() * 1000)
    recent = [p for p in track if p["t"] >= now - minutes * 60 * 1000]
    iv = [(recent[i]["t"] - recent[i - 1]["t"]) / 1000 for i in range(1, len(recent))]
    tight = [x for x in iv if x <= 60]
    buckets = Counter()
    for x in tight:
        if x <= 5:
            buckets["4-5s"] += 1
        elif x <= 15:
            buckets["6-15s"] += 1
        elif x <= 35:
            buckets["16-35s"] += 1
        else:
            buckets[">35s"] += 1
    med = sorted(tight)[len(tight) // 2] if tight else None
    return recent, med, dict(buckets)


for i in range(3):
    mp = get("/api/map-positions?onlineSec=300&staleSec=7200")
    p = next(x for x in mp["positions"] if x["deviceId"] == DEVICE)
    recent, med, buckets = recent_stats(3)
    print(f"--- poll {i + 1} @ {datetime.now(timezone.utc).strftime('%H:%M:%S')} UTC ---")
    print(f"  lastSeen={p.get('lastSeenAgoSec')}s speed={p.get('displaySpeedMps')}")
    print(f"  last 3min: {len(recent)} pts med={med}s buckets={buckets}")
    for pt in recent[-5:]:
        ts = datetime.fromtimestamp(pt["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        print(f"    {ts}")
    if i < 2:
        time.sleep(25)
