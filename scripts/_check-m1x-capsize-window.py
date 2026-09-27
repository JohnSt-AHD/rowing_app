#!/usr/bin/env python3
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
SID = "315e22f9-3c4e-4a56-a82c-6d308f1623cd"
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


import json

dash = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(SID))
track = dash.get("track") or []

# capsize at 2026-07-27 06:29:17 NZ
center = int(datetime(2026, 7, 27, 6, 29, 17, tzinfo=AUCKLAND).timestamp() * 1000)
t0, t1 = center - 120000, center + 120000
pts = sorted([p for p in track if t0 <= p.get("t", 0) <= t1], key=lambda x: x["t"])
print("=== ±2 min around yesterday capsize 06:29 NZ ===")
print("samples", len(pts), "gps", sum(1 for p in pts if p.get("lat")))
for p in pts:
    t = datetime.fromtimestamp(p["t"] / 1000, tz=AUCKLAND).strftime("%H:%M:%S")
    flags = []
    if p.get("capsize"):
        flags.append("CAPSIZE")
    if p.get("lat") is not None:
        flags.append("gps")
    print(f" {t} {' '.join(flags) or 'other'}")
