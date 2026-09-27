#!/usr/bin/env python3
"""Plot position-based segment speed vs 30s path pace for recent W2x EH 5min pieces."""
from __future__ import annotations

import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
PIECE_MS = 5 * 60_000
LOOKBACK_MIN = 45
OUT = Path(__file__).resolve().parent.parent / "assets" / "crewsight" / "w2x-eh-piece-5min-speed.html"

PATH_PACE_WINDOW_MS = 30_000
PATH_PACE_MIN_SEGMENT_M = 1
PATH_PACE_MAX_SEGMENT_MPS = 6.5
PATH_PACE_SEGMENT_BAND_LO = 0.72
PATH_PACE_SEGMENT_BAND_HI = 1.28
PATH_PACE_MIN_TIME_SEC = 4
PATH_PACE_MIN_DIST_M = 8


def get(path: str) -> dict:
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def distance_along_bearing(lat1: float, lon1: float, lat2: float, lon2: float, brg: float) -> float:
    dist = haversine_m(lat1, lon1, lat2, lon2)
    if dist < 0.01:
        return 0.0
    seg_brg = bearing_deg(lat1, lon1, lat2, lon2)
    delta = math.radians(((seg_brg - brg) + 540) % 360 - 180)
    return dist * math.cos(delta)


def dominant_motion_bearing_deg(fixes: list[dict]) -> float | None:
    if len(fixes) < 2:
        return None
    start = max(1, len(fixes) - 6)
    sum_x = 0.0
    sum_y = 0.0
    for i in range(start, len(fixes)):
        b = bearing_deg(fixes[i - 1]["lat"], fixes[i - 1]["lon"], fixes[i]["lat"], fixes[i]["lon"])
        sum_x += math.cos(math.radians(b))
        sum_y += math.sin(math.radians(b))
    if sum_x == 0 and sum_y == 0:
        return None
    return (math.degrees(math.atan2(sum_y, sum_x)) + 360) % 360


def trim_fixes_to_current_motion_run(fixes: list[dict]) -> list[dict]:
    if len(fixes) < 2:
        return fixes
    brg = dominant_motion_bearing_deg(fixes)
    if brg is None:
        return fixes
    run_start = 0
    prev_sign = None
    for i in range(len(fixes) - 1, 0, -1):
        along = distance_along_bearing(
            fixes[i - 1]["lat"],
            fixes[i - 1]["lon"],
            fixes[i]["lat"],
            fixes[i]["lon"],
            brg,
        )
        if abs(along) < 0.75:
            continue
        sign = 1 if along > 0 else -1
        if prev_sign is None:
            prev_sign = sign
        elif sign != prev_sign:
            run_start = i
            break
    trimmed = fixes[run_start:]
    return trimmed if len(trimmed) >= 2 else fixes


