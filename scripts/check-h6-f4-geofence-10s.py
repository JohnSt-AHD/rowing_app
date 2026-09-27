#!/usr/bin/env python3
"""Check H6/F4 reporting in geofence (user 10s vs geofence 1s)."""
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def dedupe(pts, min_gap=0.75):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap:
            out.append(p)
    return out


def band_pct(gaps, lo, hi):
    if not gaps:
        return 0.0
    return 100 * sum(1 for g in gaps if lo <= g <= hi) / len(gaps)


def analyze_uid(uid: str):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    if not sessions:
        return {"uid": uid, "error": "no sessions"}

    s = sessions[0]
    tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
    gps_rows = sorted([p for p in tr if p.get("lat") is not None], key=lambda p: p["t"])
    if len(gps_rows) < 3:
        return {"uid": uid, "error": "insufficient GPS"}

    ded = dedupe(gps_rows)
    dgaps = [(ded[i]["t"] - ded[i - 1]["t"]) / 1000 for i in range(1, len(ded))]

    st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    dur = (gps_rows[-1]["t"] - gps_rows[0]["t"]) / 1000

    # inBoatPark from route API if available
    route = get(f"/api/history?uniqueId={uid}&from={s['started_at']}&to=2099-01-01T00:00:00.000Z")
    park = 0
    hb = 0
    if isinstance(route, list):
        for p in route:
            if not isinstance(p, dict):
                continue
            attrs = p.get("attributes") or {}
            if attrs.get("inBoatPark"):
                park += 1
            if attrs.get("heartbeat"):
                hb += 1

    return {
        "uid": uid,
        "prefix": s["session_id"][:8],
        "sess_st": st,
        "gps_st": datetime.fromtimestamp(gps_rows[0]["t"] / 1000, tz=NZ),
        "gps_en": datetime.fromtimestamp(gps_rows[-1]["t"] / 1000, tz=NZ),
        "dur_s": dur,
        "raw": len(gps_rows),
        "deduped": len(ded),
        "rate": len(ded) / max(dur, 1),
        "med": round(statistics.median(dgaps), 3) if dgaps else None,
        "mean": round(statistics.mean(dgaps), 3) if dgaps else None,
        "pct_1s": round(band_pct(dgaps, 0.75, 1.35), 1),
        "pct_3s": round(band_pct(dgaps, 2.25, 3.75), 1),
        "pct_10s": round(band_pct(dgaps, 7.5, 12.5), 1),
        "top": Counter(round(g, 2) for g in dgaps).most_common(6),
        "stalls_gt15s": sum(1 for g in dgaps if g > 15),
        "boat_park_rows": park,
        "heartbeats": hb,
    }


print("=== H6 vs F4 — user 10s, geofence 1s ===\n")
print("Expected (CrewSight fix): user 10s wins in geofence -> ~0.1/s on BOTH")
print("Legacy KRI: geofence may override native GPS to 1s on F4 only\n")

for uid in ("H6", "F4"):
    r = analyze_uid(uid)
    if r.get("error"):
        print(f"{uid}: {r['error']}\n")
        continue

    if r["pct_10s"] >= 85 and r["med"] and 9 <= r["med"] <= 11.5:
        mode = "10s (user setting)"
        verdict = "PASS @10s"
    elif r["pct_1s"] >= 85 and r["med"] and 0.9 <= r["med"] <= 1.15:
        mode = "1s (geofence override?)"
        verdict = "PASS @1s (geofence)"
    else:
        mode = "mixed"
        verdict = "MIXED/FAIL"

    print(f"{uid} ({r['prefix']})  session {r['sess_st'].strftime('%H:%M:%S')} NZ")
    print(
        f"  GPS: {r['gps_st'].strftime('%H:%M:%S')} -> {r['gps_en'].strftime('%H:%M:%S')} "
        f"({r['dur_s']/60:.1f} min)  raw={r['raw']} dedup={r['deduped']}"
    )
    print(
        f"  Rate={r['rate']:.2f}/s  med={r['med']}s  mean={r['mean']}s"
    )
    print(
        f"  Bands: 1s={r['pct_1s']}%  3s={r['pct_3s']}%  10s={r['pct_10s']}%  "
        f"stalls>15s={r['stalls_gt15s']}"
    )
    print(f"  Top gaps: {r['top']}")
    print(f"  Route rows inBoatPark={r['boat_park_rows']} heartbeats={r['heartbeats']}")
    print(f"  -> {mode} — {verdict}\n")

print("=== Live fleet ===")
dev = get("/api/devices?windowSec=600&onlineSec=180&includeMetrics=1")
for uid in ("H6", "F4"):
    d = next((x for x in dev.get("devices", []) if x.get("deviceId") == uid), None)
    if not d:
        print(f"  {uid}: not found")
        continue
    gps = d.get("gps") or {}
    print(
        f"  {uid}: online={d.get('online')} lastSeen={d.get('lastSeenAgoSec')}s "
        f"gpsHz={gps.get('rateHz')} fixAge={gps.get('ageSec')}s"
    )
