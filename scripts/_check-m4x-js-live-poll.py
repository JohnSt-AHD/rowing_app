#!/usr/bin/env python3
"""Poll M4x JS live gaps + recent session."""
import json
import statistics
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
UID = "M4x JS"
NZ = timezone(timedelta(hours=12))


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=90) as r:
        return json.load(r)


def device():
    d = get("/api/devices?windowSec=120&onlineSec=3600&includeMetrics=1")
    return next((x for x in d.get("devices", []) if x.get("deviceId") == UID), None)


print("=== M4x JS 45s poll (fix t) ===")
seen = []
for i in range(15):
    dev = device()
    if not dev:
        print(f"{i}: offline/not found")
    else:
        g = (dev.get("gps") or {}).get("last") or {}
        t = g.get("t")
        src = g.get("sampleSource")
        prov = g.get("provider")
        acc = g.get("acc")
        spd = g.get("spd")
        ago = dev.get("lastSeenAgoSec")
        sid = (dev.get("sessionId") or "")[:8]
        ingest = dev.get("ingestRateHz")
        rate = (dev.get("gps") or {}).get("rateHz")
        if t and (not seen or seen[-1] != t):
            seen.append(t)
        ts = datetime.fromtimestamp(t / 1000, NZ).strftime("%H:%M:%S") if t else "?"
        print(
            f"{i:2d} seen={ago}s sid={sid or '-'} ingestHz={ingest} gpsHz={rate} "
            f"t={ts} acc={acc} spd={spd} src={src} prov={prov}"
        )
    time.sleep(3)

if len(seen) > 1:
    gaps = [(seen[i] - seen[i - 1]) / 1000 for i in range(1, len(seen))]
    print(f"\nunique fixes={len(seen)} gaps={gaps}")
    print(f"median gap={statistics.median(gaps):.2f}s top={Counter(round(g, 1) for g in gaps).most_common()}")

enc = urllib.parse.quote(UID)
sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
print("\n=== Latest sessions ===")
for s in sessions[:3]:
    st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    en = s.get("ended_at")
    end = datetime.fromisoformat(en.replace("Z", "+00:00")).astimezone(NZ) if en else None
    print(
        f"{s['session_id'][:8]}  {st.strftime('%Y-%m-%d %H:%M:%S')} "
        f"{'open' if not end else end.strftime('%H:%M:%S')}  samples={s.get('sample_count')}"
    )
