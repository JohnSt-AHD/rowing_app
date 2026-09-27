#!/usr/bin/env python3
"""Analyze A2 5s reporting test ending ~08:20 NZST Jul 2 2026."""
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = "A2"
NZ = timezone(timedelta(hours=12))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def dedupe_burst(pts, min_gap_s=0.75):
    if not pts:
        return []
    out = [pts[0]]
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap_s:
            out.append(p)
    return out


def analyze_session(s, tr):
    rows = sorted(
        [{"t": p["t"], "lat": p["lat"]} for p in tr if p.get("lat") is not None],
        key=lambda r: r["t"],
    )
    if len(rows) < 2:
        return None

    sess_st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    gps_st = datetime.fromtimestamp(rows[0]["t"] / 1000, tz=NZ)
    gps_en = datetime.fromtimestamp(rows[-1]["t"] / 1000, tz=NZ)
    dur_s = (rows[-1]["t"] - rows[0]["t"]) / 1000

    gaps = [(rows[i]["t"] - rows[i - 1]["t"]) / 1000 for i in range(1, len(rows))]
    steady = [g for g in gaps if g >= 0.75]
    deduped = dedupe_burst(rows)
    dgaps = [(deduped[i]["t"] - deduped[i - 1]["t"]) / 1000 for i in range(1, len(deduped))]

    def band_stats(gap_list, lo, hi):
        if not gap_list:
            return 0, 0.0
        n = sum(1 for g in gap_list if lo <= g <= hi)
        return n, 100 * n / len(gap_list)

    in5_raw, pct5_raw = band_stats(steady, 4.0, 6.5)
    in3_alt, pct3 = band_stats(steady, 2.5, 3.5)
    in6_alt, pct6 = band_stats(steady, 5.5, 6.5)
    in5_d, pct5_d = band_stats(dgaps, 4.0, 6.5)
    in3_d, pct3_d = band_stats(dgaps, 2.5, 3.5)

    return {
        "prefix": s["session_id"][:8],
        "sess_st": sess_st,
        "gps_st": gps_st,
        "gps_en": gps_en,
        "dur_s": dur_s,
        "samples": s.get("sample_count"),
        "pts": len(rows),
        "deduped": len(deduped),
        "steady_med": statistics.median(steady) if steady else None,
        "dedup_med": statistics.median(dgaps) if dgaps else None,
        "dedup_mean": statistics.mean(dgaps) if dgaps else None,
        "pct_5s_steady": pct5_raw,
        "pct_3s_alt": pct3,
        "pct_5s_dedup": pct5_d,
        "pct_3s_dedup": pct3_d,
        "top_steady": Counter(round(g, 2) for g in steady).most_common(6),
        "top_dedup": Counter(round(g, 2) for g in dgaps).most_common(6),
        "stalls_30": sum(1 for g in gaps if g > 30),
        "rows": rows,
    }


sessions = get(f"/api/history?list=sessions&uniqueId={UID}").get("sessions", [])
print(f"=== A2 sessions around 08:15-08:25 NZST ===\n")

candidates = []
for s in sessions:
    st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    if st.date().isoformat() != "2026-07-02":
        continue
    tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
    info = analyze_session(s, tr)
    if not info:
        continue
    if info["gps_en"].hour == 8 and 17 <= info["gps_en"].minute <= 23:
        candidates.append(info)
    print(
        f"  {info['prefix']}  sess_start={st.strftime('%H:%M:%S')}  "
        f"gps={info['gps_st'].strftime('%H:%M:%S')}-{info['gps_en'].strftime('%H:%M:%S')}  "
        f"dur={info['dur_s']/60:.1f}m  pts={info['pts']}  samples={info['samples']}"
    )

if not candidates:
    # pick most recent session ending near 8:20
    for s in sessions[:5]:
        tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
        info = analyze_session(s, tr)
        if info and info["gps_en"].hour == 8 and info["gps_en"].minute >= 18:
            candidates.append(info)

target = candidates[0] if candidates else None
if not target:
    print("\nNo session found ending ~08:20.")
    raise SystemExit(1)

# Focus window ending ~08:20 (last 10 min of session or full if shorter)
end_ms = target["rows"][-1]["t"]
win_start = end_ms - 10 * 60 * 1000
window = [r for r in target["rows"] if r["t"] >= win_start]
deduped_w = dedupe_burst(window)
wgaps = [(deduped_w[i]["t"] - deduped_w[i - 1]["t"]) / 1000 for i in range(1, len(deduped_w))]
wst = datetime.fromtimestamp(window[0]["t"] / 1000, tz=NZ)
wen = datetime.fromtimestamp(window[-1]["t"] / 1000, tz=NZ)
wdur = (window[-1]["t"] - window[0]["t"]) / 1000

in5 = sum(1 for g in wgaps if 4.0 <= g <= 6.5)
in3 = sum(1 for g in wgaps if 2.5 <= g <= 3.5)
in6 = sum(1 for g in wgaps if 5.5 <= g <= 6.5)

print(f"\n=== Likely 5s test: {target['prefix']} ===")
print(f"Session start: {target['sess_st'].strftime('%H:%M:%S')} NZ")
print(f"GPS span:      {target['gps_st'].strftime('%H:%M:%S')} -> {target['gps_en'].strftime('%H:%M:%S')} ({target['dur_s']/60:.1f} min)")
print(f"Points: {target['pts']} raw / {target['deduped']} deduped  (samples={target['samples']})")
print(f"Steady gap median: {target['steady_med']:.2f}s")
print(f"Deduped gap median: {target['dedup_med']:.2f}s  mean: {target['dedup_mean']:.2f}s")
print(f"Deduped in 5s band (4-6.5s): {target['pct_5s_dedup']:.1f}%")
print(f"Deduped ~3s alt band: {target['pct_3s_dedup']:.1f}%")
print(f"Top deduped gaps: {target['top_dedup']}")
print(f"Stalls >30s: {target['stalls_30']}")
print(f"Expected @5s for full span: ~{target['dur_s']/5:.0f} deduped pts vs {target['deduped']} actual")

print(f"\n--- Last segment ending ~08:20 ({wst.strftime('%H:%M:%S')}-{wen.strftime('%H:%M:%S')}, {wdur/60:.1f} min) ---")
if wgaps:
    print(f"Deduped pts: {len(deduped_w)}  expected @5s: ~{wdur/5:.0f}")
    print(f"Gap median: {statistics.median(wgaps):.2f}s  mean: {statistics.mean(wgaps):.2f}s")
    print(f"5s band: {in5}/{len(wgaps)} = {100*in5/len(wgaps):.1f}%")
    print(f"~3s alt: {in3}/{len(wgaps)} = {100*in3/len(wgaps):.1f}%")
    print(f"~6s alt: {in6}/{len(wgaps)} = {100*in6/len(wgaps):.1f}%")
    print(f"3s+5s/6s combined: {100*(in3+in5)/len(wgaps):.1f}%")
    print(f"Top gaps: {Counter(round(g, 2) for g in wgaps).most_common(8)}")
