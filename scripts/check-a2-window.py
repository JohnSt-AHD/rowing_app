#!/usr/bin/env python3
"""Check A2 GPS data for a local NZ time window."""
import json
import statistics
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = "A2"
NZ = timezone(timedelta(hours=12))


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.load(r)


def to_ms(t):
    if t is None:
        return None
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def analyze_window(start_local: datetime, end_local: datetime) -> None:
    start_utc = start_local.astimezone(timezone.utc)
    end_utc = end_local.astimezone(timezone.utc)
    print(f"Window local: {start_local.strftime('%Y-%m-%d %H:%M')} – {end_local.strftime('%H:%M')} NZST")
    print(
        f"Window UTC:   {start_utc.isoformat().replace('+00:00', 'Z')} – "
        f"{end_utc.isoformat().replace('+00:00', 'Z')}"
    )

    print("\n=== Recent A2 sessions ===")
    sess = get(f"/api/history?list=sessions&uniqueId={UID}")
    for s in sess.get("sessions", [])[:8]:
        st_ms = to_ms(s["started_at"])
        local = datetime.fromtimestamp(st_ms / 1000, tz=NZ).strftime("%Y-%m-%d %H:%M:%S")
        print(
            f"  {s['session_id'][:8]}  local_start={local}  "
            f"utc={s['started_at']}  samples={s.get('sample_count', '?')}"
        )

    from_iso = start_utc.isoformat().replace("+00:00", "Z")
    to_iso = end_utc.isoformat().replace("+00:00", "Z")
    route = get(f"/api/history?uniqueId={UID}&from={quote(from_iso)}&to={quote(to_iso)}")

    pts = []
    for pt in route:
        if not isinstance(pt, dict):
            continue
        lat, lon = pt.get("lat"), pt.get("lon")
        if lat is None or lon is None:
            continue
        ms = to_ms(pt.get("t") or pt.get("time"))
        if ms is None:
            continue
        pts.append({"t": ms, "lat": lat, "lon": lon, "spd": pt.get("spd"), "acc": pt.get("acc")})
    pts.sort(key=lambda p: p["t"])

    if not pts:
        print(f"\nNo GPS in exact window — searching ±2h local...")
        wide_start = (start_local - timedelta(hours=2)).astimezone(timezone.utc)
        wide_end = (end_local + timedelta(hours=2)).astimezone(timezone.utc)
        route2 = get(
            f"/api/history?uniqueId={UID}&from={quote(wide_start.isoformat().replace('+00:00', 'Z'))}"
            f"&to={quote(wide_end.isoformat().replace('+00:00', 'Z'))}"
        )
        for pt in route2:
            if not isinstance(pt, dict):
                continue
            lat, lon = pt.get("lat"), pt.get("lon")
            if lat is None:
                continue
            ms = to_ms(pt.get("t") or pt.get("time"))
            local = datetime.fromtimestamp(ms / 1000, tz=NZ)
            if start_local <= local <= end_local:
                pts.append(
                    {
                        "t": ms,
                        "lat": lat,
                        "lon": lon,
                        "spd": pt.get("spd"),
                        "acc": pt.get("acc"),
                    }
                )
        pts.sort(key=lambda p: p["t"])

    print(f"\n=== GPS in window ({len(pts)} fixes) ===")
    if not pts:
        print("No GPS points found for A2 in that period.")
        return

    gaps = [(pts[i]["t"] - pts[i - 1]["t"]) / 1000 for i in range(1, len(pts))]
    dur = (pts[-1]["t"] - pts[0]["t"]) / 1000
    dist = 0.0
    for i in range(1, len(pts)):
        dlat = (pts[i]["lat"] - pts[i - 1]["lat"]) * 111320
        dlon = (pts[i]["lon"] - pts[i - 1]["lon"]) * 111320 * 0.85
        dist += (dlat**2 + dlon**2) ** 0.5

    print(f"Duration: {dur:.0f}s   fixes: {len(pts)}   avg: {len(pts) / max(dur, 1):.2f} Hz")
    print(f"Distance (approx): {dist:.0f} m")
    if gaps:
        p95 = sorted(gaps)[min(len(gaps) - 1, int(len(gaps) * 0.95))]
        print(
            f"Gaps: median={statistics.median(gaps):.2f}s  p95={p95:.2f}s  "
            f"max={max(gaps):.1f}s  >10s={sum(1 for g in gaps if g > 10)}"
        )

    local0 = datetime.fromtimestamp(pts[0]["t"] / 1000, tz=NZ)
    local1 = datetime.fromtimestamp(pts[-1]["t"] / 1000, tz=NZ)
    print(f"First fix: {local0.strftime('%H:%M:%S')}   last: {local1.strftime('%H:%M:%S')} NZST")
    print(
        f"Lat {min(p['lat'] for p in pts):.5f}..{max(p['lat'] for p in pts):.5f}  "
        f"Lon {min(p['lon'] for p in pts):.5f}..{max(p['lon'] for p in pts):.5f}"
    )
    print("Sample track:")
    step = max(1, len(pts) // 8)
    for p in pts[::step][:10]:
        lt = datetime.fromtimestamp(p["t"] / 1000, tz=NZ).strftime("%H:%M:%S")
        print(f"  {lt}  {p['lat']:.6f}  {p['lon']:.6f}  acc={p.get('acc')}")


if __name__ == "__main__":
    # Default: 30 Jun 2026 07:20–07:30 NZST
    y, m, d = 2026, 6, 30
    if len(sys.argv) >= 4:
        y, m, d = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
    start = datetime(y, m, d, 7, 20, tzinfo=NZ)
    end = datetime(y, m, d, 7, 30, tzinfo=NZ)
    analyze_window(start, end)
