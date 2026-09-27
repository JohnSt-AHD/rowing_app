#!/usr/bin/env python3
"""All capsize events today (NZ) with location vs geofences."""
import json
import math
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
AUCKLAND = timezone(timedelta(hours=12))
TODAY = "2026-07-29"


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fmt_ms(t_ms):
    return datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).astimezone(AUCKLAND).strftime(
        "%H:%M:%S"
    )


def haversine(lat1, lon1, lat2, lon2):
    r = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def point_in_circle(lat, lon, g):
    clat = g.get("centerLat") or g.get("lat")
    clon = g.get("centerLon") or g.get("lon")
    rad = g.get("radiusM") or g.get("radius") or 0
    if clat is None or clon is None:
        return False, None
    d = haversine(lat, lon, clat, clon)
    return d <= rad, d


def geofence_matches(lat, lon, geofences):
    hits = []
    for g in geofences:
        inside, dist = point_in_circle(lat, lon, g)
        if inside:
            hits.append((g.get("name"), dist, g.get("disableCapsize")))
    return hits


def main():
    geofences = get("/api/geofences").get("geofences") or []
    print(f"=== Geofences ({len(geofences)}) ===")
    for g in geofences:
        print(
            f"  {g.get('name')}: disableCapsize={g.get('disableCapsize')}"
            f" center=({g.get('centerLat')},{g.get('centerLon')}) r={g.get('radiusM')}m"
        )

    day_start = datetime(2026, 7, 29, 0, 0, 0, tzinfo=AUCKLAND).astimezone(timezone.utc)
    frm = day_start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    lb = get("/api/history?list=logbook&days=1&tz=Pacific/Auckland")
    print(f"\n=== Logbook today ({TODAY}) ===")
    for day in lb.get("days", []):
        if day.get("date") == TODAY:
            print(f"  capsizeCount: {day.get('capsizeCount')}")
            for s in day.get("sessions", []):
                if s.get("capsizeCount"):
                    print(
                        f"    {s.get('deviceName')} session {str(s.get('sessionId',''))[:8]}"
                        f" capsize={s.get('capsizeCount')}"
                    )

    devices_raw = get("/api/history?list=devices").get("devices") or []
    uids = []
    for d in devices_raw:
        if isinstance(d, str):
            uids.append(d)
        elif isinstance(d, dict):
            uids.append(d.get("uniqueId") or d.get("deviceId") or d.get("name"))
    if not uids:
        for day in lb.get("days", []):
            for s in day.get("sessions", []):
                if s.get("deviceName"):
                    uids.append(s["deviceName"])

    all_incidents = []
    print(f"\n=== Scanning {len(set(uids))} devices for capsize today ===")
    for uid in sorted(set(u for u in uids if u)):
        if not uid:
            continue
        try:
            data = get(
                f"/api/history?format=dashboard&uniqueId={urllib.parse.quote(uid, safe='')}"
                f"&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
            )
        except Exception as e:
            print(f"  {uid}: skip ({e})")
            continue
        events = data.get("capsizeEvents") or []
        caps = [p for p in (data.get("track") or []) if p.get("capsize")]
        if not events and not caps:
            continue
        print(f"\n--- {uid} ---")
        print(f"  samples={data.get('capsizeSampleCount')} incidents={len(events)}")
        for ev in events:
            t = ev.get("t")
            lat, lon = ev.get("lat"), ev.get("lon")
            loc = f"{lat:.6f}, {lon:.6f}" if lat is not None else "no GPS"
            zones = geofence_matches(lat, lon, geofences) if lat else []
            zone_txt = ", ".join(
                f"{n} ({d:.0f}m, capsizeOff={off})" for n, d, off in zones
            ) or "open water / no geofence"
            should_alarm = not any(off for _, _, off in zones) if zones else True
            print(f"  INCIDENT {fmt_ms(t)} NZ  {loc}  tilt={ev.get('tiltDeg')}")
            print(f"    geofence: {zone_txt}")
            print(f"    server should alarm: {should_alarm}")
            all_incidents.append(
                {
                    "device": uid,
                    "t": t,
                    "lat": lat,
                    "lon": lon,
                    "tilt": ev.get("tiltDeg"),
                    "zones": zones,
                    "should_alarm": should_alarm,
                }
            )
        if not events and caps:
            for p in caps[:5]:
                lat, lon = p.get("lat"), p.get("lon")
                zones = geofence_matches(lat, lon, geofences) if lat else []
                print(f"  sample {fmt_ms(p['t'])} {lat},{lon} zones={zones}")

    print(f"\n=== SUMMARY: {len(all_incidents)} collapsed incident(s) today ===")
    for i, ev in enumerate(all_incidents, 1):
        znames = [z[0] for z in ev["zones"]]
        print(
            f"{i}. {ev['device']} @ {fmt_ms(ev['t'])} NZ"
            f" ({ev['lat']:.5f}, {ev['lon']:.5f})"
            f" zones={znames or 'none'}"
            f" should_alarm={ev['should_alarm']}"
        )

    inside_no_alarm = [e for e in all_incidents if e["zones"] and not e["should_alarm"]]
    if inside_no_alarm:
        print(
            f"\n*** {len(inside_no_alarm)} inside disableCapsize zone(s) — same class as RNZ auto-start bug"
        )
    else:
        print("\nNo capsize inside disableCapsize zones detected in stored GPS.")


if __name__ == "__main__":
    main()
