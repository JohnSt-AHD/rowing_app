#!/usr/bin/env python3
"""Deep dive W1x LS sparse session today."""
import json
import math
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
NZ = timezone(timedelta(hours=12))
UID = "W1x LS"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def main():
    enc = urllib.parse.quote(UID, safe="")
    sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
    sid = sessions[0]["session_id"]
    print(f"Session {sid}")

    # Raw route (not downsampled dashboard) for the session window
    started = sessions[0].get("started_at")
    print(f"started_at={started}")

    # wide window today NZ
    now = datetime.now(NZ)
    day = now.date()
    start_local = datetime(day.year, day.month, day.day, 0, 0, 0, tzinfo=NZ)
    end_local = start_local + timedelta(days=1)
    frm = start_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    to = end_local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    # dashboard track (downsampled)
    dash = get(
        f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}"
    )
    track = dash.get("track") or []
    print(f"\nDashboard track points: {len(track)}")
    print("All points (time NZ, lat, lon, spd, stroke, src, provider, fixMs, acc):")
    for p in track:
        t = datetime.fromtimestamp(p["t"] / 1000, NZ).strftime("%H:%M:%S")
        print(
            f"  {t} lat={p.get('lat')} lon={p.get('lon')} spd={p.get('speed')} "
            f"spm={p.get('strokeRate')} src={p.get('gpsSampleSource')} "
            f"prov={p.get('gpsProvider')} fixMs={p.get('fixMs')} acc={p.get('acc')} "
            f"cap={p.get('capsize')}"
        )

    # Raw history route
    route = get(
        f"/api/history?uniqueId={enc}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    )
    if isinstance(route, list):
        raw = route
    else:
        raw = route.get("positions") or route.get("route") or route.get("samples") or []
    print(f"\nRaw history positions today: {len(raw)} type={type(route).__name__}")
    if isinstance(route, dict):
        print("route keys:", sorted(route.keys())[:30])

    # If raw is traccar-shaped
    pts = []
    for p in raw if isinstance(raw, list) else []:
        lat = p.get("latitude", p.get("lat"))
        lon = p.get("longitude", p.get("lon"))
        ft = p.get("fixTime") or p.get("deviceTime") or p.get("t")
        if isinstance(ft, str):
            try:
                tms = int(datetime.fromisoformat(ft.replace("Z", "+00:00")).timestamp() * 1000)
            except Exception:
                tms = None
        else:
            tms = int(ft) if ft is not None else None
            if tms is not None and tms < 1e12:
                tms *= 1000
        pts.append({**p, "_lat": lat, "_lon": lon, "_t": tms})

    gps = [p for p in pts if p["_lat"] is not None and p["_t"]]
    gps.sort(key=lambda x: x["_t"])
    print(f"Raw GPS fixes: {len(gps)}")
    if gps:
        print("First 20 raw GPS:")
        for p in gps[:20]:
            t = datetime.fromtimestamp(p["_t"] / 1000, NZ).strftime("%H:%M:%S")
            attrs = p.get("attributes") or {}
            print(
                f"  {t} {p['_lat']:.6f},{p['_lon']:.6f} spd={p.get('speed')} "
                f"src={attrs.get('gpsSampleSource') or p.get('gpsSampleSource')} "
                f"prov={attrs.get('gpsProvider') or p.get('gpsProvider')}"
            )
        if len(gps) > 20:
            print("...")
            for p in gps[-10:]:
                t = datetime.fromtimestamp(p["_t"] / 1000, NZ).strftime("%H:%M:%S")
                print(f"  {t} {p['_lat']:.6f},{p['_lon']:.6f} spd={p.get('speed')}")

        # moving distance excluding jumps
        move = 0
        jumps = 0
        for i in range(1, len(gps)):
            dt = (gps[i]["_t"] - gps[i - 1]["_t"]) / 1000
            dist = haversine_m(gps[i - 1]["_lat"], gps[i - 1]["_lon"], gps[i]["_lat"], gps[i]["_lon"])
            if dt <= 0:
                continue
            spd = dist / dt
            if spd > 8 or dist > 200:  # implausible
                jumps += 1
                print(f"  JUMP {dt:.0f}s {dist:.0f}m ({spd:.1f} m/s) at {datetime.fromtimestamp(gps[i]['_t']/1000, NZ).strftime('%H:%M:%S')}")
            else:
                move += dist
        print(f"\nPlausible moving distance: {move:.0f}m  jumps={jumps}")

    # Live device card leftovers
    try:
        devs = get("/api/devices?windowSec=86400&onlineSec=172800&includeMetrics=1").get("devices") or []
        d = next((x for x in devs if x.get("deviceId") == UID), None)
        if d:
            print("\nDevices API snapshot:")
            print(json.dumps({k: d.get(k) for k in sorted(d.keys()) if k not in ('samples',)}, default=str)[:2500])
    except Exception as e:
        print("devices failed", e)

    # Compare TM yesterday briefly for context
    print("\n=== Compare M1x TM yesterday sample rate ===")
    uid2 = "M1x TM"
    enc2 = urllib.parse.quote(uid2, safe="")
    yday = (now - timedelta(days=1)).date()
    ys = datetime(yday.year, yday.month, yday.day, 0, 0, 0, tzinfo=NZ)
    ye = ys + timedelta(days=1)
    frm2 = ys.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    to2 = ye.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    dash2 = get(
        f"/api/history?format=dashboard&uniqueId={enc2}&from={urllib.parse.quote(frm2)}&to={urllib.parse.quote(to2)}"
    )
    tr2 = dash2.get("track") or []
    gps2 = [p for p in tr2 if p.get("lat") is not None]
    print(f"TM yesterday dashboard GPS points: {len(gps2)}")
    if len(gps2) >= 2:
        gaps = [(gps2[i]["t"] - gps2[i - 1]["t"]) / 1000 for i in range(1, len(gps2))]
        print(f"  med gap={sorted(gaps)[len(gaps)//2]:.1f}s max={max(gaps):.0f}s")


if __name__ == "__main__":
    main()
