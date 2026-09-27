#!/usr/bin/env python3
"""Compare A3 (CrewSight) vs F4 (KRI) 1s reporting test."""
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


def dedupe_burst(pts, min_gap_s=0.75):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap_s:
            out.append(p)
    return out


def analyze_uid(uid: str):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    if not sessions:
        return {"uid": uid, "error": "no sessions"}

    # Use most recent session with GPS
    best = None
    for s in sessions[:8]:
        tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
        rows = sorted([{"t": p["t"]} for p in tr if p.get("lat") is not None], key=lambda r: r["t"])
        if len(rows) < 5:
            continue
        st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
        en = datetime.fromtimestamp(rows[-1]["t"] / 1000, tz=NZ)
        dur = (rows[-1]["t"] - rows[0]["t"]) / 1000
        score = rows[-1]["t"]  # prefer most recent
        if best is None or score > best["score"]:
            best = {
                "uid": uid,
                "prefix": s["session_id"][:8],
                "sess_st": st,
                "gps_st": datetime.fromtimestamp(rows[0]["t"] / 1000, tz=NZ),
                "gps_en": en,
                "dur_s": dur,
                "samples": s.get("sample_count"),
                "rows": rows,
                "score": score,
            }

    if not best:
        return {"uid": uid, "error": "no GPS in recent sessions"}

    rows = best["rows"]
    gaps = [(rows[i]["t"] - rows[i - 1]["t"]) / 1000 for i in range(1, len(rows))]
    steady = [g for g in gaps if g >= 0.75]
    micro = [g for g in gaps if g < 0.75]
    ded = dedupe_burst(rows)
    dgaps = [(ded[i]["t"] - ded[i - 1]["t"]) / 1000 for i in range(1, len(ded))]

    def band(gap_list, lo, hi):
        if not gap_list:
            return 0, 0.0
        n = sum(1 for g in gap_list if lo <= g <= hi)
        return n, 100 * n / len(gap_list)

    in1_s, pct1_s = band(steady, 0.75, 1.35)
    in1_d, pct1_d = band(dgaps, 0.75, 1.35)
    stalls = sum(1 for g in gaps if g > 5)

    # Last 3 min segment (likely active test)
    end_ms = rows[-1]["t"]
    seg = [r for r in rows if r["t"] >= end_ms - 3 * 60 * 1000]
    seg_d = dedupe_burst(seg)
    sg = [(seg_d[i]["t"] - seg_d[i - 1]["t"]) / 1000 for i in range(1, len(seg_d))]
    _, pct1_seg = band(sg, 0.75, 1.35)

    best.update(
        {
            "pts": len(rows),
            "deduped": len(ded),
            "steady_n": len(steady),
            "micro_n": len(micro),
            "steady_med": round(statistics.median(steady), 3) if steady else None,
            "dedup_med": round(statistics.median(dgaps), 3) if dgaps else None,
            "dedup_mean": round(statistics.mean(dgaps), 3) if dgaps else None,
            "pct_1s_steady": round(pct1_s, 1),
            "pct_1s_dedup": round(pct1_d, 1),
            "pct_1s_last3m": round(pct1_seg, 1),
            "stalls_gt5s": stalls,
            "top_steady": Counter(round(g, 2) for g in steady).most_common(5),
            "top_dedup": Counter(round(g, 2) for g in dgaps).most_common(5),
            "seg_pts": len(seg_d),
            "seg_med": round(statistics.median(sg), 3) if sg else None,
        }
    )
    return best


def fmt(info):
    if info.get("error"):
        return f"{info['uid']}: {info['error']}"
    return (
        f"{info['uid']} ({info['prefix']})\n"
        f"  Session start: {info['sess_st'].strftime('%H:%M:%S')} NZ\n"
        f"  GPS span:      {info['gps_st'].strftime('%H:%M:%S')} -> {info['gps_en'].strftime('%H:%M:%S')} "
        f"({info['dur_s']/60:.1f} min)\n"
        f"  Points: {info['pts']} raw / {info['deduped']} deduped  samples={info['samples']}\n"
        f"  Steady gaps: n={info['steady_n']}  micro={info['micro_n']}  stalls>5s={info['stalls_gt5s']}\n"
        f"  Median: steady={info['steady_med']}s  dedup={info['dedup_med']}s  mean={info['dedup_mean']}s\n"
        f"  1s band: steady={info['pct_1s_steady']}%  dedup={info['pct_1s_dedup']}%  last 3min={info['pct_1s_last3m']}%\n"
        f"  Top dedup gaps: {info['top_dedup']}\n"
        f"  Last 3min: {info['seg_pts']} deduped pts  median={info['seg_med']}s  "
        f"expected ~180 @1s"
    )


print("=== A3 (CrewSight) vs F4 (KRI) — 1s reporting ===\n")
results = {}
for uid in ("A3", "F4"):
    results[uid] = analyze_uid(uid)
    print(fmt(results[uid]))
    print()

# Side-by-side summary
print("=== Summary ===")
for uid in ("A3", "F4"):
    r = results[uid]
    if r.get("error"):
        print(f"  {uid}: {r['error']}")
        continue
    exp = r["dur_s"]
    rate = r["deduped"] / max(exp, 1)
    verdict = "PASS" if r["pct_1s_dedup"] >= 85 and r["dedup_med"] and 0.9 <= r["dedup_med"] <= 1.15 else "MIXED/FAIL"
    print(
        f"  {uid}: dedup rate={rate:.2f}/s  med={r['dedup_med']}s  "
        f"1s band={r['pct_1s_dedup']}%  -> {verdict}"
    )
