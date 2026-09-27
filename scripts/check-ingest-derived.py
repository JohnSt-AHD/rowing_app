#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


devices = get("/api/devices?windowMs=300000").get("devices") or []
for d in devices:
    if d.get("deviceId") not in ("M1x TM", "W2x EH"):
        continue
    sid = d.get("sessionId")
    print("===", d["deviceId"], "sessionId", sid, "===")
    if not sid:
        continue
    raw = get(f"/api/ingest?sessionId={urllib.parse.quote(sid, safe='')}")
    samples = raw.get("samples") or []
    sr = sum(1 for s in samples if (s.get("derived") or {}).get("strokeRate") is not None)
    bat = sum(1 for s in samples if (s.get("derived") or {}).get("batteryPct") is not None)
    mot = sum(1 for s in samples if s.get("motion"))
    print("samples", len(samples), "motion", mot, "derived strokeRate", sr, "derived battery", bat)
    for s in samples[-5:]:
        print(
            " ",
            s.get("t"),
            "gps" if s.get("gps") else "-",
            "mot" if s.get("motion") else "-",
            "derived",
            s.get("derived"),
        )
