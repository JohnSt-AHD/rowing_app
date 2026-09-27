#!/usr/bin/env python3
"""Check if devices are sending stroke rate to the server."""
import json
import urllib.parse
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"


def get(path: str):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def main():
    devs = get("/api/devices?windowSec=300&onlineSec=600&includeMetrics=1").get("devices", [])
    print(f"Total devices in window: {len(devs)}")
    online = [d for d in devs if d.get("online")]
    print(f"Online: {len(online)}\n")

    for d in sorted(online, key=lambda x: x.get("deviceId", "")):
        uid = d.get("deviceId", "?")
        row = d.get("rowing") or {}
        mot = d.get("motion") or {}
        gps = d.get("gps") or {}
        print(
            f"{uid}: stroke={row.get('strokeRate')} valid={row.get('strokeRateValid')} "
            f"motion={mot.get('present')} motHz={mot.get('rateHz')} gpsHz={gps.get('rateHz')}"
        )

    # W2x SC specifically
    for uid in ["W2x SC", "W2xSC", "W2x"]:
        matches = [d for d in devs if (d.get("deviceId") or "").upper() == uid.upper()]
        if not matches:
            continue
        d = matches[0]
        print(f"\n=== {uid} detail ===")
        print(json.dumps({k: d.get(k) for k in ["deviceId", "online", "rowing", "motion", "gps"]}, indent=2))
        try:
            sess = get(f"/api/history?list=sessions&uniqueId={urllib.parse.quote(uid)}").get("sessions", [])
        except Exception as e:
            print("sessions error:", e)
            continue
        if not sess:
            print("no sessions")
            continue
        sid = sess[0]["session_id"]
        raw = get(f"/api/ingest?sessionId={sid}")
        samples = raw.get("samples", raw if isinstance(raw, list) else [])
        recent = samples[-5:] if samples else []
        print(f"session {sid[:8]} last {len(recent)} samples:")
        for s in recent:
            dr = s.get("derived") or {}
            print(
                f"  t={s.get('t')} strokeRate={dr.get('strokeRate')} "
                f"motion={s.get('motion') is not None} gps={s.get('gps') is not None}"
            )


if __name__ == "__main__":
    main()
