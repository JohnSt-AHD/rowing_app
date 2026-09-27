#!/usr/bin/env python3
"""Analyze RNZ fleet GPS accuracy, reporting intervals, and map latency."""
import json
import statistics
import urllib.request
from collections import Counter

BASE = "https://rowing-app-recorder-pwa.vercel.app"
HDR = {"Authorization": "Bearer rnz", "Accept": "application/json"}


def get(path: str):
    req = urllib.request.Request(BASE + path, headers=HDR)
    with urllib.request.urlopen(req, timeout=120) as r:
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
    steady = [g for g in all_gaps if g >= 0.75]

    def pct(lo, hi, gaps):
        return 100 * sum(1 for g in gaps if lo <= g <= hi) / len(gaps) if gaps else 0

    med = statistics.median(steady) if steady else None
    pct1 = pct(0.75, 1.35, steady)
    pct2 = pct(1.65, 2.35, steady)
    pct5 = pct(4.0, 6.5, steady)
    top = Counter(round(g, 2) for g in steady).most_common(5) if steady else []
    if pct1 >= max(pct2, pct5, 30):
        detected = "1s"
    elif pct2 >= max(pct1, pct5, 30):
        detected = "2s"
    elif pct5 >= 30:
        detected = "5s"
    else:
        detected = f"~{med:.1f}s" if med else "?"
    return {
        "points": len(tr),
        "dur_min": (tr[-1]["t"] - tr[0]["t"]) / 60000,
        "steady_med": round(med, 2) if med else None,
        "steady_mean": round(statistics.mean(steady), 2) if steady else None,
        "pct_1s": round(pct1, 1),
        "pct_2s": round(pct2, 1),
        "pct_5s": round(pct5, 1),
        "top_gaps": top,
        "detected": detected,
    }


def acc_stats(tr):
    accs = [
        float(p["acc"])
        for p in tr
        if p.get("lat") is not None and p.get("acc") is not None
    ]
    if not accs:
        return None
    accs.sort()
    return {
        "n": len(accs),
        "median": round(statistics.median(accs), 2),
        "mean": round(statistics.mean(accs), 2),
        "p95": round(accs[int(0.95 * len(accs))], 2),
        "max": round(max(accs), 2),
    }


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6_371_000
    from math import asin, cos, radians, sin, sqrt

    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * r * asin(sqrt(a))


def cluster_spread_m(tr, radius_m=200):
    pts = [(p["lat"], p["lon"]) for p in tr if p.get("lat") is not None]
    if len(pts) < 2:
        return None
    med_lat = statistics.median([p[0] for p in pts])
    med_lon = statistics.median([p[1] for p in pts])
    near = [
        haversine_m(med_lat, med_lon, lat, lon)
        for lat, lon in pts
        if haversine_m(med_lat, med_lon, lat, lon) <= radius_m
    ]
    if len(near) < 2:
        return None
    return round(max(near), 1)


def route_acc_stats(positions):
    accs = [float(p["accuracy"]) for p in positions if p.get("accuracy") not in (None, 0)]
    if not accs:
        return None
    accs.sort()
    return {
        "n": len(accs),
        "median": round(statistics.median(accs), 2),
        "mean": round(statistics.mean(accs), 2),
        "p95": round(accs[int(0.95 * len(accs))], 2),
        "max": round(max(accs), 2),
    }


