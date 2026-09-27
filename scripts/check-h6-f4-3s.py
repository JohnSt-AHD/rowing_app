#!/usr/bin/env python3
"""Compare H6 (CrewSight) vs F4 (KRI) 3s reporting test."""
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))
INTERVAL = 3.0
BAND_LO, BAND_HI = 2.25, 3.75
DEDUPE_MIN = 1.5


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def dedupe_burst(pts, min_gap_s=DEDUPE_MIN):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap_s:
            out.append(p)
    return out


def analyze_uid(uid: str):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    if not sessions:
        return {"uid": uid, "error": "no sessions"}

    best = None
    for s in sessions[:8]:
        tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
        rows = sorted([{"t": p["t"]} for p in tr if p.get("lat") is not None], key=lambda r: r["t"])
        if len(rows) < 5:
            continue
        score = rows[-1]["t"]
        if best is None or score > best["score"]:
            st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
            best = {
                "uid": uid,
                "prefix": s["session_id"][:8],
                "sess_st": st,
                "gps_st": datetime.fromtimestamp(rows[0]["t"] / 1000, tz=NZ),
                "gps_en": datetime.fromtimestamp(rows[-1]["t"] / 1000, tz=NZ),
                "dur_s": (rows[-1]["t"] - rows[0]["t"]) / 1000,
                "rows": rows,
                "score": score,
            }

    if not best:
        return {"uid": uid, "error": "no GPS in recent sessions"}

    rows = best["rows"]
    gaps = [(rows[i]["t"] - rows[i - 1]["t"]) / 1000 for i in range(1, len(rows))]
    ded = dedupe_burst(rows)
    dgaps = [(ded[i]["t"] - ded[i - 1]["t"]) / 1000 for i in range(1, len(ded))]

    def band(gap_list):
        if not gap_list:
            return 0, 0.0
        n = sum(1 for g in gap_list if BAND_LO <= g <= BAND_HI)
        return n, 100 * n / len(gap_list)

    _, pct_d = band(dgaps)
    end_ms = rows[-1]["t"]
    seg = dedupe_burst([r for r in rows if r["t"] >= end_ms - 3 * 60 * 1000])
    sg = [(seg[i]["t"] - seg[i - 1]["t"]) / 1000 for i in range(1, len(seg))]
    _, pct_seg = band(sg)

    best.update(
        {
            "pts": len(rows),
            "deduped": len(ded),
            "dedup_med": round(statistics.median(dgaps), 3) if dgaps else None,
            "dedup_mean": round(statistics.mean(dgaps), 3) if dgaps else None,
            "pct_3s_dedup": round(pct_d, 1),
            "pct_3s_last3m": round(pct_seg, 1),
            "stalls_gt8s": sum(1 for g in dgaps if g > 8),
            "top_dedup": Counter(round(g, 2) for g in dgaps).most_common(6),
            "seg_pts": len(seg),
            "seg_med": round(statistics.median(sg), 3) if sg else None,
            "exp_seg": int(180 / INTERVAL),
        }
    )
    return best


print(f"=== H6 (CrewSight) vs F4 (KRI) — {INTERVAL:.0f}s reporting ===\n")
results = {}
for uid in ("H6", "F4"):
    results[uid] = analyze_uid(uid)
    r = results[uid]
    if r.get("error"):
        print(f"{uid}: {r['error']}\n")
        continue
    rate = r["deduped"] / max(r["dur_s"], 1)
    verdict = (
        "PASS"
        if r["pct_3s_dedup"] >= 85
        and r["dedup_med"]
        and 2.7 <= r["dedup_med"] <= 3.4
        else "MIXED/FAIL"
    )
    print(f"{uid} ({r['prefix']})")
    print(f"  Session start: {r['sess_st'].strftime('%H:%M:%S')} NZ")
    print(
        f"  GPS span: {r['gps_st'].strftime('%H:%M:%S')} -> {r['gps_en'].strftime('%H:%M:%S')} "
        f"({r['dur_s']/60:.1f} min)"
    )
    print(f"  Points: {r['pts']} raw / {r['deduped']} deduped")
    print(
        f"  Rate: {rate:.2f}/s (expect ~{1/INTERVAL:.2f}/s)  "
        f"med={r['dedup_med']}s  mean={r['dedup_mean']}s"
    )
    print(
        f"  3s band ({BAND_LO}-{BAND_HI}s): dedup={r['pct_3s_dedup']}%  "
        f"last3m={r['pct_3s_last3m']}%  stalls>8s={r['stalls_gt8s']}"
    )
    print(f"  Top dedup gaps: {r['top_dedup']}")
    print(f"  Last 3min: {r['seg_pts']} pts med={r['seg_med']}s (expect ~{r['exp_seg']} @3s)")
    print(f"  -> {verdict}\n")

print("=== Summary ===")
for uid in ("H6", "F4"):
    r = results[uid]
    if r.get("error"):
        print(f"  {uid}: {r['error']}")
        continue
    rate = r["deduped"] / max(r["dur_s"], 1)
    verdict = (
        "PASS"
        if r["pct_3s_dedup"] >= 85
        and r["dedup_med"]
        and 2.7 <= r["dedup_med"] <= 3.4
        else "MIXED/FAIL"
    )
    print(
        f"  {uid}: rate={rate:.2f}/s med={r['dedup_med']}s "
        f"3s band={r['pct_3s_dedup']}% -> {verdict}"
    )

print("\n=== Live fleet ===")
dev = get("/api/devices?windowSec=300&onlineSec=180&includeMetrics=1")
for uid in ("H6", "F4"):
    d = next((x for x in dev.get("devices", []) if x.get("deviceId") == uid), None)
    if not d:
        print(f"  {uid}: not found")
        continue
    gps = d.get("gps") or {}
    print(
        f"  {uid}: online={d.get('online')} lastSeen={d.get('lastSeenAgoSec')}s "
        f"gpsHz={gps.get('rateHz')} fixAge={gps.get('ageSec')}s count={gps.get('count')}"
    )
