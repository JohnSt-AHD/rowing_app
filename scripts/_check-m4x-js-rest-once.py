#!/usr/bin/env python3
import json
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "M4x JS"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


dev = get("/api/devices?windowSec=600&onlineSec=3600&includeMetrics=1")
d = next((x for x in dev.get("devices", []) if x.get("deviceId") == UID), None)
mp = get("/api/map-positions?onlineSec=3600&staleSec=7200&predictMode=rowing")
p = next((x for x in mp.get("positions", []) if x.get("deviceId") == UID), None)

print("=== M4x JS live check ===")
if not d:
    print("NOT FOUND on /api/devices")
else:
    g = d.get("gps") or {}
    last = g.get("last") or {}
    hb = d.get("heartbeat") or {}
    row = d.get("rowing") or {}
    sid = str(d.get("sessionId") or "")
    print(f"online: lastSeenAgo={d.get('lastSeenAgoSec')}s session={sid[:12]}")
    print(
        f"gps: present={g.get('present')} rateHz={g.get('rateHz')} "
        f"count={g.get('count')} ingestHz={d.get('ingestRateHz')}"
    )
    print(
        f"last fix: lat={last.get('lat')} lon={last.get('lon')} "
        f"acc={last.get('acc')}m spd={last.get('spd')}"
    )
    print(
        f"ages: upload={g.get('ageSec')}s fix={g.get('gpsFixAgeSec')}s "
        f"display={g.get('displayAgeSec')}s lag={g.get('uploadLagSec')}s"
    )
    print(
        f"source={last.get('sampleSource')} provider={last.get('provider')} "
        f"fixMs={last.get('fixMs')}"
    )
    print(
        f"heartbeat: rateHz={hb.get('rateHz')} ageSec={hb.get('ageSec')} "
        f"stroke={row.get('strokeRate')} capsize={row.get('capsize')}"
    )

if not p:
    print("NOT on map-positions")
else:
    print(
        f"map: lat={p.get('latitude')} lon={p.get('longitude')} "
        f"online={p.get('online')} speed={p.get('speed')} acc={p.get('accuracy')}"
    )
    print(
        f"map ages: fixAge={p.get('fixAgeSec')} gpsFixAge={p.get('gpsFixAgeSec')} "
        f"uploadLag={p.get('uploadLagSec')} source={p.get('gpsSampleSource')}"
    )
    print(f"outlierRejected={p.get('gpsOutlierRejected')} smoothed={p.get('smoothed')}")
