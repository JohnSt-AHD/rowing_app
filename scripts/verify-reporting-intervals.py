#!/usr/bin/env python3
"""
Verify CrewSight reporting interval vs stored GPS timestamps.

Native app uploads one GPS sample per gpsIntervalMs bucket (see CapsizeMonitorService).
This script measures inter-fix gaps in persisted session tracks.
"""
import json
import math
import statistics
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = sys.argv[1] if len(sys.argv) > 1 else "A2"
NZ = timezone(timedelta(hours=12))

# Expected settings label -> nominal seconds (+ batch duplicate tolerance)
INTERVALS = {
    1: {"label": "1s", "lo": 0.75, "hi": 1.35, "nominal": 1.0},
    5: {"label": "5s", "lo": 4.0, "hi": 6.5, "nominal": 5.0},
    10: {"label": "10s", "lo": 8.0, "hi": 12.5, "nominal": 10.0},
}


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def gap_stats(tr):
    tr = sorted(
        [p for p in tr if p.get("lat") is not None and p.get("lon") is not None],
        key=lambda p: p["t"],
    )
    if len(tr) < 2:
        return None

    all_gaps = []
    for i in range(1, len(tr)):
        dt = (tr[i]["t"] - tr[i - 1]["t"]) / 1000
        if dt > 0:
            all_gaps.append(dt)

    if not all_gaps:
        return None

    # Sub-second gaps = batched/duplicate timestamps in one upload burst
    micro = [g for g in all_gaps if g < 0.75]
    steady = [g for g in all_gaps if g >= 0.75]

    def pct_in(lo, hi, gaps):
        if not gaps:
            return 0.0
        return 100 * sum(1 for g in gaps if lo <= g <= hi) / len(gaps)

    def detect_interval(gaps):
        if not gaps:
            return None
        med = statistics.median(gaps)
        best = None
        best_pct = 0
        for key, spec in INTERVALS.items():
            p = pct_in(spec["lo"], spec["hi"], gaps)
            if p > best_pct:
                best_pct = p
                best = key
        # 5s setting sometimes alternates ~3s + ~6s (fused min + bucket)
        alt5 = pct_in(2.5, 3.5, gaps) + pct_in(5.5, 6.5, gaps)
        if alt5 > best_pct and alt5 > 30:
            return 5, alt5, med
        return best, best_pct, med

    detected, conf, med = detect_interval(steady if steady else all_gaps)
    top = Counter(round(g, 2) for g in steady).most_common(6) if steady else Counter(round(g, 2) for g in all_gaps).most_common(6)

    dur = (tr[-1]["t"] - tr[0]["t"]) / 1000
    return {
        "points": len(tr),
        "dur_min": dur / 60,
        "all_gaps": len(all_gaps),
        "micro_gaps": len(micro),
        "steady_gaps": len(steady),
        "steady_med": round(statistics.median(steady), 2) if steady else None,
        "steady_mean": round(statistics.mean(steady), 2) if steady else None,
        "detected": detected,
        "detect_conf_pct": round(conf, 1),
        "top_steady_gaps": top,
        "pct_1s": round(pct_in(0.75, 1.35, steady), 1),
        "pct_5s": round(pct_in(4.0, 6.5, steady), 1),
        "pct_10s": round(pct_in(8.0, 12.5, steady), 1),
        "pct_3s_alt": round(pct_in(2.5, 3.5, steady), 1),
        "stalls_30s": sum(1 for g in all_gaps if g > 30),
    }


def verdict(expected: int | None, stats: dict) -> str:
    if not stats or stats["steady_gaps"] < 5:
        return "insufficient data"
    spec = INTERVALS.get(expected) if expected else None
    if spec:
        in_band = pct_in_band(stats, spec["lo"], spec["hi"])
        if in_band >= 55:
            return f"PASS ({in_band:.0f}% steady gaps in {spec['label']} band)"
        if expected == 5 and stats["pct_3s_alt"] + stats["pct_5s"] >= 55:
            return f"PARTIAL (5s setting: ~3s+~6s pattern {stats['pct_3s_alt']+stats['pct_5s']:.0f}%)"
        return f"FAIL ({in_band:.0f}% in {spec['label']} band; med={stats['steady_med']}s)"
    if stats["detected"]:
        d = INTERVALS[stats["detected"]]["label"]
        return f"detected ~{d} ({stats['detect_conf_pct']:.0f}% confidence)"
    return "unclear"


