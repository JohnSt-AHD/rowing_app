#!/usr/bin/env python3
"""Build speed comparison charts for W2x EH session (raw GPS, segment, map track, path pace)."""
from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
PATH_PACE_WINDOW_MS = 60_000
PATH_PACE_MIN_SEGMENT_M = 1
PATH_PACE_MAX_SEGMENT_MPS = 8
PATH_PACE_MIN_TIME_SEC = 8
PATH_PACE_MIN_DIST_M = 20
MAX_TRACK_SPEED_MPS = 25
OUT = Path(__file__).resolve().parent.parent / "assets" / "crewsight" / "w2x-eh-speed-graph.html"


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


def ema_alpha_for_accuracy(acc: float | None) -> float:
    if acc is None or not math.isfinite(acc):
        return 0.35
    if acc <= 8:
        return 0.55
    if acc <= 15:
        return 0.4
    if acc <= 30:
        return 0.28
    return 0.18


def reset_track_state(t: int, lat: float, lon: float, spd: float | None) -> dict:
    return {
        "t": t,
        "lat": lat,
        "lon": lon,
        "smooth_lat": lat,
        "smooth_lon": lon,
        "speed_mps": spd,
        "course_deg": None,
    }


def update_map_track(prev: dict | None, fix: dict) -> dict:
    lat, lon, t = fix["lat"], fix["lon"], fix["t"]
    gps_spd = fix.get("gps_spd")
    if prev is None:
        return reset_track_state(t, lat, lon, gps_spd)

    dt = (t - prev["t"]) / 1000
    if not math.isfinite(dt) or dt < 0:
        return prev
    if dt > 30:
        return reset_track_state(t, lat, lon, gps_spd)
    if dt == 0:
        out = dict(prev)
        out.update({"t": t, "lat": lat, "lon": lon, "smooth_lat": lat, "smooth_lon": lon})
        out["speed_mps"] = gps_spd if gps_spd is not None else prev["speed_mps"]
        return out

    jump_m = haversine_m(prev["lat"], prev["lon"], lat, lon)
    if jump_m / dt > MAX_TRACK_SPEED_MPS:
        return reset_track_state(t, lat, lon, gps_spd)

    speed_mps = jump_m / dt
    course_deg = bearing_deg(prev["lat"], prev["lon"], lat, lon)
    if gps_spd is not None and math.isfinite(gps_spd):
        if prev["speed_mps"] is not None:
            speed_mps = 0.85 * speed_mps + 0.15 * gps_spd
        else:
            speed_mps = speed_mps

    if prev["course_deg"] is not None and course_deg is not None:
        diff = ((course_deg - prev["course_deg"] + 540) % 360) - 180
        course_deg = (prev["course_deg"] + 0.35 * diff + 360) % 360

    alpha = ema_alpha_for_accuracy(fix.get("acc"))
    smooth_lat = alpha * lat + (1 - alpha) * prev["smooth_lat"]
    smooth_lon = alpha * lon + (1 - alpha) * prev["smooth_lon"]

    return {
        "t": t,
        "lat": lat,
        "lon": lon,
        "smooth_lat": smooth_lat,
        "smooth_lon": smooth_lon,
        "speed_mps": speed_mps,
        "course_deg": course_deg,
    }


def path_speed_mps(fixes: list[dict], end_t: int, window_ms: int = PATH_PACE_WINDOW_MS) -> float | None:
    cutoff = end_t - window_ms
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


def load_session_track() -> tuple[dict, list[dict]]:
    enc = urllib.parse.quote(UID, safe="")
    sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
    if not sessions:
        raise SystemExit(f"No sessions for {UID}")
    session = sessions[0]
    sid = session["session_id"]
    payload = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}")
    track = payload.get("track") or []
    gps = [
        {
            "t": p["t"],
            "lat": p["lat"],
            "lon": p["lon"],
            "gps_spd": p.get("speed"),
        }
        for p in track
        if p.get("lat") is not None and p.get("lon") is not None and p.get("t") is not None
    ]
    meta = {
        "session_id": sid,
        "unique_id": payload.get("uniqueId") or UID,
        "athlete_id": session.get("athlete_id"),
        "started_at": payload.get("from") or session.get("started_at"),
        "ended_at": payload.get("to"),
        "point_count": payload.get("pointCount"),
        "gps_count": payload.get("gpsCount"),
        "downsampled": payload.get("downsampled"),
        "plotted_points": len(gps),
    }
    return meta, gps


def build_series(gps: list[dict]) -> dict:
    t0 = gps[0]["t"]
    elapsed_min: list[float] = []
    android_gps: list[float | None] = []
    segment: list[float | None] = []
    map_track: list[float | None] = []
    path_pace: list[float | None] = []
    trace_dist_km: list[float] = []
    fixes_for_path: list[dict] = []
    prev_track = None
    cum_dist = 0.0

    for i, fix in enumerate(gps):
        fixes_for_path.append(fix)
        elapsed_min.append((fix["t"] - t0) / 60000)

        gps_spd = fix.get("gps_spd")
        android_gps.append(gps_spd if gps_spd is not None and gps_spd >= 0 else None)

        seg = None
        if i > 0:
            prev = gps[i - 1]
            dt = (fix["t"] - prev["t"]) / 1000
            if dt > 0:
                d = haversine_m(prev["lat"], prev["lon"], fix["lat"], fix["lon"])
                cum_dist += d
                seg = d / dt
        trace_dist_km.append(cum_dist / 1000)
        segment.append(seg)

        prev_track = update_map_track(prev_track, fix)
        map_track.append(prev_track["speed_mps"] if prev_track else None)
        path_pace.append(path_speed_mps(fixes_for_path, fix["t"]))

    return {
        "elapsed_min": elapsed_min,
        "trace_dist_km": trace_dist_km,
        "android_gps_mps": android_gps,
        "segment_mps": segment,
        "map_track_mps": map_track,
        "path_pace_mps": path_pace,
    }


