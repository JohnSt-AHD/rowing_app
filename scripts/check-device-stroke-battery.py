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
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


now = datetime.now(timezone.utc)
frm = (now - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
to = now.isoformat().replace("+00:00", "Z")

for uid in ["M1x TM", "W2x EH"]:
    enc = urllib.parse.quote(uid, safe="")
    d = get(
        f"/api/history?format=dashboard&uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    )
    strokes = [p.get("strokeRate") for p in d.get("track", []) if p.get("strokeRate")]
    print(
        uid,
        "track",
        len(d.get("track", [])),
        "strokeRate points",
        len(strokes),
        "last",
        strokes[-3:] if strokes else None,
    )
    sid = d.get("sessionId")
    if sid:
        raw = get(f"/api/ingest?sessionId={sid}")
        samples = raw.get("samples") or []
        bats = [
            (s.get("derived") or {}).get("batteryPct")
            for s in samples
            if (s.get("derived") or {}).get("batteryPct") is not None
        ]
        mot = sum(1 for s in samples if s.get("motion"))
        derived_sr = [
            (s.get("derived") or {}).get("strokeRate")
            for s in samples
            if (s.get("derived") or {}).get("strokeRate") is not None
        ]
        print(
            "  session samples",
            len(samples),
            "motion",
            mot,
            "battery reports",
            len(bats),
            "last bat",
            bats[-1] if bats else None,
            "derived stroke",
            derived_sr[-3:] if derived_sr else None,
        )