def pct_in_band(stats, lo, hi):
    if stats["detected"] == 1:
        return stats["pct_1s"]
    if stats["detected"] == 5:
        return stats["pct_5s"]
    if stats["detected"] == 10:
        return stats["pct_10s"]
    steady = stats["steady_gaps"]
    if not steady:
        return 0
    # recompute from stored pcts
    if lo <= 1.35 and hi >= 0.75:
        return stats["pct_1s"]
    if lo <= 6.5 and hi >= 4.0:
        return stats["pct_5s"]
    if lo <= 12.5 and hi >= 8.0:
        return stats["pct_10s"]
    return 0


# Manual labels from test order this morning (NZ) — adjust if wrong
SESSION_EXPECTED = {
    "74590921": 5,
    "d93a97ff": 10,
    "a949d245": 10,
    "94fbf106": 1,
    "f5e33978": 1,
}


def main():
    sessions = get(f"/api/history?list=sessions&uniqueId={UID}").get("sessions", [])
    now_nz = datetime.now(NZ)
    morning_start = now_nz.replace(hour=0, minute=0, second=0, microsecond=0)
    morning_end = now_nz.replace(hour=12, minute=0, second=0, microsecond=0)

    print(f"=== Reporting interval verification — {UID} ===")
    print(f"App setting maps to gpsIntervalMs (native timer per bucket).\n")
    print(f"Morning sessions ({morning_start.date()} 00:00–12:00 NZST):\n")

    rows = []
    for s in sessions:
        st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
        if not (morning_start <= st < morning_end):
            continue
        sid = s["session_id"]
        tr = get(f"/api/history?format=dashboard&sessionId={sid}").get("track") or []
        stats = gap_stats(tr)
        if not stats:
            continue
        prefix = sid[:8]
        expected = SESSION_EXPECTED.get(prefix)
        rows.append((st, prefix, expected, stats, s.get("sample_count")))

    rows.sort(key=lambda r: r[0])

    for st, prefix, expected, stats, samples in rows:
        exp_label = INTERVALS[expected]["label"] if expected else "?"
        det = INTERVALS[stats["detected"]]["label"] if stats["detected"] else "?"
        print(f"{prefix}  {st.strftime('%H:%M')} NZ  expected={exp_label}  detected={det}")
        print(f"  samples={samples}  GPS pts={stats['points']}  dur={stats['dur_min']:.1f}min")
        print(
            f"  steady gaps: n={stats['steady_gaps']}  med={stats['steady_med']}s  mean={stats['steady_mean']}s"
            f"  | micro<{0.75}s: {stats['micro_gaps']}"
        )
        print(
            f"  in-band: 1s={stats['pct_1s']}%  5s={stats['pct_5s']}%  10s={stats['pct_10s']}%"
            f"  (~3s alt={stats['pct_3s_alt']}%)  stalls>30s={stats['stalls_30s']}"
        )
        print(f"  top steady gaps: {stats['top_steady_gaps']}")
        print(f"  -> {verdict(expected, stats)}\n")

    print("=== Summary ===")
    for interval in (1, 5, 10):
        spec = INTERVALS[interval]
        matching = [r for r in rows if r[2] == interval]
        if not matching:
            print(f"  {spec['label']}: no labelled session this morning")
            continue
        for _, prefix, _, stats, _ in matching:
            print(f"  {spec['label']} ({prefix}): {verdict(interval, stats)}")

    print(
        "\nNote: sub-second gaps are batched samples from one upload; "
        "steady gaps (≥0.75s) reflect the timer bucket rate."
    )


if __name__ == "__main__":
    main()
