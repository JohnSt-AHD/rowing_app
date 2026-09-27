#!/usr/bin/env python3
"""Reliability report for CrewSight session GPS / upload quality."""
import json
import math
import statistics
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = sys.argv[1] if len(sys.argv) > 1 else "A2"
NZ = timezone(timedelta(hours=12))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def hav_m(lat1, lon1, lat2, lon2):
    dlat = (lat2 - lat1) * 111320
    dlon = (lon2 - lon1) * 111320 * 0.85
    return math.hypot(dlat, dlon)


def analyze_track(tr, label: str) -> dict:
    tr = [p for p in tr if p.get("lat") is not None and p.get("lon") is not None]
    if len(tr) < 2:
        return {"label": label, "points": len(tr), "ok": False}

    gaps = []
    jumps = []
    accs = []
    reported = []
    derived = []
    dup_t = 0

    for i in range(1, len(tr)):
        dt = (tr[i]["t"] - tr[i - 1]["t"]) / 1000
        if dt <= 0:
            dup_t += 1
            continue
        gaps.append(dt)
        d = hav_m(tr[i - 1]["lat"], tr[i - 1]["lon"], tr[i]["lat"], tr[i]["lon"])
        jumps.append(d)
        derived.append(d / dt)
        sp = tr[i].get("speed")
        if sp is not None:
            reported.append(sp)
        acc = tr[i].get("acc")
        if acc is not None and isinstance(acc, (int, float)):
            accs.append(float(acc))

    dist = sum(jumps)
    dur = (tr[-1]["t"] - tr[0]["t"]) / 1000
    nz_gaps = [g for g in gaps if g > 0]
    near1 = sum(1 for g in nz_gaps if 0.5 <= g <= 1.5)
    near5 = sum(1 for g in nz_gaps if 4 <= g <= 6)
    near10 = sum(1 for g in nz_gaps if 8 <= g <= 12)
    big_gaps = sum(1 for g in nz_gaps if g > 30)

    jump_p99 = sorted(jumps)[int(len(jumps) * 0.99)] if jumps else 0
    teleports = sum(1 for j in jumps if j > 200)
    rep_nz = [x for x in reported if x and x > 0.05]
    rep_high = sum(1 for x in rep_nz if x > 8)
    rep_zero = sum(1 for x in reported if x == 0)

    avg_der = dist / max(dur, 1)
    lat_span_m = (max(p["lat"] for p in tr) - min(p["lat"] for p in tr)) * 111320

    # reliability score heuristics
    issues = []
    if teleports > len(jumps) * 0.02:
        issues.append(f"teleports>{200}m: {teleports}")
    if rep_high > len(rep_nz) * 0.3 and rep_nz:
        issues.append(f"absurd speed (>8m/s): {rep_high}/{len(rep_nz)}")
    if big_gaps > 0:
        issues.append(f"gaps>30s: {big_gaps}")
    if lat_span_m > 5000 and dur < 3600:
        issues.append(f"lat span {lat_span_m:.0f}m suspicious")

    return {
        "label": label,
        "ok": True,
        "points": len(tr),
        "dur_min": round(dur / 60, 1),
        "dist_m": round(dist),
        "avg_mps": round(avg_der, 2),
        "gap_med": round(statistics.median(nz_gaps), 2) if nz_gaps else None,
        "gap_max": round(max(nz_gaps), 1) if nz_gaps else None,
        "pct_1s": round(100 * near1 / len(nz_gaps), 1) if nz_gaps else 0,
        "pct_5s": round(100 * near5 / len(nz_gaps), 1) if nz_gaps else 0,
        "pct_10s": round(100 * near10 / len(nz_gaps), 1) if nz_gaps else 0,
        "dup_timestamps": dup_t,
        "acc_med": round(statistics.median(accs), 1) if accs else None,
        "jump_p99_m": round(jump_p99, 1),
        "teleports": teleports,
        "rep_med_mps": round(statistics.median(rep_nz), 2) if rep_nz else None,
        "rep_max_mps": round(max(rep_nz), 2) if rep_nz else None,
        "rep_zeros": rep_zero,
        "issues": issues,
    }


def main():
    sessions = get(f"/api/history?list=sessions&uniqueId={UID}").get("sessions", [])
    if not sessions:
        print(f"No sessions for {UID}")
        return

    # filter "this morning" NZ: 00:00–12:00 local today
    now_nz = datetime.now(NZ)
    morning_start = now_nz.replace(hour=0, minute=0, second=0, microsecond=0)
    morning_end = now_nz.replace(hour=12, minute=0, second=0, microsecond=0)
    if now_nz.hour >= 12:
        # if afternoon, "this morning" = today 0-12
        pass
    else:
        # before noon: morning is since midnight today
        pass

    print(f"=== {UID} sessions (local NZ) ===")
    print(f"Morning window: {morning_start.strftime('%Y-%m-%d %H:%M')} – {morning_end.strftime('%H:%M')} NZST\n")

    morning_sessions = []
    for s in sessions:
        st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
        in_morning = morning_start <= st < morning_end
        flag = " *morning*" if in_morning else ""
        print(
            f"  {s['session_id'][:8]}  {st.strftime('%Y-%m-%d %H:%M:%S')} NZ  "
            f"samples={s.get('sample_count', '?')}{flag}"
        )
        if in_morning:
            morning_sessions.append(s)

    if not morning_sessions:
        print("\nNo sessions started this morning NZ — analyzing last 4 sessions instead.")
        morning_sessions = sessions[:4]

    print("\n=== Reliability analysis ===")
    for s in morning_sessions:
        sid = s["session_id"]
        tr = get(f"/api/history?format=dashboard&sessionId={sid}").get("track") or []
        st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
        r = analyze_track(tr, f"{sid[:8]} @ {st.strftime('%H:%M')}")
        print(f"\n--- {r['label']} ---")
        if not r.get("ok"):
            print("  insufficient GPS data")
            continue
        print(f"  points={r['points']}  duration={r['dur_min']} min  track dist~{r['dist_m']} m")
        print(f"  avg speed (from track)={r['avg_mps']} m/s ({r['avg_mps']*3.6:.1f} km/h)")
        print(f"  gap median={r['gap_med']}s  max={r['gap_max']}s  | ~1s:{r['pct_1s']}% ~5s:{r['pct_5s']}% ~10s:{r['pct_10s']}%")
        print(f"  accuracy median={r['acc_med']} m  |  jump p99={r['jump_p99_m']} m  teleports>200m={r['teleports']}")
        print(f"  reported speed med/max={r['rep_med_mps']}/{r['rep_max_mps']} m/s  zeros={r['rep_zeros']}")
        if r["issues"]:
            print(f"  ISSUES: {', '.join(r['issues'])}")
        else:
            print("  ISSUES: none significant")


if __name__ == "__main__":
    main()
