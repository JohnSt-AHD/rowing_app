#!/usr/bin/env python3
"""Poll named devices until speed + stroke look steady."""

import json
import math
import statistics
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEFAULT_UIDS = ["W2x EH", "M1x TM"]
POLL_SEC = 5
MAX_POLLS = 36
WINDOW = 6
MIN_MAP_MPS = 1.8
MIN_STROKE = 18
MAX_SPEED_CV = 0.22
MAX_STROKE_CV = 0.12
MAX_STROKE_RANGE = 6
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}


def get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(s):
    if s is None or s < 0.25:
        return "—"
    sec = 500 / float(s)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def path_speed_last(track, sec=90):
    pts = [p for p in track if p.get("lat") is not None and p.get("lon") is not None and p.get("t")]
    if len(pts) < 2:
        return None
    end_t = pts[-1]["t"]
    recent = [p for p in pts if p["t"] >= end_t - sec * 1000]
    if len(recent) < 2:
        return None
    dist = sum(
        haversine_m(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"])
        for i in range(1, len(recent))
    )
    span = (recent[-1]["t"] - recent[0]["t"]) / 1000
    return dist / span if span > 0 else None


def cv(values):
    if len(values) < 2:
        return None
    m = statistics.mean(values)
    if m <= 0:
        return None
    return statistics.pstdev(values) / m


def is_steady(history):
    if len(history) < WINDOW:
        return False, "warming up"
    win = history[-WINDOW:]
    speeds = [h["path_mps"] or h["map_mps"] for h in win if (h["path_mps"] or h["map_mps"]) and (h["path_mps"] or h["map_mps"]) >= 0.25]
    strokes = [h["stroke"] for h in win if h["stroke"] is not None and h["stroke"] > 0]
    if len(speeds) < WINDOW - 1 or len(strokes) < WINDOW - 1:
        return False, "missing speed/stroke"
    sm = statistics.mean(speeds)
    stm = statistics.mean(strokes)
    scv = cv(speeds)
    stcv = cv(strokes)
    sr = max(strokes) - min(strokes)
    if sm < MIN_MAP_MPS:
        return False, f"pace easy ({split500(sm)})"
    if stm < MIN_STROKE:
        return False, f"stroke low ({stm:.0f} spm)"
    if scv is not None and scv > MAX_SPEED_CV:
        return False, f"speed varying (CV {scv:.0%})"
    if stcv is not None and stcv > MAX_STROKE_CV:
        return False, f"rate varying (CV {stcv:.0%})"
    if sr > MAX_STROKE_RANGE:
        return False, f"stroke range {sr:.0f} spm"
    return True, f"STEADY ~{split500(sm)} at ~{stm:.0f} spm"


def fetch_all(uids):
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    devs = get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get("devices", [])
    pos_by = {x.get("deviceId"): x for x in mp.get("positions", [])}
    dev_by = {x.get("deviceId"): x for x in devs}
    out = {}
    for uid in uids:
        p = pos_by.get(uid)
        d = dev_by.get(uid)
        row = (d or {}).get("rowing") or {}
        out[uid] = {
            "p": p,
            "d": d,
            "row": row,
            "map_mps": p.get("speed") if p else None,
            "path_mps": p.get("pathSpeedMps") if p else None,
            "disp_mps": p.get("displaySpeedMps") if p else None,
            "raw_mps": (((d or {}).get("gps") or {}).get("last") or {}).get("spd"),
            "stroke": row.get("strokeRate") or (p.get("strokeRate") if p else None),
            "seen": d.get("lastSeenAgoSec") if d else None,
            "stale": p.get("telemetryStale") if p else None,
        }
    return out


def path_speed_for(uid):
    now = datetime.now(timezone.utc)
    frm = datetime.fromtimestamp(now.timestamp() - 120, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    to = now.isoformat().replace("+00:00", "Z")
    enc = urllib.parse.quote(uid, safe="")
    track = get(
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    ).get("track") or []
    return path_speed_last(track, 90)


def main():
    uids = sys.argv[1:] if len(sys.argv) > 1 else DEFAULT_UIDS
    print(f"=== Polling {', '.join(uids)} every {POLL_SEC}s (max {MAX_POLLS * POLL_SEC}s) ===")
    print(f"Steady = path/display pace CV <= {MAX_SPEED_CV:.0%}, stroke CV <= {MAX_STROKE_CV:.0%}\n")

    history = {uid: [] for uid in uids}
    steady_at = {uid: None for uid in uids}
    all_done = False

    for i in range(MAX_POLLS):
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        try:
            snap = fetch_all(uids)
        except Exception as e:
            print(f"[{i}] {ts} ERROR: {e}")
            time.sleep(POLL_SEC)
            continue

        print(f"[{i:2d}] {ts}")
        for uid in uids:
            s = snap[uid]
            p, d = s["p"], s["d"]
            if not p and not d:
                print(f"  {uid}: offline")
                continue

            path90 = path_speed_for(uid) if i % 3 == 0 else None
            history[uid].append(
                {
                    "map_mps": s["map_mps"],
                    "path_mps": s["path_mps"] or s["disp_mps"],
                    "raw_mps": s["raw_mps"],
                    "stroke": s["stroke"],
                    "path90": path90,
                }
            )

            ok, reason = is_steady(history[uid])
            path_note = f" path90={path90:.2f}({split500(path90)})" if path90 else ""
            pace = s["path_mps"] or s["disp_mps"] or s["map_mps"]
            print(
                f"  {uid}: path={split500(s['path_mps'])} disp={split500(s['disp_mps'])} "
                f"raw={split500(s['raw_mps'])} map={split500(s['map_mps'])} "
                f"stroke={s['stroke']} seen={s['seen']}s{path_note} -> {reason}"
            )

            if ok and steady_at[uid] is None:
                steady_at[uid] = i
                win = history[uid][-WINDOW:]
                speeds = [h["path_mps"] or h["map_mps"] for h in win if (h["path_mps"] or h["map_mps"])]
                strokes = [h["stroke"] for h in win if h["stroke"]]
                print(
                    f"    *** {uid} STEADY at poll {i}: "
                    f"~{split500(statistics.mean(speeds))} @ ~{statistics.mean(strokes):.0f} spm ***"
                )

        confirmed = [u for u in uids if steady_at[u] is not None and i >= steady_at[u] + 4]
        if len(confirmed) == len(uids):
            print("\nAll devices confirmed steady — stopping.")
            break

        time.sleep(POLL_SEC)

    print("\n=== Summary ===")
    for uid in uids:
        if steady_at[uid] is not None:
            win = history[uid][steady_at[uid] : steady_at[uid] + WINDOW]
            speeds = [h["path_mps"] or h["map_mps"] for h in win if (h["path_mps"] or h["map_mps"])]
            strokes = [h["stroke"] for h in win if h["stroke"]]
            path90s = [h["path90"] for h in history[uid][steady_at[uid] :] if h.get("path90")]
            print(
                f"{uid}: STEADY ~{split500(statistics.mean(speeds))} @ ~{statistics.mean(strokes):.0f} spm "
                f"(first at poll {steady_at[uid]})"
            )
            if path90s:
                print(f"  GPS path 90s at steady: {statistics.mean(path90s):.2f} m/s ({split500(statistics.mean(path90s))}/500)")
        else:
            hist = history[uid]
            speeds = [h["path_mps"] or h["map_mps"] for h in hist if (h["path_mps"] or h["map_mps"]) and (h["path_mps"] or h["map_mps"]) >= 0.5]
            strokes = [h["stroke"] for h in hist if h["stroke"]]
            if speeds:
                print(
                    f"{uid}: no steady window — session avg path/map {split500(statistics.mean(speeds))}, "
                    f"stroke ~{statistics.mean(strokes):.0f} spm"
                )
            else:
                print(f"{uid}: no steady piece detected (mostly easy/off)")


if __name__ == "__main__":
    main()
