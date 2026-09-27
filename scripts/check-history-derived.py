#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


now = datetime.now(timezone.utc)
frm = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
to = now.isoformat().replace("+00:00", "Z")

for uid in ["M1x TM", "W2x EH"]:
    enc = urllib.parse.quote(uid, safe="")
    h = get(
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    )
    track = h.get("track") or []
    sr = [p.get("strokeRate") for p in track if p.get("strokeRate")]
    print(uid, "sessionId", h.get("sessionId"), "points", len(track), "strokeRate non-null", len(sr))
    sid = h.get("sessionId")
    if sid:
        raw = get(f"/api/ingest?sessionId={urllib.parse.quote(sid, safe='')}")
        samples = raw.get("samples") or []
        dsr = sum(1 for s in samples if (s.get("derived") or {}).get("strokeRate") is not None)
        dbat = sum(1 for s in samples if (s.get("derived") or {}).get("batteryPct") is not None)
        mot = sum(1 for s in samples if s.get("motion"))
        print("  ingest samples", len(samples), "motion", mot, "derived stroke", dsr, "battery", dbat)
        if dbat:
            bats = [(s.get("t"), (s.get("derived") or {}).get("batteryPct")) for s in samples if (s.get("derived") or {}).get("batteryPct") is not None]
            print("  last battery samples", bats[-3:])
        if dsr:
            srs = [(s.get("t"), (s.get("derived") or {}).get("strokeRate")) for s in samples if (s.get("derived") or {}).get("strokeRate") is not None]
            print("  last stroke samples", srs[-3:])
