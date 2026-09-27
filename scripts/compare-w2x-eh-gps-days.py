#!/usr/bin/env python3
"""Compare W2x EH GPS location accuracy between two mornings."""
from __future__ import annotations

import json
import math
import statistics
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
HDR = {"Authorization": "Bearer rnz", "Accept": "application/json"}
UID = "W2x EH"
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


def load_day(label: str, frm_nz: datetime, to_nz: datetime) -> tuple[list[dict], list[dict], dict]:
    enc = quote(UID, safe="")
    frm = frm_nz.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    to = to_nz.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    dash = get(f"/api/history?format=dashboard&uniqueId={enc}&from={quote(frm)}&to={quote(to)}")
    track = sorted(
        [p for p in dash.get("track", []) if p.get("lat") is not None and p.get("lon") is not None],
        key=lambda p: p["t"],
    )
    route = get(f"/api/history?uniqueId={enc}&from={quote(frm)}&to={quote(to)}")
    meta = {
        "label": label,
        "from_nz": frm_nz.strftime("%Y-%m-%d %H:%M"),
        "to_nz": to_nz.strftime("%H:%M"),
        "session_id": (dash.get("sessionId") or "")[:8] or "—",
        "points": len(track),
        "route_points": len(route),
    }
    if track:
        t0 = datetime.fromtimestamp(track[0]["t"] / 1000, tz=NZ)
        t1 = datetime.fromtimestamp(track[-1]["t"] / 1000, tz=NZ)
        meta["actual_start"] = t0.strftime("%H:%M:%S")
        meta["actual_end"] = t1.strftime("%H:%M:%S")
        meta["dur_min"] = round((track[-1]["t"] - track[0]["t"]) / 60000, 1)
    return track, route, meta


def analyze(track: list[dict], route: list[dict]) -> dict:
    gaps: list[float] = []
    jumps: list[float] = []
    steady_jumps: list[float] = []
    spike_50 = spike_100 = spike_200 = 0
    dup_coords = zero_moves = 0

    for i in range(1, len(track)):
        dt = (track[i]["t"] - track[i - 1]["t"]) / 1000
        if dt <= 0:
            continue
        gaps.append(dt)
        d = hav_m(track[i - 1]["lat"], track[i - 1]["lon"], track[i]["lat"], track[i]["lon"])
        jumps.append(d)
        seg = d / dt
        if d < 0.5:
            zero_moves += 1
        if d > 50:
            spike_50 += 1
        if d > 100:
            spike_100 += 1
        if d > 200:
            spike_200 += 1
        if track[i - 1]["lat"] == track[i]["lat"] and track[i - 1]["lon"] == track[i]["lon"]:
            dup_coords += 1
        if 1.5 <= seg <= 6 and d >= 1:
            steady_jumps.append(d)

    nz_gaps = [g for g in gaps if g > 0]
    dur = (track[-1]["t"] - track[0]["t"]) / 1000 if len(track) >= 2 else 0
    dist = sum(jumps)

    accs = [float(p["accuracy"]) for p in route if p.get("accuracy") not in (None, 0)]
    accs.sort()

    def pct_gap(lo: float, hi: float) -> float:
        return round(100 * sum(1 for g in nz_gaps if lo <= g <= hi) / len(nz_gaps), 1) if nz_gaps else 0

    jump_p95 = sorted(jumps)[int(0.95 * len(jumps))] if jumps else 0
    jump_p99 = sorted(jumps)[int(0.99 * len(jumps))] if jumps else 0

    return {
        "eff_hz": round(len(track) / max(dur, 1), 2),
        "dist_m": round(dist),
        "gap_med": round(statistics.median(nz_gaps), 2) if nz_gaps else None,
        "gap_p95": round(sorted(nz_gaps)[int(0.95 * len(nz_gaps))], 1) if nz_gaps else None,
        "gap_max": round(max(nz_gaps), 1) if nz_gaps else None,
        "pct_1s": pct_gap(0.75, 1.35),
        "pct_2s": pct_gap(1.65, 2.35),
        "pct_5s": pct_gap(4.0, 6.5),
        "gaps_gt30s": sum(1 for g in nz_gaps if g > 30),
        "acc_n": len(accs),
        "acc_med": round(statistics.median(accs), 2) if accs else None,
        "acc_mean": round(statistics.mean(accs), 2) if accs else None,
        "acc_p95": round(accs[int(0.95 * len(accs))], 2) if accs else None,
        "acc_max": round(max(accs), 2) if accs else None,
        "acc_gt15m": sum(1 for a in accs if a > 15),
        "acc_gt25m": sum(1 for a in accs if a > 25),
        "jump_med_m": round(statistics.median(jumps), 1) if jumps else None,
        "jump_p95_m": round(jump_p95, 1),
        "jump_p99_m": round(jump_p99, 1),
        "steady_jump_med_m": round(statistics.median(steady_jumps), 1) if steady_jumps else None,
        "steady_jump_p95_m": round(sorted(steady_jumps)[int(0.95 * len(steady_jumps))], 1)
        if steady_jumps
        else None,
        "spike_gt50m": spike_50,
        "spike_gt100m": spike_100,
        "spike_gt200m": spike_200,
        "spike_pct": round(100 * spike_50 / max(len(jumps), 1), 2),
        "dup_coords": dup_coords,
        "zero_move_segments": zero_moves,
        "segments": len(jumps),
    }


