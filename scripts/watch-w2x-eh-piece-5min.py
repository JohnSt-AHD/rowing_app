#!/usr/bin/env python3
"""Monitor W2x EH ticket/path pace during a piece (RowSafe map source)."""

import json
import statistics
import time
import urllib.request
from datetime import datetime, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2x EH"
POLL_SEC = 5
POLLS = 60  # 5 min
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}
TARGET_LO = 500 / 120  # 2:00 / 500
TARGET_HI = 500 / 100  # 1:40 / 500


def get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(s):
    if s is None or not isinstance(s, (int, float)) or s < 0.25:
        return "-"
    sec = 500 / float(s)
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def in_band(mps):
    return mps is not None and TARGET_LO <= mps <= TARGET_HI


def fetch():
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    d = next(
        (
            x
            for x in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get(
                "devices", []
            )
            if x.get("deviceId") == UID
        ),
        None,
    )
    raw = (((d or {}).get("gps") or {}).get("last") or {}).get("spd")
    if not p:
        return None
    return {
        "ticket": p.get("pathSpeedMps") or p.get("displaySpeedMps"),
        "path": p.get("pathSpeedMps"),
        "disp": p.get("displaySpeedMps"),
        "map": p.get("speed"),
        "raw": raw,
        "stroke": p.get("displayStrokeRate") or p.get("strokeRate"),
        "stale": p.get("telemetryStale"),
        "window": p.get("pathPaceWindowSec"),
    }


def main():
    print(f"=== {UID} 5min piece watch — target 1:40-2:00/500 ===")
    print(
        f"{'#':>3}  {'time':>8}  {'ticket':>8}  {'path15s':>8}  {'display':>8}  "
        f"{'mapSpd':>8}  {'rawGPS':>8}  {'spm':>4}  notes"
    )
    print("-" * 92)
    rows = []
    for i in range(POLLS):
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        try:
            s = fetch()
        except Exception as e:
            print(f"{i:3d}  {ts}  ERROR: {e}")
            time.sleep(POLL_SEC)
            continue
        if not s:
            print(f"{i:3d}  {ts}  offline")
            time.sleep(POLL_SEC)
            continue
        ticket = s["ticket"]
        rows.append({"ticket": ticket, "path": s["path"], "disp": s["disp"], "map": s["map"]})
        notes = []
        if s["stale"]:
            notes.append("stale")
        ref = ticket or s["path"]
        if ref and in_band(ref):
            notes.append("in-band")
        elif ref:
            notes.append("OUT")
        if s["path"] is None and s["disp"] is None:
            notes.append("no pace")
        if s.get("window"):
            notes.append(f"{s['window']}s win")
        print(
            f"{i:3d}  {ts}  {split500(ticket):>8}  {split500(s['path']):>8}  "
            f"{split500(s['disp']):>8}  {split500(s['map']):>8}  {split500(s['raw']):>8}  "
            f"{str(s['stroke'] or '-'):>4}  {' | '.join(notes)}"
        )
        time.sleep(POLL_SEC)

    print("\n=== Summary (ticket + graph source = path15s) ===")
    for label, key in [
        ("Ticket (path first)", "ticket"),
        ("Path 15s (graph)", "path"),
        ("Display EMA", "disp"),
        ("Map speed field", "map"),
    ]:
        vals = [r[key] for r in rows if r.get(key)]
        if len(vals) < 3:
            print(f"{label}: insufficient data ({len(vals)} samples)")
            continue
        inb = sum(1 for v in vals if in_band(v))
        cv = statistics.pstdev(vals) / statistics.mean(vals) if len(vals) >= 3 else 0
        print(
            f"{label}: avg {split500(statistics.mean(vals))}/500  "
            f"range {split500(min(vals))}-{split500(max(vals))}/500  "
            f"in-band {inb}/{len(vals)} ({100 * inb / len(vals):.0f}%)  CV {cv:.0%}"
        )


if __name__ == "__main__":
    main()
