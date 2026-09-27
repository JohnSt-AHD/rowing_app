#!/usr/bin/env python3
"""Extended W2x EH pace watch — path vs raw vs GPS track."""

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
POLLS = 24  # 2 min
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}


def get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(s):
    if s is None or not isinstance(s, (int, float)) or s < 0.25:
        return "—"
    sec = 500 / float(s)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def pct_err(obs, truth):
    if obs is None or truth is None or truth < 0.25:
        return None
    return 100 * (obs - truth) / truth


def hav(a, b, c, d):
    r = 6371000.0
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def path90(uid):
    now = datetime.now(timezone.utc)
    frm = datetime.fromtimestamp(now.timestamp() - 120, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    to = now.isoformat().replace("+00:00", "Z")
    enc = urllib.parse.quote(uid, safe="")
    track = get(
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    ).get("track") or []
    pts = [p for p in track if p.get("lat") is not None and p.get("lon") is not None and p.get("t")]
    if len(pts) < 2:
        return None
    end_t = pts[-1]["t"]
    recent = [p for p in pts if p["t"] >= end_t - 90_000]
    if len(recent) < 2:
        return None
    dist = sum(hav(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"]) for i in range(1, len(recent)))
    span = (recent[-1]["t"] - recent[0]["t"]) / 1000
    return dist / span if span > 0 else None


def fetch(uid):
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == uid), None)
    d = next(
        (
            x
            for x in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get("devices", [])
            if x.get("deviceId") == uid
        ),
        None,
    )
    raw = (((d or {}).get("gps") or {}).get("last") or {}).get("spd")
    return {
        "p": p,
        "raw": raw,
        "map": p.get("speed") if p else None,
        "path": p.get("pathSpeedMps") if p else None,
        "disp": p.get("displaySpeedMps") if p else None,
        "stroke": (p.get("displayStrokeRate") or p.get("strokeRate")) if p else None,
        "seen": p.get("lastSeenAgoSec") if p else None,
        "stale": p.get("telemetryStale") if p else None,
        "window": p.get("pathPaceWindowSec") if p else None,
    }


def main():
    print(f"=== Watching {UID} every {POLL_SEC}s for {POLLS * POLL_SEC}s ===")
    print(f"{'#':>3}  {'time':>8}  {'path15s':>8}  {'display':>8}  {'rawGPS':>8}  {'map':>8}  {'gps90s':>8}  {'spm':>4}  notes")
    print("-" * 88)

    rows = []
    for i in range(POLLS):
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        try:
            s = fetch(UID)
            gps90 = path90(UID) if i % 2 == 0 else rows[-1].get("gps90") if rows else None
        except Exception as e:
            print(f"{i:3d}  {ts}  ERROR: {e}")
            time.sleep(POLL_SEC)
            continue

        if not s["p"]:
            print(f"{i:3d}  {ts}  offline")
            time.sleep(POLL_SEC)
            continue

        row = {
            "path": s["path"],
            "disp": s["disp"],
            "raw": s["raw"],
            "map": s["map"],
            "gps90": gps90,
            "stroke": s["stroke"],
        }
        rows.append(row)

        coach = s["disp"] or s["path"]
        truth = gps90 or s["raw"]
        notes = []
        if s["stale"]:
            notes.append("stale")
        if coach and truth:
            err = pct_err(coach, truth)
            if err is not None and err < -15:
                notes.append(f"coach {err:+.0f}% vs gps90")
            elif err is not None and abs(err) <= 5:
                notes.append("aligned")
        if s["path"] is None and s["disp"] is None:
            notes.append("no path pace")

        print(
            f"{i:3d}  {ts}  {split500(s['path']):>8}  {split500(s['disp']):>8}  "
            f"{split500(s['raw']):>8}  {split500(s['map']):>8}  {split500(gps90):>8}  "
            f"{s['stroke'] or '—':>4}  {' · '.join(notes) if notes else ''}"
        )
        time.sleep(POLL_SEC)

    print("\n=== Summary (samples with gps90 ground truth) ===")
    paired = [(r["disp"] or r["path"], r["gps90"]) for r in rows if r.get("gps90") and (r.get("disp") or r.get("path"))]
    if paired:
        errs = [pct_err(c, t) for c, t in paired if pct_err(c, t) is not None]
        coach = [c for c, _ in paired]
        truth = [t for _, t in paired]
        print(f"Coach pace avg: {split500(statistics.mean(coach))}/500  ({statistics.mean(coach):.2f} m/s)")
        print(f"GPS track 90s avg: {split500(statistics.mean(truth))}/500  ({statistics.mean(truth):.2f} m/s)")
        if errs:
            print(f"Coach vs GPS90: avg {statistics.mean(errs):+.1f}%  med {statistics.median(errs):+.1f}%")

    paths = [r["path"] for r in rows if r.get("path")]
    disps = [r["disp"] for r in rows if r.get("disp")]
    if len(paths) >= 3:
        cv = statistics.pstdev(paths) / statistics.mean(paths)
        print(f"Path15s variability: {split500(min(paths))} – {split500(max(paths))}/500  CV {cv:.0%}")
    if len(disps) >= 3:
        cv = statistics.pstdev(disps) / statistics.mean(disps)
        print(f"Display variability: {split500(min(disps))} – {split500(max(disps))}/500  CV {cv:.0%}")


if __name__ == "__main__":
    main()
