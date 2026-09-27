import json, math, urllib.request
from collections import Counter
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"
HDR = {"Authorization": "Bearer rnz", "Accept": "application/json"}
UID = "W2x EH"
NZ = timezone(timedelta(hours=12))

def fetch(path):
    req = urllib.request.Request(BASE + path, headers=HDR)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())

def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlon/2)**2
    return 2*R*math.asin(min(1, math.sqrt(a)))

def parse_pos(p):
    t_str = p.get("fixTime") or p.get("deviceTime")
    t_ms = int(datetime.fromisoformat(t_str.replace("Z", "+00:00")).timestamp() * 1000)
    return {
        "t_ms": t_ms,
        "lat": float(p["latitude"]),
        "lon": float(p["longitude"]),
        "acc": p.get("accuracy"),
        "speed": p.get("speed"),
        "id": p.get("id"),
    }

def nz_fmt(t_ms):
    return datetime.fromtimestamp(t_ms/1000, tz=NZ).strftime("%Y-%m-%d %H:%M:%S NZ")

def analyze_day(label, from_iso, to_iso):
    q_uid = quote(UID)
    route = fetch(f"/api/history?uniqueId={q_uid}&from={quote(from_iso)}&to={quote(to_iso)}")
    try:
        dash = fetch(f"/api/history?format=dashboard&uniqueId={q_uid}&from={quote(from_iso)}&to={quote(to_iso)}")
    except Exception as e:
        dash = {"error": str(e)}

    if isinstance(route, dict) and not isinstance(route, list):
        return {"label": label, "error": route}

    pts = [parse_pos(p) for p in route]
    pts.sort(key=lambda x: x["t_ms"])

    gaps = []
    dup_ts = 0
    for i in range(1, len(pts)):
        dt = (pts[i]["t_ms"] - pts[i-1]["t_ms"]) / 1000.0
        gaps.append(round(dt, 3))
        if pts[i]["t_ms"] == pts[i-1]["t_ms"]:
            dup_ts += 1

    gap_counter = Counter(gaps)
    gap_bucket = Counter()
    for g in gaps:
        if g <= 0.001:
            gap_bucket["0s dup"] += 1
        elif g <= 1.25:
            gap_bucket["~1s"] += 1
        elif g <= 1.75:
            gap_bucket["~2s"] += 1
        elif g <= 2.75:
            gap_bucket["~3s"] += 1
        elif g <= 5.5:
            gap_bucket["~4-5s"] += 1
        else:
            gap_bucket[">5s"] += 1

    def find_spikes(thresh_m, max_dt=5.0):
        spikes = []
        for i in range(1, len(pts)):
            dt = (pts[i]["t_ms"] - pts[i-1]["t_ms"]) / 1000.0
            if dt <= 0 or dt > max_dt:
                continue
            d = haversine_m(pts[i-1]["lat"], pts[i-1]["lon"], pts[i]["lat"], pts[i]["lon"])
            if d > thresh_m:
                implied = d / dt if dt > 0 else 0
                spikes.append({
                    "i": i,
                    "time_nz": nz_fmt(pts[i]["t_ms"]),
                    "t_ms": pts[i]["t_ms"],
                    "dist_m": round(d, 1),
                    "gap_s": round(dt, 3),
                    "acc_prev": pts[i-1]["acc"],
                    "acc": pts[i]["acc"],
                    "speed_prev": pts[i-1]["speed"],
                    "speed": pts[i]["speed"],
                    "dup_ts": pts[i]["t_ms"] == pts[i-1]["t_ms"],
                    "implied_mps": round(implied, 2),
                })
        return spikes

    spikes50 = find_spikes(50)
    spikes30 = find_spikes(30)
    spikes20 = find_spikes(20)

    def cluster(spikes):
        if not spikes:
            return []
        clusters = []
        cur = [spikes[0]]
        for s in spikes[1:]:
            if s["t_ms"] - cur[-1]["t_ms"] <= 120_000:
                cur.append(s)
            else:
                clusters.append(cur)
                cur = [s]
        clusters.append(cur)
        return clusters

    clusters = cluster(spikes50)
    acc_bad = sum(1 for s in spikes50 if (s["acc"] or 0) >= 20 or (s["acc_prev"] or 0) >= 20)
    acc_very_bad = sum(1 for s in spikes50 if (s["acc"] or 0) >= 50 or (s["acc_prev"] or 0) >= 50)
    dup_spike = sum(1 for s in spikes50 if s["dup_ts"])
    gap_at_spike = Counter(round(s["gap_s"], 1) for s in spikes50)
    speed_anom = sum(1 for s in spikes50 if s["speed"] is not None and float(s["speed"]) > 15)

    accs_f = [float(p["acc"]) for p in pts if p["acc"] is not None]

    dash_info = {}
    if isinstance(dash, dict) and dash.get("ok"):
        tr = dash.get("track") or []
        keys = set()
        for pt in tr[:20]:
            keys |= set(pt.keys())
        t_vals = [pt.get("t") for pt in tr if pt.get("t")]
        dash_gaps = [(t_vals[i]-t_vals[i-1])/1000 for i in range(1, len(t_vals))]
        dash_info = {
            "pointCount": dash.get("pointCount"),
            "gpsCount": dash.get("gpsCount"),
            "downsampled": dash.get("downsampled"),
            "track_len": len(tr),
            "track_keys": sorted(keys),
            "has_acc": "acc" in keys or "accuracy" in keys,
            "dash_gap_top": gap_counter.most_common(0) if False else dict(Counter(round(g,1) for g in dash_gaps).most_common(15)),
        }
    else:
        dash_info = {"raw": dash if isinstance(dash, dict) else str(dash)[:300]}

    burst_summaries = []
    for ci, cl in enumerate(clusters):
        accs_cl = []
        for s in cl:
            if s["acc_prev"] is not None: accs_cl.append(float(s["acc_prev"]))
            if s["acc"] is not None: accs_cl.append(float(s["acc"]))
        burst_summaries.append({
            "burst": ci+1,
            "start_nz": cl[0]["time_nz"],
            "end_nz": cl[-1]["time_nz"],
            "spike_count": len(cl),
            "max_jump_m": max(s["dist_m"] for s in cl),
            "gaps_s": sorted(set(s["gap_s"] for s in cl)),
            "acc_minmax": [round(min(accs_cl),1), round(max(accs_cl),1)] if accs_cl else None,
        })

    pts_per_hour = {}
    for p in pts:
        h = datetime.fromtimestamp(p["t_ms"]/1000, tz=NZ).strftime("%H:00")
        pts_per_hour[h] = pts_per_hour.get(h, 0) + 1

    return {
        "label": label,
        "from": from_iso,
        "to": to_iso,
        "route_points": len(pts),
        "pts_per_hour_nz": pts_per_hour,
        "time_span_min": round((pts[-1]["t_ms"]-pts[0]["t_ms"])/60000, 1) if len(pts)>1 else 0,
        "gap_bucket": dict(gap_bucket),
        "top_gaps_exact": gap_counter.most_common(12),
        "dup_consecutive_ts": dup_ts,
        "acc_median": round(sorted(accs_f)[len(accs_f)//2], 1) if accs_f else None,
        "acc_p90": round(sorted(accs_f)[int(len(accs_f)*0.9)], 1) if accs_f else None,
        "acc_max": round(max(accs_f), 1) if accs_f else None,
        "teleport_50": len(spikes50),
        "teleport_30": len(spikes30),
        "teleport_20": len(spikes20),
        "burst_count_50": len(clusters),
        "bursts": burst_summaries,
        "spike50_gap_dist": dict(gap_at_spike),
        "spike50_acc_ge20": acc_bad,
        "spike50_acc_ge50": acc_very_bad,
        "spike50_dup_ts": dup_spike,
        "spike50_speed_gt15": speed_anom,
        "all_spikes50": spikes50,
        "dash": dash_info,
    }

windows = [
    ("Jul23 morning", "2026-07-23T06:00:00+12:00", "2026-07-23T12:00:00+12:00"),
    ("Jul24 morning", "2026-07-24T06:00:00+12:00", "2026-07-24T12:00:00+12:00"),
]

results = []
for w in windows:
    print("Fetching", w[0], "...")
    results.append(analyze_day(*w))

out_path = r"c:\Users\JohnSt\Desktop\RNZ\Rowing_App\scripts\_w2x-eh-teleport-analysis.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2)

for r in results:
    print("\n" + "="*60)
    print(r["label"])
    if r.get("error"):
        print("ERROR", r["error"])
        continue
    print(f"route_points={r['route_points']} span_min={r['time_span_min']}")
    print("pts_per_hour", r["pts_per_hour_nz"])
    print("gap_bucket", r["gap_bucket"])
    print("top_gaps", r["top_gaps_exact"][:8])
    print(f"teleports 50/30/20m: {r['teleport_50']}/{r['teleport_30']}/{r['teleport_20']} bursts={r['burst_count_50']}")
    print(f"acc median/p90/max: {r['acc_median']}/{r['acc_p90']}/{r['acc_max']} dup_ts_pairs={r['dup_consecutive_ts']}")
    print("spike correlations:", {k:r[k] for k in ["spike50_gap_dist","spike50_acc_ge20","spike50_acc_ge50","spike50_dup_ts","spike50_speed_gt15"]})
    print("bursts:", json.dumps(r["bursts"], indent=2))
    print("dash:", json.dumps(r["dash"], indent=2))

if len(results)==2 and not results[0].get("error") and not results[1].get("error"):
    ratio = results[1]["route_points"] / max(results[0]["route_points"],1)
    print("\n=== COMPARISON ===")
    print(f"Jul24/Jul23 route point ratio: {ratio:.2f}x")
    for label, res in zip(["Jul23","Jul24"], results):
        total_gaps = sum(res["gap_bucket"].values())
        for k in ["~1s","~2s","~3s"]:
            print(f"  {label} {k}: {res['gap_bucket'].get(k,0)} ({100*res['gap_bucket'].get(k,0)/max(total_gaps,1):.1f}%)")

print("\nWrote", out_path)
