#!/usr/bin/env python3
"""Morning session GPS location reliability (not speed)."""
from __future__ import annotations

import json
import math
import statistics
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
HDR = {"Authorization": "Bearer rnz", "Accept": "application/json"}
NZ = timezone(timedelta(hours=12))


def get(path: str) -> dict:
    req = urllib.request.Request(BASE + path, headers=HDR)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def hav_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def analyze_location(tr: list[dict], moving_threshold_mps: float = 1.5) -> dict | None:
    tr = sorted(
        [p for p in tr if p.get("lat") is not None and p.get("lon") is not None],
        key=lambda p: p["t"],
    )
    if len(tr) < 2:
        return None

    gaps: list[float] = []
    jumps: list[float] = []
    accs: list[float] = []
    dup_coords = 0
    zero_moves = 0
    spike_50 = spike_100 = spike_200 = 0
    bad_acc = 0

    for i in range(1, len(tr)):
        dt = (tr[i]["t"] - tr[i - 1]["t"]) / 1000
        if dt <= 0:
            continue
        gaps.append(dt)
        d = hav_m(tr[i - 1]["lat"], tr[i - 1]["lon"], tr[i]["lat"], tr[i]["lon"])
        jumps.append(d)
        if d < 0.5:
            zero_moves += 1
        if d > 50:
            spike_50 += 1
        if d > 100:
            spike_100 += 1
        if d > 200:
            spike_200 += 1
        if tr[i - 1]["lat"] == tr[i]["lat"] and tr[i - 1]["lon"] == tr[i]["lon"]:
            dup_coords += 1
        acc = tr[i].get("acc")
        if acc is not None:
            accs.append(float(acc))
            if float(acc) > 25:
                bad_acc += 1

    dur = (tr[-1]["t"] - tr[0]["t"]) / 1000
    dist = sum(jumps)
    nz_gaps = [g for g in gaps if g > 0]
    near1 = sum(1 for g in nz_gaps if 0.5 <= g <= 1.5)
    near5 = sum(1 for g in nz_gaps if 4 <= g <= 6)
    big30 = sum(1 for g in nz_gaps if g > 30)
    big60 = sum(1 for g in nz_gaps if g > 60)
    eff_hz = len(tr) / max(dur, 1)
    avg_der = dist / max(dur, 1)
    moving = avg_der >= moving_threshold_mps

    jump_p50 = statistics.median(jumps) if jumps else 0
    jump_p95 = sorted(jumps)[int(0.95 * len(jumps))] if jumps else 0
    jump_p99 = sorted(jumps)[int(0.99 * len(jumps))] if jumps else 0

    med_lat = statistics.median([p["lat"] for p in tr])
    med_lon = statistics.median([p["lon"] for p in tr])
    perp_spreads = [hav_m(med_lat, med_lon, p["lat"], p["lon"]) for p in tr]

    return {
        "points": len(tr),
        "dur_min": round(dur / 60, 1),
        "dist_m": round(dist),
        "moving": moving,
        "eff_hz": round(eff_hz, 2),
        "gap_med": round(statistics.median(nz_gaps), 2) if nz_gaps else None,
        "gap_p95": round(sorted(nz_gaps)[int(0.95 * len(nz_gaps))], 1) if nz_gaps else None,
        "gap_max": round(max(nz_gaps), 1) if nz_gaps else None,
        "pct_1s": round(100 * near1 / len(nz_gaps), 1) if nz_gaps else 0,
        "pct_5s": round(100 * near5 / len(nz_gaps), 1) if nz_gaps else 0,
        "gaps_gt30s": big30,
        "gaps_gt60s": big60,
        "acc_n": len(accs),
        "acc_med": round(statistics.median(accs), 1) if accs else None,
        "acc_p95": round(sorted(accs)[int(0.95 * len(accs))], 1) if accs else None,
        "acc_max": round(max(accs), 1) if accs else None,
        "acc_gt25m": bad_acc,
        "jump_med_m": round(jump_p50, 1),
        "jump_p95_m": round(jump_p95, 1),
        "jump_p99_m": round(jump_p99, 1),
        "spike_gt50m": spike_50,
        "spike_gt100m": spike_100,
        "spike_gt200m": spike_200,
        "dup_coords": dup_coords,
        "zero_move_segments": zero_moves,
        "track_spread_m": round(max(perp_spreads), 1),
    }


