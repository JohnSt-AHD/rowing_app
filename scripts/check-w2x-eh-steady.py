#!/usr/bin/env python3
"""Poll W2x EH until speed + stroke look steady, or max duration."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
POLL_SEC = 5
MAX_POLLS = 36  # 3 min
WINDOW = 6  # last N polls for steady check

# Steady: low CV on map speed + stroke in recent window, both above minimums
MIN_MAP_MPS = 1.8
MIN_STROKE = 18
MAX_SPEED_CV = 0.22
MAX_STROKE_CV = 0.12
MAX_STROKE_RANGE = 6


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
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
        return False, "warming up (not enough samples)"
    win = history[-WINDOW:]
    speeds = [h["map_mps"] for h in win if h["map_mps"] is not None and h["map_mps"] >= 0.25]
    strokes = [h["stroke"] for h in win if h["stroke"] is not None and h["stroke"] > 0]
    if len(speeds) < WINDOW - 1 or len(strokes) < WINDOW - 1:
        return False, "missing speed/stroke samples"
    sm = statistics.mean(speeds)
    stm = statistics.mean(strokes)
    scv = cv(speeds)
    stcv = cv(strokes)
    sr = max(strokes) - min(strokes)
    if sm < MIN_MAP_MPS:
        return False, f"pace still easy ({split500(sm)})"
    if stm < MIN_STROKE:
        return False, f"stroke low ({stm:.0f} spm)"
    if scv is not None and scv > MAX_SPEED_CV:
        return False, f"speed still varying (CV {scv:.0%})"
    if stcv is not None and stcv > MAX_STROKE_CV:
        return False, f"rate still varying (CV {stcv:.0%})"
    if sr > MAX_STROKE_RANGE:
        return False, f"stroke range {sr:.0f} spm in window"
    return True, f"steady ~{split500(sm)} at ~{stm:.0f} spm"


def fetch():
    mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    d = next(
        (
            x
            for x in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get("devices", [])
            if x.get("deviceId") == UID
        ),
        None,
    )
    row = (d or {}).get("rowing") or {}
    return p, d, row


def main():
    print(f"=== Polling {UID} every {POLL_SEC}s (max {MAX_POLLS * POLL_SEC}s) ===")
    print(f"Looking for steady piece: speed CV <= {MAX_SPEED_CV:.0%}, stroke CV <= {MAX_STROKE_CV:.0%}\n")
    history = []
    steady_at = None

    for i in range(MAX_POLLS):
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        try:
            p, d, row = fetch()
        except Exception as e:
            print(f"[{i}] {ts} ERROR: {e}")
            time.sleep(POLL_SEC)
            continue

        if not p and not d:
            print(f"[{i}] {ts} {UID} not found / offline")
            time.sleep(POLL_SEC)
            continue

        map_mps = p.get("speed") if p else None
        raw_mps = (((d or {}).get("gps") or {}).get("last") or {}).get("spd")
        stroke = row.get("strokeRate") or (p.get("strokeRate") if p else None)
        seen = d.get("lastSeenAgoSec") if d else None
        stale = p.get("telemetryStale") if p else None

        history.append({"map_mps": map_mps, "raw_mps": raw_mps, "stroke": stroke})

        # path speed every 3rd poll
        path_mps = None
        if i % 3 == 0:
            now = datetime.now(timezone.utc)
            frm = datetime.fromtimestamp(now.timestamp() - 120, tz=timezone.utc).isoformat().replace("+00:00", "Z")
            to = now.isoformat().replace("+00:00", "Z")
            enc = urllib.parse.quote(UID, safe="")
            track = get(
                f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
            ).get("track") or []
            path_mps = path_speed_last(track, 90)

        ok, reason = is_steady(history)
        path_note = f" | path90s={path_mps:.2f} ({split500(path_mps)})" if path_mps else ""
        print(
            f"[{i:2d}] {ts}  map={map_mps} ({split500(map_mps)})  "
            f"raw={raw_mps}  stroke={stroke}  seen={seen}s{path_note}  -> {reason}"
        )

        if ok and steady_at is None:
            steady_at = i
            win = history[-WINDOW:]
            speeds = [h["map_mps"] for h in win if h["map_mps"] and h["map_mps"] >= 0.25]
            strokes = [h["stroke"] for h in win if h["stroke"]]
            print(
                f"\n*** STEADY PIECE detected at poll {i} "
                f"(~{split500(statistics.mean(speeds))}, ~{statistics.mean(strokes):.0f} spm) ***\n"
            )
            # keep polling a bit more to confirm
            if i >= steady_at + 4:
                print("Confirmed over next polls — stopping.")
                break

        time.sleep(POLL_SEC)

    if steady_at is None:
        print("\nNo fully steady window in this run — likely still warming up or varying pace.")
        if len(history) >= 3:
            speeds = [h["map_mps"] for h in history if h["map_mps"] and h["map_mps"] >= 0.5]
            strokes = [h["stroke"] for h in history if h["stroke"]]
            if speeds and strokes:
                print(
                    f"Session so far: map speed {split500(statistics.mean(speeds))} avg, "
                    f"stroke ~{statistics.mean(strokes):.0f} spm avg "
                    f"(range {min(strokes):.0f}–{max(strokes):.0f})"
                )
    else:
        print(f"Steady piece first seen at poll {steady_at} (~{steady_at * POLL_SEC}s into monitoring).")


if __name__ == "__main__":
    main()
