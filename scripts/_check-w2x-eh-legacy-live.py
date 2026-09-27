#!/usr/bin/env python3
import json
import math
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


def hav(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def pct(n, d):
    return f"{100 * n / d:.0f}%" if d else "n/a"


def main():
    mp = get("/api/map-positions?onlineSec=300&staleSec=7200&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
    print(f"=== LIVE MAP: {DEVICE} ===")
    if pos:
        fields = [
            "online", "lastSeenAgoSec", "ingestAgoSec", "gpsFixAgeSec", "uploadLagSec",
            "accuracy", "pathSpeedMps", "displaySpeedMps", "speed", "course", "compass",
            "strokeRate", "displayStrokeRate", "pathPaceWindowSec", "gpsProvider", "gpsSampleSource",
        ]
        for k in fields:
            v = pos.get(k)
            if v is not None:
                print(f"  {k}: {v}")
        legacy = pos.get("gpsProvider") is None and pos.get("gpsSampleSource") is None
        print(f"  app: {'LEGACY' if legacy else 'DEBUG'}")

    sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(DEVICE)).get("sessions") or []
    sid = sessions[0]["session_id"]
    hist = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))
    track = [p for p in hist.get("track", []) if p.get("lat") is not None]

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    for window_min in [5, 10, 30]:
        cutoff = now_ms - window_min * 60 * 1000
        recent = [p for p in track if p["t"] >= cutoff]
        if len(recent) < 2:
            print(f"\n=== LAST {window_min} MIN === insufficient data ({len(recent)} pts)")
            continue

        intervals = [(recent[i]["t"] - recent[i - 1]["t"]) / 1000 for i in range(1, len(recent))]
        # ignore gaps > 30s for interval stats (session pauses)
        tight = [x for x in intervals if x <= 30]
        accs = [p["acc"] for p in recent if p.get("acc") is not None]
        phone_spd = [p["speed"] for p in recent if p.get("speed") is not None and p["speed"] > 0]

        # path speed from coord deltas
        path_spds = []
        for i in range(1, len(recent)):
            dt = (recent[i]["t"] - recent[i - 1]["t"]) / 1000
            if dt <= 0 or dt > 30:
                continue
            d = hav(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"])
            if d >= 2:
                path_spds.append(d / dt)

        dist_total = 0
        for i in range(1, len(recent)):
            dt = (recent[i]["t"] - recent[i - 1]["t"]) / 1000
            if dt > 30:
                continue
            dist_total += hav(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"])

        print(f"\n=== LAST {window_min} MIN ({len(recent)} GPS points) ===")
        if tight:
            tight_sorted = sorted(tight)
            print(
                f"  interval (<=30s gaps): n={len(tight)} "
                f"min={min(tight):.1f}s med={tight_sorted[len(tight_sorted)//2]:.1f}s "
                f"max={max(tight):.1f}s"
            )
            buckets = Counter()
            for x in tight:
                if x <= 2.5:
                    buckets["~1-2s"] += 1
                elif x <= 5.5:
                    buckets["~3-5s"] += 1
                elif x <= 12:
                    buckets["~6-12s"] += 1
                elif x <= 35:
                    buckets["~13-35s"] += 1
                else:
                    buckets[">35s"] += 1
            print(f"  interval buckets: {dict(buckets)}")
        if accs:
            acc_sorted = sorted(accs)
            print(
                f"  accuracy: min={min(accs):.1f}m med={acc_sorted[len(acc_sorted)//2]:.1f}m "
                f"max={max(accs):.1f}m  >20m={sum(1 for a in accs if a>20)} ({pct(sum(1 for a in accs if a>20), len(accs))})"
            )
        if phone_spd:
            ps = sorted(phone_spd)
            print(
                f"  phone speed (stored): med={ps[len(ps)//2]:.2f} m/s max={max(phone_spd):.2f} m/s "
                f"({max(phone_spd)*1.94384:.1f} kt)"
            )
        if path_spds:
            ps = sorted(path_spds)
            print(
                f"  path speed (derived): med={ps[len(ps)//2]:.2f} m/s max={max(path_spds):.2f} m/s "
                f"({ps[len(ps)//2]*2:.1f}s/500m pace est)"
            )
        print(f"  distance moved: {dist_total:.0f}m")

    print("\n=== LAST 8 GPS POINTS ===")
    for p in track[-8:]:
        ts = datetime.fromtimestamp(p["t"] / 1000, tz=timezone.utc).strftime("%H:%M:%S")
        print(
            f"  {ts} acc={p.get('acc')} phoneSpd={p.get('speed')} "
            f"lat={p.get('lat'):.6f} lon={p.get('lon'):.6f}"
        )


if __name__ == "__main__":
    main()
