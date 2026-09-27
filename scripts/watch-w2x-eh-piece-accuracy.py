#!/usr/bin/env python3
"""Monitor W2x EH piece: raw GPS vs RowSafe ticket/path/display + spike counts."""

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
POLLS = 60
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"}
TARGET_LO = 500 / 120  # 2:00
TARGET_HI = 500 / 100  # 1:40
STEP_SPIKE_RATIO = 1.22


def get(path):
    req = urllib.request.Request(BASE + path, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def split500(s):
    if s is None or not isinstance(s, (int, float)) or s < 0.25:
        return "-"
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
    dist = sum(
        hav(recent[i - 1]["lat"], recent[i - 1]["lon"], recent[i]["lat"], recent[i]["lon"])
        for i in range(1, len(recent))
    )
    span = (recent[-1]["t"] - recent[0]["t"]) / 1000
    return dist / span if span > 0 else None


def fetch():
    mp = get("/api/map-positions?onlineSec=600&staleSec=3600&predictMode=rowing")
    p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)
    d = next(
        (
            x
            for x in get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1").get("devices", [])
            if x.get("deviceId") == UID
        ),
        None,
    )
    raw = (((d or {}).get("gps") or {}).get("last") or {}).get("spd")
    if not p:
        return None
    ticket = p.get("displaySpeedMps") or p.get("pathSpeedMps")
    return {
        "ticket": ticket,
        "path": p.get("pathSpeedMps"),
        "disp": p.get("displaySpeedMps"),
        "map": p.get("speed"),
        "raw": raw,
        "stroke": p.get("displayStrokeRate") or p.get("strokeRate"),
        "window": p.get("pathPaceWindowSec"),
        "stale": p.get("telemetryStale"),
    }


def in_band(mps):
    return mps is not None and TARGET_LO <= mps <= TARGET_HI


def main():
    print(f"=== {UID} 5min accuracy watch (target 1:40-2:00/500) ===")
    print(
        f"{'#':>3}  {'time':>8}  {'ticket':>8}  {'path30s':>8}  {'display':>8}  "
        f"{'rawGPS':>8}  {'gps90s':>8}  {'win':>3}  spikes"
    )
    print("-" * 96)

    rows = []
    prev_ticket = None
    spike_counts = {"ticket_step": 0, "ticket_band": 0, "path_band": 0, "raw_band": 0, "path_step": 0}
    gps90 = None

    for i in range(POLLS):
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        try:
            s = fetch()
            if i % 6 == 0:
                gps90 = path90(UID)
        except Exception as e:
            print(f"{i:3d}  {ts}  ERROR: {e}")
            time.sleep(POLL_SEC)
            continue
        if not s:
            print(f"{i:3d}  {ts}  offline")
            time.sleep(POLL_SEC)
            continue

        ticket = s["ticket"]
        row = {**s, "gps90": gps90, "ts": ts}
        rows.append(row)

        spikes = []
        if ticket and prev_ticket and prev_ticket >= 0.25:
            r = ticket / prev_ticket
            if r > STEP_SPIKE_RATIO or r < 1 / STEP_SPIKE_RATIO:
                spike_counts["ticket_step"] += 1
                spikes.append("T-step")
        if ticket and not in_band(ticket):
            spike_counts["ticket_band"] += 1
            if "T-band" not in spikes:
                spikes.append("T-band")
        if s["path"] and not in_band(s["path"]):
            spike_counts["path_band"] += 1
            spikes.append("P-band")
        if s["path"] and prev_ticket and s["path"] >= 0.25:
            rp = s["path"] / (prev_ticket or s["path"])
            if rp > STEP_SPIKE_RATIO or rp < 1 / STEP_SPIKE_RATIO:
                spike_counts["path_step"] += 1
        if s["raw"] and not in_band(s["raw"]):
            spike_counts["raw_band"] += 1
            spikes.append("R-band")

        prev_ticket = ticket if ticket else prev_ticket
        win = int(s["window"]) if s.get("window") else "?"

        print(
            f"{i:3d}  {ts}  {split500(ticket):>8}  {split500(s['path']):>8}  "
            f"{split500(s['disp']):>8}  {split500(s['raw']):>8}  {split500(gps90):>8}  "
            f"{win:>3}  {' '.join(spikes) if spikes else ''}"
        )
        time.sleep(POLL_SEC)

    print("\n=== Accuracy vs GPS track (90s ground truth) ===")
    for label, key in [
        ("Ticket (display|path)", "ticket"),
        ("Path 30s", "path"),
        ("Display EMA", "disp"),
        ("Raw phone gps.spd", "raw"),
    ]:
        paired = [(r[key], r["gps90"]) for r in rows if r.get(key) and r.get("gps90")]
        if len(paired) < 3:
            print(f"{label}: insufficient paired samples")
            continue
        errs = [pct_err(c, t) for c, t in paired if pct_err(c, t) is not None]
        coach = [c for c, _ in paired]
        truth = [t for _, t in paired]
        inb = sum(1 for c, _ in paired if in_band(c))
        print(
            f"{label}: avg {split500(statistics.mean(coach))}/500  "
            f"vs gps90 {split500(statistics.mean(truth))}/500  "
            f"err avg {statistics.mean(errs):+.1f}% med {statistics.median(errs):+.1f}%  "
            f"in-band {inb}/{len(paired)}"
        )

    print("\n=== Spike counts (out of 1:40-2:00 or >22% step) ===")
    polls_with_data = len([r for r in rows if r.get("ticket") or r.get("path")])
    print(f"Polls with data: {polls_with_data}/{len(rows)}")
    print(f"  Ticket step spikes (>22% jump): {spike_counts['ticket_step']}")
    print(f"  Ticket out-of-band:             {spike_counts['ticket_band']}")
    print(f"  Path30s out-of-band:            {spike_counts['path_band']}")
    print(f"  Path30s step spikes:            {spike_counts['path_step']}")
    print(f"  Raw GPS out-of-band:            {spike_counts['raw_band']}")

    tickets = [r["ticket"] for r in rows if r.get("ticket")]
    paths = [r["path"] for r in rows if r.get("path")]
    if len(tickets) >= 3:
        cv = statistics.pstdev(tickets) / statistics.mean(tickets)
        print(f"\nTicket variability: {split500(min(tickets))} - {split500(max(tickets))}/500  CV {cv:.0%}")
    if len(paths) >= 3:
        cv = statistics.pstdev(paths) / statistics.mean(paths)
        print(f"Path30s variability: {split500(min(paths))} - {split500(max(paths))}/500  CV {cv:.0%}")

    w = rows[-1].get("window") if rows else None
    print(f"\nAPI pathPaceWindowSec (last poll): {w}s")


if __name__ == "__main__":
    main()