def quality_label(r: dict) -> str:
    issues: list[str] = []
    if r["eff_hz"] < 0.7:
        issues.append("low fix rate")
    if r["gaps_gt30s"]:
        issues.append(f"{r['gaps_gt30s']} gaps >30s")
    if r["spike_gt50m"] > max(3, r["points"] * 0.02):
        issues.append(f"{r['spike_gt50m']} spikes >50m")
    if r["acc_med"] and r["acc_med"] > 8:
        issues.append("median acc >8m")
    if r["acc_gt25m"] > 5:
        issues.append(f"{r['acc_gt25m']} fixes acc>25m")
    if r["moving"] and r["jump_p95_m"] > 15:
        issues.append("noisy step jumps")
    if r["dup_coords"] > r["points"] * 0.1:
        issues.append("many duplicate coords")
    return "Good" if not issues else "; ".join(issues)


def discover_device_ids() -> list[str]:
    ids: set[str] = set()
    try:
        dev_resp = get("/api/devices?windowSec=3600&onlineSec=7200")
        for d in dev_resp.get("devices", []):
            ids.add(d["deviceId"])
    except OSError:
        pass
    for extra in ["W2x EH", "A1", "A2", "A3", "H6", "H7", "H8", "W2KL", "W2x", "M1X"]:
        ids.add(extra)
    return sorted(ids, key=str.lower)


def main() -> None:
    now_nz = datetime.now(NZ)
    morning_start = now_nz.replace(hour=0, minute=0, second=0, microsecond=0)
    print(
        f"Morning window: {morning_start.strftime('%Y-%m-%d %H:%M')} – "
        f"{now_nz.strftime('%H:%M')} NZST\n"
    )

    all_morning: list[tuple[str, datetime, str, dict, int | None]] = []
    for uid in discover_device_ids():
        enc = quote(uid, safe="")
        try:
            sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
        except OSError:
            continue
        for s in sessions:
            st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
            if st < morning_start or st > now_nz:
                continue
            sid = s["session_id"]
            try:
                dash = get(f"/api/history?format=dashboard&sessionId={quote(sid)}")
            except OSError as e:
                print(f"  skip {uid} {sid[:8]}: {e}")
                continue
            r = analyze_location(dash.get("track") or [])
            if r:
                all_morning.append((uid, st, sid, r, s.get("sample_count")))

    all_morning.sort(key=lambda x: x[1])
    print(f"Found {len(all_morning)} session(s) this morning\n")

    header = (
        f"{'Device':<10} {'Start':<8} {'Dur':<6} {'Pts':<6} {'Hz':<5} "
        f"{'Gap med':<8} {'Acc med':<8} {'Jump p95':<9} {'Spikes>50m':<11} "
        f"{'Gaps>30s':<9} Quality"
    )
    print(header)
    print("-" * len(header))

    for uid, st, _sid, r, _samples in all_morning:
        acc = f"{r['acc_med']}m" if r["acc_med"] else "n/a"
        print(
            f"{uid:<10} {st.strftime('%H:%M'):<8} {r['dur_min']:<6} {r['points']:<6} "
            f"{r['eff_hz']:<5} {str(r['gap_med']) + 's':<8} {acc:<8} "
            f"{str(r['jump_p95_m']) + 'm':<9} {r['spike_gt50m']:<11} "
            f"{r['gaps_gt30s']:<9} {quality_label(r)}"
        )

    print("\n=== Detail ===")
    for uid, st, sid, r, samples in all_morning:
        print(f"\n--- {uid} @ {st.strftime('%H:%M:%S')} ({sid[:8]}) samples={samples} ---")
        print(
            f"  GPS points: {r['points']} over {r['dur_min']} min "
            f"({r['dist_m']} m track) — {r['eff_hz']} Hz effective"
        )
        print(
            f"  Fix gaps: median {r['gap_med']}s, p95 {r['gap_p95']}s, max {r['gap_max']}s "
            f"| ~1s: {r['pct_1s']}%, ~5s: {r['pct_5s']}%"
        )
        print(f"  Gaps >30s: {r['gaps_gt30s']}, >60s: {r['gaps_gt60s']}")
        if r["acc_n"]:
            print(
                f"  Reported accuracy: median {r['acc_med']}m, p95 {r['acc_p95']}m, "
                f"max {r['acc_max']}m ({r['acc_gt25m']} fixes >25m)"
            )
        else:
            print("  Reported accuracy: not present in track")
        print(
            f"  Step jumps: median {r['jump_med_m']}m, p95 {r['jump_p95_m']}m, "
            f"p99 {r['jump_p99_m']}m"
        )
        print(
            f"  Position spikes: >50m={r['spike_gt50m']}, >100m={r['spike_gt100m']}, "
            f">200m={r['spike_gt200m']}"
        )
        print(
            f"  Duplicate coords: {r['dup_coords']} | "
            f"near-zero moves (<0.5m): {r['zero_move_segments']}"
        )
        print(f"  Max spread from track median: {r['track_spread_m']}m")