def main():
    print("=== RNZ 5-device test analysis ===\n")
    dev_resp = get("/api/devices?windowSec=60&onlineSec=120")
    live_by_id = {d["deviceId"]: d for d in dev_resp.get("devices", [])}
    device_ids = sorted(live_by_id.keys())
    rows = []

    for did in device_ids:
        d = live_by_id[did]
        gps = d.get("gps") or {}
        last = gps.get("last") or {}

        sessions = get(f"/api/history?list=sessions&uniqueId={did}").get("sessions") or []
        sid = sessions[0]["session_id"] if sessions else d.get("sessionId")

        print(f"--- {did} ---")
        print(
            f"  session={sid[:8] if sid else '?'}...  live_samples={d.get('totalSamples')}  online={d.get('online')}"
        )
        print(
            f"  last fix acc={last.get('acc')} m  fixClockLag={gps.get('fixClockLagSec')} s"
            f"  displayAge={gps.get('displayAgeSec')} s"
        )
        if not sid:
            print("  (no persisted session)\n")
            continue

        dash = get(f"/api/history?format=dashboard&sessionId={sid}")
        track = dash.get("track") or []
        gps_pts = [p for p in track if p.get("lat") is not None]
        gs = gap_stats(gps_pts)
        spread = cluster_spread_m(gps_pts)

        route = []
        uid = dash.get("uniqueId") or did
        from_iso = dash.get("from")
        to_iso = dash.get("to")
        if from_iso and to_iso:
            from urllib.parse import quote

            route = get(
                f"/api/history?uniqueId={quote(uid)}&from={quote(from_iso)}&to={quote(to_iso)}"
            )
        ac = route_acc_stats(route) if route else acc_stats(gps_pts)

        if gs:
            eff_hz = gs["points"] / (gs["dur_min"] * 60) if gs["dur_min"] > 0 else 0
            print(f"  GPS fixes={gs['points']}  duration={gs['dur_min']:.1f} min")
            print(
                f"  reporting: detected={gs['detected']}  med_gap={gs['steady_med']} s"
                f"  mean={gs['steady_mean']} s"
            )
            print(
                f"  gap bands: 1s={gs['pct_1s']}%  2s={gs['pct_2s']}%  5s={gs['pct_5s']}%"
                f"  top={gs['top_gaps']}"
            )
            print(f"  effective GPS rate: {eff_hz:.2f} Hz")
            rows.append((did, gs["detected"], gs["steady_med"], ac, eff_hz))

        if ac:
            print(
                f"  accuracy: median={ac['median']} m  mean={ac['mean']} m"
                f"  p95={ac['p95']} m  max={ac['max']} m"
            )
        if spread is not None:
            print(f"  position jitter (within 200 m of median): ~{spread} m")
        outliers = len(route) - (ac["n"] if ac else 0) if route else 0
        if route and len(route) != len(gps_pts):
            print(f"  route points with accuracy: {len(route)}")
        print()

    print("=== Summary table ===")
    print(f"{'Device':<6} {'Interval':<8} {'Med gap':<8} {'Acc med':<10} {'GPS Hz':<8}")
    for did, det, med, ac, hz in rows:
        acc_med = f"{ac['median']} m" if ac else "?"
        print(f"{did:<6} {det:<8} {med or '?':<8} {acc_med:<10} {hz:.2f}")

    mp = get("/api/map-positions")
    print("\n=== Map positions (raw last fix) ===")
    pts = {}
    for p in sorted(mp.get("positions", []), key=lambda x: x.get("deviceId", "")):
        did = p.get("deviceId")
        pts[did] = p
        print(
            f"  {did}: acc={p.get('accuracy')} m"
            f"  online={p.get('online')}"
        )

    print("\n=== Inter-device separation (last fix) ===")
    ids = sorted(pts)
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            pa, pb = pts[a], pts[b]
            d = haversine_m(pa["latitude"], pa["longitude"], pb["latitude"], pb["longitude"])
            print(f"  {a} <-> {b}: {d:.1f} m")

    print("\n=== Accuracy with outliers removed (acc <= 15 m) ===")
    for did in ids:
        sessions = get(f"/api/history?list=sessions&uniqueId={did}").get("sessions") or []
        if not sessions:
            continue
        sid = sessions[0]["session_id"]
        dash = get(f"/api/history?format=dashboard&sessionId={sid}")
        from urllib.parse import quote

        route = get(
            f"/api/history?uniqueId={quote(did)}&from={quote(dash['from'])}&to={quote(dash['to'])}"
        )
        all_a = [p["accuracy"] for p in route if p.get("accuracy")]
        good = [a for a in all_a if a <= 15]
        if not all_a:
            continue
        pct = 100 * len(good) / len(all_a)
        line = f"  {did}: {len(good)}/{len(all_a)} fixes ({pct:.1f}%) acc<=15m"
        if good:
            good.sort()
            line += f"  med={statistics.median(good):.2f}m  p95={good[int(0.95 * len(good))]:.2f}m"
        print(line)


if __name__ == "__main__":
    main()
