#!/usr/bin/env python3
"""1-minute zoom: raw Android GPS speed vs dashboard path pace (W2x EH)."""
from __future__ import annotations

import argparse
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
WINDOW_MS = 60_000
PATH_PACE_WINDOW_MS = 60_000
PATH_PACE_MIN_SEGMENT_M = 1
PATH_PACE_MAX_SEGMENT_MPS = 8
PATH_PACE_MIN_TIME_SEC = 8
PATH_PACE_MIN_DIST_M = 20
ASSETS = Path(__file__).resolve().parent.parent / "assets" / "crewsight"


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


def path_speed_mps(fixes: list[dict], end_t: int) -> float | None:
    cutoff = end_t - PATH_PACE_WINDOW_MS
    pts = [f for f in fixes if f["t"] >= cutoff]
    if len(pts) < 2:
        return None
    dist_m = 0.0
    time_sec = 0.0
    for i in range(1, len(pts)):
        dt = (pts[i]["t"] - pts[i - 1]["t"]) / 1000
        if dt <= 0 or dt > 15:
            continue
        d = haversine_m(pts[i - 1]["lat"], pts[i - 1]["lon"], pts[i]["lat"], pts[i]["lon"])
        if d < PATH_PACE_MIN_SEGMENT_M:
            continue
        seg = d / dt
        if seg > PATH_PACE_MAX_SEGMENT_MPS:
            continue
        dist_m += d
        time_sec += dt
    if time_sec < PATH_PACE_MIN_TIME_SEC or dist_m < PATH_PACE_MIN_DIST_M:
        return None
    return dist_m / time_sec


def split500(mps: float | None) -> str:
    if mps is None or mps < 0.25:
        return "—"
    sec = 500 / mps
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def load_gps_track() -> tuple[dict, list[dict]]:
    enc = urllib.parse.quote(UID, safe="")
    sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
    if not sessions:
        raise SystemExit(f"No sessions for {UID}")
    session = sessions[0]
    sid = session["session_id"]
    payload = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}")
    gps = [
        {"t": p["t"], "lat": p["lat"], "lon": p["lon"], "gps_spd": p.get("speed")}
        for p in payload.get("track") or []
        if p.get("lat") is not None and p.get("lon") is not None and p.get("t") is not None
    ]
    meta = {
        "session_id": sid,
        "unique_id": UID,
        "athlete_id": session.get("athlete_id"),
        "from": payload.get("from"),
        "to": payload.get("to"),
    }
    return meta, gps


def list_steady_minutes(gps: list[dict]) -> list[tuple[int, int]]:
    """All 60s windows (non-overlapping by ~30s) where path pace is available."""
    if len(gps) < 10:
        raise SystemExit("Not enough GPS points")
    fixes_prefix: list[dict] = []
    windows: list[tuple[int, int]] = []
    last_end = 0
    for fix in gps:
        fixes_prefix.append(fix)
        path = path_speed_mps(fixes_prefix, fix["t"])
        if path is None or path < 1.8:
            continue
        end_t = fix["t"]
        start_t = end_t - WINDOW_MS
        if start_t <= last_end - 30_000:
            continue
        in_window = sum(1 for f in fixes_prefix if start_t <= f["t"] <= end_t)
        if in_window >= 8:
            windows.append((start_t, end_t))
            last_end = end_t
    return windows


def pick_minute(gps: list[dict], which: int = 0, at_local: str | None = None) -> tuple[int, int]:
    windows = list_steady_minutes(gps)
    if at_local:
        parts = at_local.strip().split(":")
        if len(parts) >= 2:
            h, m = int(parts[0]), int(parts[1])
            sec = int(parts[2]) if len(parts) > 2 else 0
            now = datetime.fromtimestamp(gps[-1]["t"] / 1000, tz=timezone.utc).astimezone()
            target = now.replace(hour=h, minute=m, second=sec, microsecond=0)
            target_ms = int(target.timestamp() * 1000)
            if windows:
                start_t, end_t = min(windows, key=lambda w: abs(w[1] - target_ms))
                return start_t, end_t
    if not windows:
        end_t = gps[-1]["t"]
        return end_t - WINDOW_MS, end_t
    idx = max(0, min(which, len(windows) - 1))
    return windows[-(idx + 1)]


def build_minute_series(gps: list[dict], start_t: int, end_t: int) -> dict:
    fixes_prefix: list[dict] = []
    sec_from_start: list[float] = []
    android_gps: list[float | None] = []
    dashboard_path: list[float | None] = []
    old_course_view: list[float | None] = []
    prev = None

    for fix in gps:
        fixes_prefix.append(fix)
        if fix["t"] < start_t:
            prev = fix
            continue
        if fix["t"] > end_t:
            break

        sec_from_start.append((fix["t"] - start_t) / 1000)
        spd = fix.get("gps_spd")
        android_gps.append(spd if spd is not None and spd >= 0 else None)
        dashboard_path.append(path_speed_mps(fixes_prefix, fix["t"]))

        seg = None
        if prev is not None:
            dt = (fix["t"] - prev["t"]) / 1000
            if dt > 0:
                d = haversine_m(prev["lat"], prev["lon"], fix["lat"], fix["lon"])
                seg = d / dt
        old_course_view.append(seg if seg is not None and seg > 0 else None)
        prev = fix

    return {
        "sec": sec_from_start,
        "android_gps_mps": android_gps,
        "dashboard_path_mps": dashboard_path,
        "old_instant_mps": old_course_view,
    }


