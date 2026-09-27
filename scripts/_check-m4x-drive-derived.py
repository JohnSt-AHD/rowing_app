#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request
from collections import Counter

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=120) as r:
        return json.load(r)


sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M4x JS"))["sessions"]
    if s["session_id"].startswith("fd472428")
)
tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"]

# dashboard track may not include derived - try map-positions / device registry
for path in (
    "/api/map-positions",
    "/api/map-positions?org=rnz",
    "/api/devices?online=1",
):
    try:
        d = get(path)
        devs = d.get("devices") or d.get("positions") or []
        if isinstance(d, dict) and "uniqueId" in d:
            devs = [d]
        m4 = next(
            (
                x
                for x in devs
                if (x.get("uniqueId") or x.get("unique_id") or x.get("label") or "").find("M4x") >= 0
            ),
            None,
        )
        if m4:
            print(f"=== {path} ===")
            print(json.dumps(m4, indent=2)[:3000])
    except Exception as e:
        print(f"{path}: {e}")

# Check if any API exposes raw samples with derived
for q in (
    f"/api/history?sessionId={urllib.parse.quote(sid)}&from=2026-08-03T03:40:00Z&to=2026-08-03T04:00:00Z",
    f"/api/history?sessionId={urllib.parse.quote(sid)}",
):
    try:
        d = get(q)
        samples = d.get("samples") or d.get("track") or []
        if samples and isinstance(samples[0], dict):
            derived_keys = Counter()
            for s in samples[:50]:
                dr = s.get("derived") or {}
                if dr.get("inBoatPark"):
                    derived_keys["inBoatPark"] += 1
                if dr.get("heartbeat"):
                    derived_keys["heartbeat"] += 1
            print(f"\n{q.split('?')[1][:40]} samples={len(samples)} derived={dict(derived_keys)}")
    except Exception as e:
        print(f"history query: {e}")