def route_time_ms(p: dict) -> int:
    raw = p.get("deviceTime") or p.get("fixTime")
    if raw is None:
        return 0
    if isinstance(raw, (int, float)):
        return int(raw)
    return int(datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp() * 1000)


def acc_excluding_teleports(route: list[dict]) -> tuple[list[float], list[float]]:
    route = sorted(route, key=route_time_ms)
    teleport_times: set[int] = set()
    prev = None
    prev_t = 0
    for p in route:
        t = route_time_ms(p)
        if prev is not None and t > prev_t:
            dt = (t - prev_t) / 1000
            if 0 < dt <= 5:
                d = hav_m(
                    prev["latitude"],
                    prev["longitude"],
                    p["latitude"],
                    p["longitude"],
                )
                if d > 50:
                    teleport_times.add(t)
        prev = p
        prev_t = t
    all_accs = [float(p["accuracy"]) for p in route if p.get("accuracy") not in (None, 0)]
    clean = [
        float(p["accuracy"])
        for p in route
        if p.get("accuracy") not in (None, 0) and route_time_ms(p) not in teleport_times
    ]
    return all_accs, clean


def acc_summary(accs: list[float], label: str) -> None:
    if not accs:
        print(f"  {label}: no data")
        return
    accs = sorted(accs)
    print(
        f"  {label}: n={len(accs)} median={statistics.median(accs):.2f}m "
        f"p95={accs[int(0.95 * len(accs))]:.2f}m max={max(accs):.2f}m "
        f">15m={sum(1 for a in accs if a > 15)} >25m={sum(1 for a in accs if a > 25)}"
    )

def delta(a: dict | None, b: dict | None, key: str, fmt: str = "", better_lower: bool = True) -> str:
    if a is None or b is None or a.get(key) is None or b.get(key) is None:
        return "—"
    va, vb = a[key], b[key]
    diff = vb - va
    if isinstance(va, (int, float)) and va != 0 and fmt.endswith("%"):
        pct = 100 * diff / va
        arrow = "down better" if (diff < 0) == better_lower else "up better"
        if abs(pct) < 1:
            arrow = "~ same"
        return f"{diff:+{fmt}} ({pct:+.1f}%) {arrow}"
    arrow = "down better" if (diff < 0) == better_lower else "up better"
    if diff == 0:
        arrow = "same"
    return f"{diff:+{fmt}} {arrow}"