def render_html(meta: dict, start_t: int, end_t: int, series: dict) -> str:
    start_iso = datetime.fromtimestamp(start_t / 1000, tz=timezone.utc).astimezone().strftime("%H:%M:%S %Z")
    end_iso = datetime.fromtimestamp(end_t / 1000, tz=timezone.utc).astimezone().strftime("%H:%M:%S %Z")
    data_json = json.dumps({"meta": meta, "start_t": start_t, "end_t": end_t, "series": series})
    path_vals = [v for v in series["dashboard_path_mps"] if v is not None]
    gps_vals = [v for v in series["android_gps_mps"] if v is not None and v >= 0.25]
    summary = ""
    if path_vals and gps_vals:
        summary = (
            f"Dashboard path avg {split500(sum(path_vals)/len(path_vals))} · "
            f"Raw GPS avg {split500(sum(gps_vals)/len(gps_vals))}"
        )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>W2x EH — 1 min speed zoom</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    body {{ margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #0f1419; color: #e8edf2; padding: 20px; }}
    h1 {{ font-size: 1.2rem; margin: 0 0 6px; }}
    .sub {{ color: #8b98a5; margin-bottom: 16px; }}
    .panel {{ background: #171d24; border: 1px solid #2a3440; border-radius: 10px; padding: 16px; }}
    canvas {{ width: 100% !important; height: 360px !important; }}
    .note {{ color: #8b98a5; font-size: 12px; margin-top: 12px; }}
  </style>
</head>
<body>
  <h1>W2x EH — 1 minute zoom</h1>
  <p class="sub">{start_iso} → {end_iso} · {summary}</p>
  <div class="panel">
    <canvas id="chart"></canvas>
    <p class="note">
      <strong>Orange</strong> = raw Android GPS speed from device (often near zero at 1 Hz).<br>
      <strong>Green</strong> = dashboard view (60s path pace / <code>pathSpeedMps</code> — what Course view shows after today&apos;s fix).<br>
      <strong>Red dashed</strong> = old course-view instant segment speed (what caused the jumping % before the fix).
    </p>
  </div>
  <script>
    const payload = {data_json};
    const s = payload.series;
    const tooltipSplit = (v) => {{
      if (v == null || !Number.isFinite(v) || v < 0.25) return '—';
      const sec = 500 / v;
      const mm = Math.floor(sec / 60);
      const ss = (sec % 60).toFixed(1).padStart(4, '0');
      return mm + ':' + ss + '/500';
    }};
    new Chart(document.getElementById('chart'), {{
      type: 'line',
      data: {{
        labels: s.sec.map(v => v.toFixed(0) + 's'),
        datasets: [
          {{ label: 'Raw GPS (device)', data: s.android_gps_mps, borderColor: '#f97316', borderWidth: 1.5, pointRadius: 2, spanGaps: false }},
          {{ label: 'Dashboard path pace (60s)', data: s.dashboard_path_mps, borderColor: '#a3e635', borderWidth: 2.5, pointRadius: 0, spanGaps: false }},
          {{ label: 'Old instant (pre-fix course view)', data: s.old_instant_mps, borderColor: '#ef4444', borderWidth: 1, borderDash: [6,4], pointRadius: 0, spanGaps: false }},
        ],
      }},
      options: {{
        responsive: true,
        maintainAspectRatio: false,
        interaction: {{ mode: 'index', intersect: false }},
        plugins: {{
          legend: {{ labels: {{ color: '#e8edf2' }} }},
          tooltip: {{
            callbacks: {{
              label(ctx) {{
                const v = ctx.parsed.y;
                return ctx.dataset.label + ': ' + (v == null ? '—' : v.toFixed(2) + ' m/s (' + tooltipSplit(v) + ')');
              }}
            }}
          }}
        }},
        scales: {{
          x: {{ title: {{ display: true, text: 'Seconds into 1-min window', color: '#8b98a5' }}, ticks: {{ color: '#8b98a5' }}, grid: {{ color: '#2a3440' }} }},
          y: {{ title: {{ display: true, text: 'Speed (m/s)', color: '#8b98a5' }}, min: 0, suggestedMax: 6, ticks: {{ color: '#8b98a5' }}, grid: {{ color: '#2a3440' }} }},
        }},
      }},
    }});
  </script>
</body>
</html>
"""


def main() -> None:
    parser = argparse.ArgumentParser(description="W2x EH 1-min speed comparison graph")
    parser.add_argument(
        "--which",
        type=int,
        default=0,
        help="0=latest steady minute, 1=previous, 2=earlier, ...",
    )
    parser.add_argument(
        "--at",
        type=str,
        default="",
        help="Pick steady minute closest to local HH:MM[:SS] (e.g. 08:10)",
    )
    parser.add_argument(
        "--out",
        type=str,
        default="",
        help="Output HTML filename under assets/crewsight/",
    )
    args = parser.parse_args()

    meta, gps = load_gps_track()
    windows = list_steady_minutes(gps)
    start_t, end_t = pick_minute(gps, args.which, args.at or None)
    series = build_minute_series(gps, start_t, end_t)
    if len(series["sec"]) < 5:
        raise SystemExit("Not enough points in 1-min window")

    start_local = datetime.fromtimestamp(start_t / 1000, tz=timezone.utc).astimezone()
    end_local = datetime.fromtimestamp(end_t / 1000, tz=timezone.utc).astimezone()
    which_note = f" (steady window #{len(windows) - args.which} of {len(windows)})" if windows else ""
    print(f"Window: {start_local.strftime('%H:%M:%S')} -> {end_local.strftime('%H:%M:%S')} ({len(series['sec'])} points){which_note}")

    out_name = args.out or (
        "w2x-eh-speed-1min.html"
        if args.which == 0 and not args.at
        else f"w2x-eh-speed-1min-{args.at.replace(':', '')}.html"
        if args.at
        else f"w2x-eh-speed-1min-{args.which + 1}.html"
    )
    out_path = ASSETS / out_name
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render_html(meta, start_t, end_t, series), encoding="utf-8")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
