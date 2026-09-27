#!/usr/bin/env python3
"""Compare old vs new map ticket logic on M1x TM today."""
import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M1x TM"
AUCKLAND = timezone(timedelta(hours=12))
TODAY_START = datetime(2026, 7, 31, 6, 0, 0, tzinfo=AUCKLAND)
TODAY_END = datetime(2026, 7, 31, 10, 0, 0, tzinfo=AUCKLAND)

PATH_PACE_WINDOW_MS = 30_000
PATH_PACE_RECENT_WINDOW_MS = 12_000
PATH_PACE_MIN_SEGMENT_M = 1
PATH_PACE_MAX_SEGMENT_MPS = 6.5
PATH_PACE_SEGMENT_BAND_LO = 0.72
PATH_PACE_SEGMENT_BAND_HI = 1.28
PATH_PACE_MIN_TIME_SEC = 4
PATH_PACE_MIN_DIST_M = 8
PATH_PACE_RECENT_MAX_DT_SEC = 12
PATH_PACE_EMA_ALPHA = 0.45
PATH_PACE_MAX_STEP_RATIO = 1.35
PATH_PACE_REST_MAX_MPS = 1.5
ROWING_MIN_OLD = 3.2
ROWING_MIN_NEW = 2.5


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def split500(v):
    if v is None or not isinstance(v, (int, float)) or v < 0.25:
        return "-"
    sec = 500 / float(v)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def hav(a, b, c, d):
    r = 6371000.0
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def median_of(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def collect_path_segments(pts, max_dt_sec=15):
    segs = []
    for i in range(1, len(pts)):
        dt = (pts[i]["t"] - pts[i - 1]["t"]) / 1000
        if dt <= 0 or dt > max_dt_sec:
            continue
        acc = pts[i].get("acc") if pts[i].get("acc") is not None else pts[i - 1].get("acc")
        if acc is not None and acc > 25:
            continue
        d = hav(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
        if d < PATH_PACE_MIN_SEGMENT_M:
            continue
        seg = d / dt
        if seg > PATH_PACE_MAX_SEGMENT_MPS:
            continue
        segs.append({"d": d, "dt": dt, "seg": seg})
    return segs


def recent_segment_speed(fixes, window_ms=PATH_PACE_RECENT_WINDOW_MS):
    if not fixes:
        return None
    end_t = fixes[-1]["t"]
    pts = [f for f in fixes if f["t"] >= end_t - window_ms]
    if len(pts) < 2:
        return None
    segs = collect_path_segments(pts, PATH_PACE_RECENT_MAX_DT_SEC)
    if len(segs) < 2:
        return None
    med = median_of([s["seg"] for s in segs])
    return med if med and med >= 0.25 else None


def path_speed_30s(fixes, window_ms=PATH_PACE_WINDOW_MS):
    if not fixes:
        return None
    end_t = fixes[-1]["t"]
    pts = [f for f in fixes if f["t"] >= end_t - window_ms]
    if len(pts) < 2:
        return None
    segs = collect_path_segments(pts)
    if len(segs) < 2:
        return None
    median_seg = median_of([s["seg"] for s in segs])
    if median_seg is None or median_seg < 0.25:
        return None
    lo, hi = median_seg * PATH_PACE_SEGMENT_BAND_LO, median_seg * PATH_PACE_SEGMENT_BAND_HI
    dist_m = time_sec = 0.0
    in_band = []
    for s in segs:
        if s["seg"] < lo or s["seg"] > hi:
            continue
        dist_m += s["d"]
        time_sec += s["dt"]
        in_band.append(s["seg"])
    if time_sec >= PATH_PACE_MIN_TIME_SEC and dist_m >= PATH_PACE_MIN_DIST_M:
        return dist_m / time_sec
    if len(in_band) >= 2:
        return median_of(in_band)
    return median_seg


def coach_raw(path_speed, recent_speed):
    if recent_speed is not None and path_speed is not None:
        ratio = recent_speed / path_speed if path_speed else 0
        if 0.55 <= ratio <= 1.45:
            return recent_speed
        return path_speed
    return recent_speed if recent_speed is not None else path_speed


def resolve_display(raw_path, prev_ema, rowing_min):
    if raw_path is None or raw_path < 0.25:
        return prev_ema
    accepted = raw_path
    if prev_ema is not None and prev_ema >= 0.25:
        if prev_ema <= PATH_PACE_REST_MAX_MPS and raw_path >= rowing_min:
            accepted = raw_path
        else:
            ratio = raw_path / prev_ema
            if ratio > PATH_PACE_MAX_STEP_RATIO or ratio < 1 / PATH_PACE_MAX_STEP_RATIO:
                max_step = prev_ema * (PATH_PACE_MAX_STEP_RATIO - 1)
                delta = raw_path - prev_ema
                accepted = prev_ema + math.copysign(min(abs(delta), max_step), delta)
    if prev_ema is not None:
        return PATH_PACE_EMA_ALPHA * accepted + (1 - PATH_PACE_EMA_ALPHA) * prev_ema
    return accepted


def ground_truth_30s(fixes):
    if not fixes:
        return None
    end_t = fixes[-1]["t"]
    pts = [f for f in fixes if f["t"] >= end_t - 30_000]
    if len(pts) < 2:
        return None
    dist = sum(
        hav(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
        for i in range(1, len(pts))
    )
    span = (pts[-1]["t"] - pts[0]["t"]) / 1000
    return dist / span if span >= 4 else None


def ticket_old_map(path30, _recent12):
    return path30


def ticket_new_map(path30, recent12):
    raw = coach_raw(path30, recent12)
    if raw is not None and raw >= 0.25:
        return raw
    return path30


def replay(gps, ticket_fn, ema_mode=None, rowing_min=ROWING_MIN_NEW, step=3):
    rows = []
    ema = None
    for i in range(0, len(gps), step):
        window = gps[: i + 1]
        path30 = path_speed_30s(window)
        recent12 = recent_segment_speed(window)
        actual = ground_truth_30s(window)
        if ema_mode == "devices":
            raw = coach_raw(path30, recent12)
            ticket = resolve_display(raw, ema, rowing_min)
            ema = ticket
        else:
            ticket = ticket_fn(path30, recent12)
        if ticket is not None and actual is not None and ticket >= 0.25 and actual >= 0.25:
            rows.append({"ticket": ticket, "actual": actual})
    return rows


def stats(rows, label):
    if not rows:
        print(f"  {label}: no data")
        return
    deltas = [r["ticket"] - r["actual"] for r in rows]
    absd = [abs(d) for d in deltas]
    steady = [
        r
        for r in rows
        if 1.8 <= r["ticket"] <= 4.5 and 1.8 <= r["actual"] <= 4.5
    ]
    sd = [r["ticket"] - r["actual"] for r in steady] if steady else []
    sa = [abs(x) for x in sd]
    print(f"\n{label} ({len(rows)} samples)")
    print(
        f"  all:   med delta {statistics.median(deltas):+.2f} m/s  MAE {statistics.mean(absd):.2f}"
        f"  <=0.30m/s {sum(1 for a in absd if a <= 0.30)}/{len(absd)}"
    )
    if steady:
        print(
            f"  steady: med delta {statistics.median(sd):+.2f} m/s  MAE {statistics.mean(sa):.2f}"
            f"  <=0.30m/s {sum(1 for a in sa if a <= 0.30)}/{len(sa)}"
        )


def main():
    frm = TODAY_START.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    to = TODAY_END.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    enc = urllib.parse.quote
    data = get(
        f"/api/history?format=dashboard&uniqueId={enc(UID)}&from={enc(frm)}&to={enc(to)}"
    )
    gps = sorted(
        [p for p in (data.get("track") or []) if p.get("lat") is not None and p.get("lon") is not None],
        key=lambda x: x["t"],
    )
    print(f"M1x TM Jul 31 — ticket accuracy before/after ({len(gps)} fixes)\n")

    stats(replay(gps, ticket_old_map), "OLD map ticket (30s path only)")
    stats(replay(gps, ticket_new_map), "NEW map ticket (coachRaw: recent12 when agreed)")
    stats(
        replay(gps, None, ema_mode="devices", rowing_min=ROWING_MIN_OLD),
        "OLD devices list (EMA on coachRaw, re-seed >=3.2 m/s)",
    )
    stats(
        replay(gps, None, ema_mode="devices", rowing_min=ROWING_MIN_NEW),
        "NEW devices list (EMA on coachRaw, re-seed >=2.5 m/s)",
    )


if __name__ == "__main__":
    main()