def deep_dive(uid: str) -> None:
    enc = quote(uid, safe="")
    sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
    if not sessions:
        print(f"No sessions for {uid}")
        return
    s = sessions[0]
    sid = s["session_id"]
    dash = get(f"/api/history?format=dashboard&sessionId={quote(sid)}")
    tr = sorted([p for p in dash.get("track", []) if p.get("lat")], key=lambda p: p["t"])
    frm, to = dash.get("from"), dash.get("to")
    route = (
        get(f"/api/history?uniqueId={enc}&from={quote(frm)}&to={quote(to)}")
        if frm and to
        else []
    )

    print(f"\n=== Deep dive: {uid} ({sid[:8]}) ===")
    print(f"Track points: {len(tr)}  Route points: {len(route)}")
    if route:
        accs = [float(p["accuracy"]) for p in route if p.get("accuracy") not in (None, 0)]
        if accs:
            print(
                f"Route accuracy: n={len(accs)} median={statistics.median(accs):.1f}m "
                f"p95={sorted(accs)[int(0.95 * len(accs))]:.1f}m max={max(accs):.1f}m"
            )

    gaps = [(tr[i]["t"] - tr[i - 1]["t"]) / 1000 for i in range(1, len(tr)) if tr[i]["t"] > tr[i - 1]["t"]]
    from collections import Counter

    c = Counter(round(g, 1) for g in gaps)
    print(f"Top gap intervals: {c.most_common(6)}")
    print(f"Gaps <=1.5s: {100 * sum(1 for g in gaps if g <= 1.5) / len(gaps):.1f}%")

    spikes: list[tuple] = []
    steady_jumps: list[float] = []
    for i in range(1, len(tr)):
        dt = (tr[i]["t"] - tr[i - 1]["t"]) / 1000
        if dt <= 0:
            continue
        d = hav_m(tr[i - 1]["lat"], tr[i - 1]["lon"], tr[i]["lat"], tr[i]["lon"])
        seg = d / dt
        if d > 50:
            t = datetime.fromtimestamp(tr[i]["t"] / 1000, tz=NZ)
            spikes.append((d, dt, seg, t.strftime("%H:%M:%S")))
        elif 1.5 <= seg <= 6 and d >= 1:
            steady_jumps.append(d)

    print(f"Position spikes >50m: {len(spikes)} ({100 * len(spikes) / max(len(tr) - 1, 1):.1f}% of segments)")
    if spikes:
        print("  Worst 5:")
        for row in sorted(spikes, reverse=True)[:5]:
            print(f"    {row[0]:.0f}m in {row[1]:.1f}s => {row[2]:.1f} m/s at {row[3]}")
        hours = Counter(s[3][:2] for s in spikes)
        print(f"  Spikes by hour (NZ): {dict(sorted(hours.items()))}")

    if steady_jumps:
        print(
            f"Steady-motion steps (1.5–6 m/s): median {statistics.median(steady_jumps):.1f}m, "
            f"p95 {sorted(steady_jumps)[int(0.95 * len(steady_jumps))]:.1f}m"
        )

    window = 10 * 60 * 1000
    print("10-min windows (points, spikes>50m):")
    for start in range(tr[0]["t"], tr[-1]["t"], window):
        end = start + window
        chunk = [p for p in tr if start <= p["t"] < end]
        if len(chunk) < 5:
            continue
        sp = 0
        for i in range(1, len(chunk)):
            dt = (chunk[i]["t"] - chunk[i - 1]["t"]) / 1000
            if dt <= 0:
                continue
            d = hav_m(
                chunk[i - 1]["lat"],
                chunk[i - 1]["lon"],
                chunk[i]["lat"],
                chunk[i]["lon"],
            )
            if d > 50:
                sp += 1
        t0 = datetime.fromtimestamp(start / 1000, tz=NZ).strftime("%H:%M")
        t1 = datetime.fromtimestamp(end / 1000, tz=NZ).strftime("%H:%M")
        if sp or len(chunk) > 100:
            print(f"  {t0}–{t1}: {len(chunk)} pts, spikes={sp}")


if __name__ == "__main__":
    import sys

    main()
    for uid in sys.argv[1:] or ["W2x EH", "M1x TM"]:
        deep_dive(uid)
