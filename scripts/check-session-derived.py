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


for uid in ["M1x TM", "W2x EH"]:
    enc = urllib.parse.quote(uid, safe="")
    sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
    print("===", uid, "sessions", len(sessions), "===")
    if not sessions:
        continue
    s0 = sessions[0]
    print("latest keys", list(s0.keys()))
    print("latest", json.dumps(s0, indent=2)[:800])
    sid = s0.get("sessionId") or s0.get("session_id") or s0.get("id")
    if not sid:
        continue
    raw = get(f"/api/ingest?sessionId={urllib.parse.quote(sid, safe='')}")
    samples = raw.get("samples") or []
    mot = sum(1 for s in samples if s.get("motion"))
    ax = sum(1 for s in samples if (s.get("motion") or {}).get("ax") is not None)
    dsr = sum(1 for s in samples if (s.get("derived") or {}).get("strokeRate") is not None)
    dbat = sum(1 for s in samples if (s.get("derived") or {}).get("batteryPct") is not None)
    print("ingest", len(samples), "motion", mot, "ax", ax, "stroke derived", dsr, "battery derived", dbat)
    gps_with_derived = [s for s in samples if s.get("gps") and s.get("derived")]
    print("gps+derived", len(gps_with_derived))
    if gps_with_derived:
        print("sample derived keys", sorted(set(k for s in gps_with_derived[-20:] for k in (s.get("derived") or {}).keys())))
    if dbat:
        print("last battery", [(s["t"], s["derived"]["batteryPct"]) for s in samples if s.get("derived", {}).get("batteryPct")][-3:])