def render_html(meta: dict, series: dict) -> str:
    data_json = json.dumps({"meta": meta, "series": series})
    started = meta.get("started_at", "")
    ended = meta.get("ended_at", "")
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>W2x EH speed comparison</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {{
      --bg: #0f1419;
      --panel: #171d24;
      --text: #e8edf2;
      --muted: #8b98a5;
      --grid: #2a3440;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font: 14px/1.45 system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px;
    }}
    h1 {{ font-size: 1.25rem; margin: 0 0 6px; }}
    .sub {{ color: var(--muted); margin-bottom: 18px; }}
    .panel {{
      background: var(--panel);
      border: 1px solid var(--grid);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 16px;
    }}
    .panel h2 {{ font-size: 1rem; margin: 0 0 4px; }}
    .caption {{ color: var(--muted); font-size: 12px; margin: 0 0 12px; }}
    canvas {{ width: 100% !important; height: 320px !important; }}
    .legend-note {{ color: var(--muted); font-size: 12px; margin-top: 10px; }}
  </style>
</head>
<body>
  <h1>W2x EH — speed comparison ({meta.get("unique_id")})</h1>
  <p class="sub">Session {meta.get("session_id")} · {started} to {ended} · {meta.get("plotted_points")} GPS points plotted (of {meta.get("gps_count")} total)</p>

  <div class="panel">
    <h2>Speed vs session time</h2>
    <p class="caption">Source: /api/history dashboard track · elapsed minutes from session start</p>
    <canvas id="timeChart"></canvas>
    <p class="legend-note">Android GPS = phone speed field · Segment = distance/time between fixes · Map track = server blend (85% segment + 15% GPS) · Path pace = 60s rolling distance/time (dashboard display pace)</p>
  </div>

  <div class="panel">
    <h2>Speed along GPS trace</h2>
    <p class="caption">Same metrics vs cumulative distance along the route (km)</p>
    <canvas id="traceChart"></canvas>
  </div>

  <script>
    const payload = {data_json};
    const s = payload.series;
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
              const split = (500 / v);
              const mm = Math.floor(split / 60);
              const ss = (split % 60).toFixed(1).padStart(4, '0');
              return ctx.dataset.label + ': ' + v.toFixed(2) + ' m/s (' + mm + ':' + ss + '/500)';
            }}
          }}
        }}
      }},
      scales: {{
        x: {{ ticks: {{ color: '#8b98a5' }}, grid: {{ color: '#2a3440' }} }},
        y: {{
          title: {{ display: true, text: 'Speed (m/s)', color: '#8b98a5' }},
          ticks: {{ color: '#8b98a5' }},
          grid: {{ color: '#2a3440' }},
          min: 0,
          suggestedMax: 6
        }}
      }}
    }};

    const datasets = [
      {{ label: 'Android GPS speed', data: s.android_gps_mps, borderColor: '#f97316', backgroundColor: 'transparent', borderWidth: 1.2, pointRadius: 0, spanGaps: false }},
      {{ label: 'Segment speed (raw)', data: s.segment_mps, borderColor: '#ef4444', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, spanGaps: false }},
      {{ label: 'Map track speed (smoothed)', data: s.map_track_mps, borderColor: '#38bdf8', backgroundColor: 'transparent', borderWidth: 1.6, pointRadius: 0, spanGaps: false }},
      {{ label: '60s path pace (display)', data: s.path_pace_mps, borderColor: '#a3e635', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, spanGaps: false }},
    ];

    new Chart(document.getElementById('timeChart'), {{
      type: 'line',
      data: {{ labels: s.elapsed_min.map(v => v.toFixed(2)), datasets: datasets.map(d => ({{ ...d, data: d.data }})) }},
      options: {{
        ...common,
        scales: {{
          ...common.scales,
          x: {{ ...common.scales.x, title: {{ display: true, text: 'Elapsed (minutes)', color: '#8b98a5' }} }}
        }}
      }}
    }});

    new Chart(document.getElementById('traceChart'), {{
      type: 'line',
      data: {{ labels: s.trace_dist_km.map(v => v.toFixed(3)), datasets: datasets.map(d => ({{ ...d }})) }},
      options: {{
        ...common,
        scales: {{
          ...common.scales,
          x: {{ ...common.scales.x, title: {{ display: true, text: 'Distance along trace (km)', color: '#8b98a5' }} }}
        }}
      }}
    }});
  </script>
</body>
</html>
"""


def main() -> None:
    meta, gps = load_session_track()
    if len(gps) < 2:
        raise SystemExit("Not enough GPS points")
    series = build_series(gps)

    # Summary stats for console
    valid_path = [v for v in series["path_pace_mps"] if v is not None]
    valid_map = [v for v in series["map_track_mps"] if v is not None and v >= 0.25]
    print(f"Session {meta['session_id']}")
    print(f"  GPS points plotted: {len(gps)}")
    if valid_path:
        print(f"  Path pace range: {split500(min(valid_path))} – {split500(max(valid_path))}")
    if valid_map:
        print(f"  Map track avg: {sum(valid_map)/len(valid_map):.2f} m/s ({split500(sum(valid_map)/len(valid_map))})")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render_html(meta, series), encoding="utf-8")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
