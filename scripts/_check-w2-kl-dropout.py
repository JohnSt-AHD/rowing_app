#!/usr/bin/env python3
"""Check W2- KL for recent reporting dropouts."""
import json
import statistics
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
UID = "W2- KL"
NZ = timezone(timedelta(hours=12))


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=120) as r:
        return json.load(r)


def fmt_ts(ms):
    return datetime.fromtimestamp(ms / 1000, NZ).strftime("%H:%M:%S")


now = datetime.now(NZ)
print(f"=== W2- KL dropout check @ {now.strftime('%Y-%m-%d %H:%M:%S')} NZ ===\n")

# Live snapshot
dev = next(
    (x for x in get("/api/devices?windowSec=900&onlineSec=3600&includeMetrics=1").get("devices", []) if x.get("deviceId") == UID),
    None,
)
mp = next(
    (x for x in get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing").get("positions", []) if x.get("deviceId") == UID),
    None,
)

if dev:
    g = dev.get("gps") or {}
    last = g.get("last") or {}
    print("--- Live devices ---")
    print(f"  online={dev.get('online')} lastSeenAgo={dev.get('lastSeenAgoSec')}s ingestHz={dev.get('ingestRateHz')}")
    print(f"  gps rateHz={g.get('rateHz')} ageSec={g.get('ageSec')} displayAgeSec={g.get('displayAgeSec')}")
    if last.get("t"):
        print(f"  last fix: {fmt_ts(last['t'])} lat={last.get('lat')} lon={last.get('lon')} spd={last.get('spd')}")
else:
    print("NOT on /api/devices")

if mp:
    print("\n--- Live map ---")
    print(
        f"  online={mp.get('online')} lastSeen={mp.get('lastSeenAgoSec')}s "
        f"fixAge={mp.get('fixAgeSec')}s stale={mp.get('telemetryStale')}"
    )
    print(
        f"  speed={mp.get('displaySpeedMps')} stroke={mp.get('displayStrokeRate')} "
        f"acc={mp.get('accuracy')} capsize={mp.get('capsize')}"
    )
    print(f"  lat={mp.get('latitude')} lon={mp.get('longitude')} source={mp.get('gpsSampleSource')}")
else:
    print("\nNOT on map-positions")

# Current session
sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(UID)).get("sessions") or []
if not sessions:
    print("\nNo sessions found")
    raise SystemExit(0)

meta = sessions[0]
sid = meta["session_id"]
st = datetime.fromisoformat(meta["started_at"].replace("Z", "+00:00")).astimezone(NZ)
en = meta.get("ended_at")
end = datetime.fromisoformat(en.replace("Z", "+00:00")).astimezone(NZ) if en else None
print(f"\n--- Session {sid[:8]} ---")
print(f"  started {st}  {'OPEN' if not end else 'ended ' + end.strftime('%H:%M:%S')}")
print(f"  samples={meta.get('sample_count')}")

tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get("track") or []
all_pts = sorted(tr, key=lambda p: p.get("t") or 0)
gps = [p for p in all_pts if p.get("lat") is not None]

# Last 20 minutes focus
cutoff_ms = int((now - timedelta(minutes=25)).timestamp() * 1000)
recent_gps = [p for p in gps if p.get("t", 0) >= cutoff_ms]
recent_all = [p for p in all_pts if p.get("t", 0) >= cutoff_ms]

print(f"\n--- Last 25 min ---")
print(f"  track points={len(recent_all)}  with GPS={len(recent_gps)}")

if len(recent_gps) > 1:
    gaps = []
    gap_rows = []
    for i in range(1, len(recent_gps)):
        dt = (recent_gps[i]["t"] - recent_gps[i - 1]["t"]) / 1000
        gaps.append(dt)
        if dt >= 8:
            gap_rows.append(
                {
                    "from": fmt_ts(recent_gps[i - 1]["t"]),
                    "to": fmt_ts(recent_gps[i]["t"]),
                    "gap_s": round(dt, 1),
                    "spd_before": recent_gps[i - 1].get("speed"),
                    "spd_after": recent_gps[i].get("speed"),
                    "src_after": recent_gps[i].get("gpsSampleSource"),
                }
            )
    steady = [g for g in gaps if g >= 0.75]
    print(f"  gps median gap={statistics.median(steady):.2f}s max={max(gaps):.1f}s")
    print(f"  gaps >=8s: {sum(1 for g in gaps if g >= 8)}  >=30s: {sum(1 for g in gaps if g >= 30)}  >=60s: {sum(1 for g in gaps if g >= 60)}")
    print(f"  gap distribution: {Counter(round(g, 0) for g in steady).most_common(8)}")
    if gap_rows:
        print("\n  Worst gaps (>=8s):")
        for r in sorted(gap_rows, key=lambda x: x["gap_s"], reverse=True)[:12]:
            print(
                f"    {r['from']} -> {r['to']}  gap={r['gap_s']}s  "
                f"spd {r['spd_before']}->{r['spd_after']} src={r['src_after']}"
            )

# Last 15 track points regardless of GPS
print("\n--- Last 15 track samples ---")
for p in all_pts[-15:]:
    has_gps = p.get("lat") is not None
    print(
        f"  {fmt_ts(p['t'])}  {'GPS' if has_gps else 'no-gps':6}  "
        f"spd={p.get('speed')} stroke={p.get('strokeRate')} "
        f"{'lat='+str(round(p['lat'],5)) if has_gps else ''}"
    )