def path_speed_mps_from_fixes(
    fixes: list[dict],
    end_t: int,
    window_ms: int = PATH_PACE_WINDOW_MS,
) -> float | None:
    if not fixes:
        return None
    sorted_fixes = sorted(fixes, key=lambda f: f["t"])
    cutoff = end_t - window_ms
    pts = trim_fixes_to_current_motion_run(
        [f for f in sorted_fixes if f["t"] >= cutoff and f.get("lat") is not None and f.get("lon") is not None]
    )
    if len(pts) < 2:
        return None

    segments: list[tuple[float, float, float]] = []
    for i in range(1, len(pts)):
        dt = (pts[i]["t"] - pts[i - 1]["t"]) / 1000
        if dt <= 0 or dt > 15:
            continue
        acc = pts[i].get("acc") if pts[i].get("acc") is not None else pts[i - 1].get("acc")
        if acc is not None and math.isfinite(acc) and acc > 25:
            continue
        d = haversine_m(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
        if d < PATH_PACE_MIN_SEGMENT_M:
            continue
        seg = d / dt
        if seg > PATH_PACE_MAX_SEGMENT_MPS:
            continue
        segments.append((d, dt, seg))
    if len(segments) < 2:
        return None

    seg_vals = [seg for _, _, seg in segments]
    median_seg = statistics.median(seg_vals)
    if median_seg < 0.25:
        return None

    lo = median_seg * PATH_PACE_SEGMENT_BAND_LO
    hi = median_seg * PATH_PACE_SEGMENT_BAND_HI
    dist_m = 0.0
    time_sec = 0.0
    in_band: list[float] = []
    for d, dt, seg in segments:
        if seg < lo or seg > hi:
            continue
        dist_m += d
        time_sec += dt
        in_band.append(seg)
    if time_sec >= PATH_PACE_MIN_TIME_SEC and dist_m >= PATH_PACE_MIN_DIST_M:
        return dist_m / time_sec
    if len(in_band) >= 2:
        return statistics.median(in_band)
    return median_seg


def segment_speed_mps(prev: dict | None, fix: dict) -> float | None:
    if prev is None:
        return None
    dt = (fix["t"] - prev["t"]) / 1000
    if dt <= 0 or dt > 15:
        return None
    d = haversine_m(prev["lat"], prev["lon"], fix["lat"], fix["lon"])
    if d < PATH_PACE_MIN_SEGMENT_M:
        return None
    seg = d / dt
    if seg > PATH_PACE_MAX_SEGMENT_MPS:
        return None
    return seg


def split500(mps: float | None) -> str:
    if mps is None or mps < 0.25:
        return "—"
    sec = 500 / mps
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def load_recent_gps(minutes: int = LOOKBACK_MIN) -> list[dict]:
    enc = urllib.parse.quote(UID, safe="")
    now = datetime.now(timezone.utc)
    frm = (now - timedelta(minutes=minutes)).isoformat().replace("+00:00", "Z")
    to = now.isoformat().replace("+00:00", "Z")
    track = get(
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    ).get("track") or []
    return [
        {"t": p["t"], "lat": p["lat"], "lon": p["lon"], "acc": p.get("accuracy")}
        for p in track
        if p.get("lat") is not None and p.get("lon") is not None and p.get("t") is not None
    ]


def find_piece_windows(gps: list[dict], piece_ms: int = PIECE_MS) -> list[tuple[int, int]]:
    """Up to 3 recent non-overlapping 5min windows with steady rowing."""
    if len(gps) < 20:
        end_t = gps[-1]["t"]
        return [(end_t - piece_ms, end_t)]

    fixes_prefix: list[dict] = []
    candidates: list[tuple[int, int, float]] = []
    for fix in gps:
        fixes_prefix.append(fix)
        end_t = fix["t"]
        start_t = end_t - piece_ms
        path = path_speed_mps_from_fixes(fixes_prefix, end_t)
        if path is None or path < 3.0:
            continue
        in_window = sum(1 for f in fixes_prefix if start_t <= f["t"] <= end_t)
        if in_window >= 40:
            candidates.append((start_t, end_t, path))

    if not candidates:
        end_t = gps[-1]["t"]
        return [(end_t - piece_ms, end_t)]

    chosen: list[tuple[int, int]] = []
    for start_t, end_t, _path in reversed(candidates):
        if any(not (end_t <= s or start_t >= e) for s, e in chosen):
            continue
        chosen.append((start_t, end_t))
        if len(chosen) >= 3:
            break
    chosen.reverse()
    if not chosen:
        start_t, end_t, _ = candidates[-1]
        return [(start_t, end_t)]
    return chosen


def build_piece_series(gps: list[dict], start_t: int, end_t: int) -> dict:
    fixes_prefix: list[dict] = []
    elapsed_sec: list[float] = []
    segment_mps: list[float | None] = []
    path30_mps: list[float | None] = []
    prev = None

    for fix in gps:
        fixes_prefix.append(fix)
        if fix["t"] < start_t:
            prev = fix
            continue
        if fix["t"] > end_t:
            break
        elapsed_sec.append((fix["t"] - start_t) / 1000)
        segment_mps.append(segment_speed_mps(prev, fix))
        path30_mps.append(path_speed_mps_from_fixes(fixes_prefix, fix["t"]))
        prev = fix

    return {
        "elapsed_sec": elapsed_sec,
        "segment_mps": segment_mps,
        "path30_mps": path30_mps,
    }


def render_html(pieces: list[dict]) -> str:
    data_json = json.dumps({"pieces": pieces})
    panels = []
    for idx, piece in enumerate(pieces):
        start = piece["start_local"]
        end = piece["end_local"]
        seg = [v for v in piece["series"]["segment_mps"] if v is not None]
        path = [v for v in piece["series"]["path30_mps"] if v is not None]
        summary = ""
        if seg and path:
            summary = (
                f"Segment avg {split500(statistics.mean(seg))}/500 · "
                f"Path 30s avg {split500(statistics.mean(path))}/500"
            )
        panels.append(
            f"""
  <div class="panel">
    <h2>Piece {idx + 1}: {start} – {end}</h2>
    <p class="caption">{summary} · {piece.get('point_count', 0)} GPS points</p>
    <canvas id="chart{idx}"></canvas>
  </div>"""
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>W2x EH — 5min piece speed</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {{
      --bg: #0f1419; --panel: #171d24; --text: #e8edf2; --muted: #8b98a5; --grid: #2a3440;
    }}
    body {{ margin: 0; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 20px; }}
    h1 {{ font-size: 1.25rem; margin: 0 0 6px; }}
    .sub {{ color: var(--muted); margin-bottom: 18px; }}
    .panel {{ background: var(--panel); border: 1px solid var(--grid); border-radius: 10px; padding: 16px; margin-bottom: 16px; }}
    .panel h2 {{ font-size: 1rem; margin: 0 0 4px; }}
    .caption {{ color: var(--muted); font-size: 12px; margin: 0 0 12px; }}
    canvas {{ width: 100% !important; height: 300px !important; }}
    .legend-note {{ color: var(--muted); font-size: 12px; margin-top: 8px; }}
  </style>
</head>
<body>
  <h1>W2x EH — position speed vs 30s path pace</h1>
  <p class="sub">Source: production /api/history · target band 1:40–2:00/500 · path30s matches RowSafe server (30s window, spike filter)</p>
  {''.join(panels)}
  <p class="legend-note">Red = segment speed (distance/time between GPS fixes). Green = 30s path pace (rolling window, median-band spike filter).</p>
  <script>
    const payload = {data_json};
    const bandLo = 500 / 120;
    const bandHi = 500 / 100;
    const common = {{
      responsive: true,
      maintainAspectRatio: false,
      interaction: {{ mode: 'index', intersect: false }},
      plugins: {{
        legend: {{ labels: {{ color: '#e8edf2' }} }},
        tooltip: {{
          callbacks: {{
            label(ctx) {{
              const v = ctx.parsed.y;
              if (v == null || !Number.isFinite(v)) return ctx.dataset.label + ': —';
              const split = 500 / v;
              const mm = Math.floor(split / 60);
              const ss = (split % 60).toFixed(1).padStart(4, '0');
              return ctx.dataset.label + ': ' + v.toFixed(2) + ' m/s (' + mm + ':' + ss + '/500)';
            }}
          }}
        }},
        annotation: {{}}
      }},
      scales: {{
        x: {{ title: {{ display: true, text: 'Elapsed (seconds)', color: '#8b98a5' }}, ticks: {{ color: '#8b98a5' }}, grid: {{ color: '#2a3440' }} }},
        y: {{ title: {{ display: true, text: 'Speed (m/s)', color: '#8b98a5' }}, ticks: {{ color: '#8b98a5' }}, grid: {{ color: '#2a3440' }}, min: 0, suggestedMax: 6.5 }}
      }}
    }};

    payload.pieces.forEach((piece, idx) => {{
      const s = piece.series;
      new Chart(document.getElementById('chart' + idx), {{
        type: 'line',
        data: {{
          labels: s.elapsed_sec.map(v => v.toFixed(0)),
          datasets: [
            {{ label: 'Segment (position-based)', data: s.segment_mps, borderColor: '#ef4444', borderWidth: 1.2, pointRadius: 0, spanGaps: false }},
            {{ label: 'Path 30s (RowSafe)', data: s.path30_mps, borderColor: '#a3e635', borderWidth: 2, pointRadius: 0, spanGaps: false }},
          ]
        }},
        options: common
      }});
    }});
  </script>
</body>
</html>
"""


def main() -> None:
    gps = load_recent_gps()
    if len(gps) < 10:
        raise SystemExit("Not enough recent GPS for W2x EH")

    windows = find_piece_windows(gps)
    pieces = []
    for start_t, end_t in windows:
        series = build_piece_series(gps, start_t, end_t)
        if len(series["elapsed_sec"]) < 5:
            continue
        tz = timezone.utc
        pieces.append(
            {
                "start_t": start_t,
                "end_t": end_t,
                "start_local": datetime.fromtimestamp(start_t / 1000, tz=tz).strftime("%H:%M:%S UTC"),
                "end_local": datetime.fromtimestamp(end_t / 1000, tz=tz).strftime("%H:%M:%S UTC"),
                "point_count": len(series["elapsed_sec"]),
                "series": series,
            }
        )

    if not pieces:
        end_t = gps[-1]["t"]
        start_t = end_t - PIECE_MS
        series = build_piece_series(gps, start_t, end_t)
        pieces.append(
            {
                "start_t": start_t,
                "end_t": end_t,
                "start_local": datetime.fromtimestamp(start_t / 1000, tz=timezone.utc).strftime("%H:%M:%S UTC"),
                "end_local": datetime.fromtimestamp(end_t / 1000, tz=timezone.utc).strftime("%H:%M:%S UTC"),
                "point_count": len(series["elapsed_sec"]),
                "series": series,
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render_html(pieces), encoding="utf-8")
    print(f"Wrote {OUT} ({len(pieces)} piece chart(s))")
    for p in pieces:
        seg = [v for v in p["series"]["segment_mps"] if v is not None]
        path = [v for v in p["series"]["path30_mps"] if v is not None]
        print(
            f"  {p['start_local']} – {p['end_local']}: "
            f"segment {split500(statistics.mean(seg)) if seg else '—'} · "
            f"path30 {split500(statistics.mean(path)) if path else '—'}"
        )


if __name__ == "__main__":
    main()