def main() -> None:
    today = datetime.now(NZ).date()
    yesterday = today - timedelta(days=1)

    # Morning window: 06:00–12:00 NZ (captures on-water time)
    days = [
        (
            "Yesterday (Jul 23)",
            datetime(yesterday.year, yesterday.month, yesterday.day, 6, 0, tzinfo=NZ),
            datetime(yesterday.year, yesterday.month, yesterday.day, 12, 0, tzinfo=NZ),
        ),
        (
            "Today (Jul 24)",
            datetime(today.year, today.month, today.day, 6, 0, tzinfo=NZ),
            datetime(today.year, today.month, today.day, 12, 0, tzinfo=NZ),
        ),
    ]

    results: list[tuple[dict, dict]] = []
    for label, frm, to in days:
        track, route, meta = load_day(label, frm, to)
        if len(track) < 2:
            print(f"{label}: no GPS data")
            continue
        stats = analyze(track, route)
        results.append((meta, stats))

    if len(results) < 2:
        print("Need data on both days")
        return

    m0, s0 = results[0]
    m1, s1 = results[1]

    print(f"=== W2x EH GPS location accuracy: {m0['label']} vs {m1['label']} ===\n")
    for meta in (m0, m1):
        print(
            f"{meta['label']}: {meta.get('actual_start')}–{meta.get('actual_end')} NZ "
            f"({meta.get('dur_min')} min) | session {meta['session_id']} | "
            f"{meta['points']} track pts / {meta['route_points']} route pts"
        )
    print()

    rows = [
        ("Effective fix rate (Hz)", "eff_hz", ".2f", False),
        ("Gap median (s)", "gap_med", ".2f", True),
        ("Gap p95 (s)", "gap_p95", ".1f", True),
        ("Gap max (s)", "gap_max", ".1f", True),
        ("% gaps ~1s", "pct_1s", ".1f", False),
        ("% gaps ~2s", "pct_2s", ".1f", False),
        ("Gaps >30s", "gaps_gt30s", "d", True),
        ("Reported accuracy median (m)", "acc_med", ".2f", True),
        ("Reported accuracy mean (m)", "acc_mean", ".2f", True),
        ("Reported accuracy p95 (m)", "acc_p95", ".2f", True),
        ("Reported accuracy max (m)", "acc_max", ".2f", True),
        ("Fixes with acc >15m", "acc_gt15m", "d", True),
        ("Fixes with acc >25m", "acc_gt25m", "d", True),
        ("Step jump median (m)", "jump_med_m", ".1f", True),
        ("Step jump p95 (m)", "jump_p95_m", ".1f", True),
        ("Step jump p99 (m)", "jump_p99_m", ".1f", True),
        ("Steady-motion step median (m)", "steady_jump_med_m", ".1f", True),
        ("Steady-motion step p95 (m)", "steady_jump_p95_m", ".1f", True),
        ("Teleports >50m (count)", "spike_gt50m", "d", True),
        ("Teleports >50m (%)", "spike_pct", ".2f", True),
        ("Teleports >100m", "spike_gt100m", "d", True),
        ("Teleports >200m", "spike_gt200m", "d", True),
        ("Duplicate coords", "dup_coords", "d", True),
        ("Near-zero moves (<0.5m)", "zero_move_segments", "d", True),
        ("Track distance (m)", "dist_m", "d", False),
    ]

    print(f"{'Metric':<32} {'Yesterday':<14} {'Today':<14} {'Change (today vs yday)'}")
    print("-" * 90)
    for name, key, fmt, lower_better in rows:
        v0 = s0.get(key)
        v1 = s1.get(key)
        if fmt == "d":
            fs0 = str(v0) if v0 is not None else "—"
            fs1 = str(v1) if v1 is not None else "—"
        else:
            fs0 = f"{v0:{fmt}}" if v0 is not None else "—"
            fs1 = f"{v1:{fmt}}" if v1 is not None else "—"
        ch = delta(s0, s1, key, fmt, lower_better)
        print(f"{name:<32} {fs0:<14} {fs1:<14} {ch}")

    print("\n=== Accuracy with teleports excluded ===")
    for label, frm, to in days:
        _track, route, _meta = load_day(label, frm, to)
        all_accs, clean = acc_excluding_teleports(route)
        print(label)
        acc_summary(all_accs, "all fixes")
        acc_summary(clean, "excluding teleport fixes (>50m jump)")

    print("\n=== Interpretation ===")
    acc_better = (s1.get("acc_med") or 99) < (s0.get("acc_med") or 0)
    spike_better = (s1.get("spike_gt50m") or 0) < (s0.get("spike_gt50m") or 0)
    gap_better = (s1.get("gap_med") or 99) <= (s0.get("gap_med") or 0) and (s1.get("pct_1s") or 0) >= (
        s0.get("pct_1s") or 0
    )

    parts = []
    if acc_better:
        parts.append("reported accuracy improved (lower median/p95)")
    else:
        parts.append("reported accuracy did not improve materially")
    if spike_better:
        parts.append("fewer position teleports")
    else:
        parts.append("similar or more position teleports")
    if gap_better:
        parts.append("fix timing slightly better")
    else:
        parts.append("fix timing similar or slower (~2s cadence both days)")
    print("- " + "; ".join(parts) + ".")


if __name__ == "__main__":
    main()
