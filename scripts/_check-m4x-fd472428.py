#!/usr/bin/env python3
"""Deep dive fd472428 drive session — 30s gaps."""
import json
import statistics
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
SID = "fd472428"
NZ = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


# session meta
sessions = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M4x JS")).get("sessions") or []
meta = next((s for s in sessions if s["session_id"].startswith(SID)), None)
print("=== Session", SID, "===")
if meta:
    st = datetime.fromisoformat(meta["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    en = meta.get("ended_at")
    end = datetime.fromisoformat(en.replace("Z", "+00:00")).astimezone(NZ) if en else None
    print(f"start={st} end={end} samples={meta.get('sample_count')}")

dash = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(meta['session_id'] if meta else SID)}")
track = dash.get("track") or []
print(f"track points={len(track)}")

# try raw samples if endpoint exists
for fmt in ("raw", "samples"):
    try:
        raw = get(f"/api/history?format={fmt}&sessionId={urllib.parse.quote(meta['session_id'])}&limit=500")
        samples = raw.get("samples") or raw.get("rows") or []
        if samples:
            print(f"\n=== format={fmt} samples={len(samples)} ===")
            gps = [s for s in samples if s.get("gps") or s.get("latitude") is not None]
            print(f"with gps: {len(gps)}")
            gaps = []
            prev = None
            for s in sorted(gps, key=lambda x: x.get("t") or x.get("t_ms") or 0):
                t = s.get("t") or s.get("t_ms")
                if prev and t:
                    gaps.append((t - prev) / 1000)
                prev = t
            steady = [g for g in gaps if g >= 0.75]
            print(f"gps gap med={statistics.median(steady) if steady else 'n/a'}s top={Counter(round(g,1) for g in steady).most_common(8)}")
            src = Counter(
                (s.get("gps") or {}).get("sampleSource")
                or s.get("gps_sample_source")
                or "?"
                for s in gps
            ).most_common()
            print(f"sampleSource: {src}")
            park = sum(1 for s in samples if (s.get("derived") or {}).get("inBoatPark"))
            print(f"inBoatPark samples: {park}/{len(samples)}")
            hb = sum(1 for s in samples if (s.get("derived") or {}).get("heartbeat"))
            print(f"heartbeat samples: {hb}")
            break
    except Exception as e:
        print(f"format={fmt}: {e}")

# compare prior indoor session
sid2 = next(s["session_id"] for s in sessions if s["session_id"].startswith("3e089aaa"))
raw2 = get(f"/api/history?format=raw&sessionId={urllib.parse.quote(sid2)}&limit=300")
samps2 = raw2.get("samples") or []
gps2 = [s for s in samps2 if s.get("gps")]
print(f"\n=== prior session 3e089aaa (indoor?) samples={len(samps2)} gps={len(gps2)} ===")
gaps2 = []
prev = None
for s in sorted(gps2, key=lambda x: x["t"]):
    if prev:
        gaps2.append((s["t"] - prev) / 1000)
    prev = s["t"]
steady2 = [g for g in gaps2 if g >= 0.75]
print(f"med={statistics.median(steady2) if steady2 else 'n/a'}s")
print(f"sampleSource: {Counter((s.get('gps') or {}).get('sampleSource') or '?' for s in gps2).most_common()}")
print(f"inBoatPark: {sum(1 for s in samps2 if (s.get('derived') or {}).get('inBoatPark'))}")
