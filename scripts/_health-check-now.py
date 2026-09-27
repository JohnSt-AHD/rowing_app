#!/usr/bin/env python3
"""One-shot production health check for CrewSight + AHD overlay."""
import json
import ssl
import urllib.error
import urllib.request
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None  # type: ignore

BASE = "https://rowing-app-recorder-pwa.vercel.app"
OVERLAY = "https://traccar-overlay.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
CTX = ssl.create_default_context()


def get(url, headers=None, timeout=90):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            body = r.read()
            try:
                data = json.loads(body.decode("utf-8"))
            except Exception:
                data = {"_raw": body[:200].decode("utf-8", "replace")}
            return r.status, data, None
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {}
        return e.code, data, str(e)
    except Exception as e:
        return 0, {}, str(e)


def main():
    results = []
    now = datetime.now().astimezone()
    print("CrewSight system health", now.isoformat(timespec="seconds"))
    print("=" * 60)

    st, d, err = get(BASE + "/api/ping", H)
    results.append(
        (
            "API ping",
            st == 200 and d.get("ok") is not False,
            f"status={st} storage={d.get('storage')} persisted={d.get('persisted')} err={err}",
        )
    )

    st, d, err = get(BASE + "/api/devices?windowSec=120&onlineSec=120", H)
    devs = d.get("devices") or []
    online = [x for x in devs if x.get("online")]
    results.append(
        (
            "Devices API",
            st == 200,
            f"status={st} total={len(devs)} online={len(online)} err={err}",
        )
    )

    st, d, err = get(
        BASE + "/api/map-positions?onlineSec=120&staleSec=3600&predictMode=rowing", H
    )
    pos = d.get("positions") or []
    pon = [p for p in pos if p.get("online")]
    results.append(
        (
            "Map positions",
            st == 200,
            f"status={st} positions={len(pos)} online={len(pon)} "
            f"activeCount={d.get('activeCount')} cache={d.get('cache')} err={err}",
        )
    )

    st, d, err = get(BASE + "/api/snapshot?onlineSec=120", H)
    snap_dev = d.get("devices") or []
    snap_pos = d.get("positions") or []
    results.append(
        (
            "Snapshot",
            st == 200,
            f"status={st} devices={len(snap_dev)} positions={len(snap_pos)} err={err}",
        )
    )

    st, d, err = get(BASE + "/api/geofences", H)
    geos = d.get("geofences") or []
    pylon = next((g for g in geos if str(g.get("name", "")).lower() == "pylons"), None)
    pylon_ok = bool(pylon and pylon.get("enabled") and pylon.get("notifyOnEnter"))
    msg = (pylon.get("entryNotifyMessage") or "")[:50] if pylon else None
    results.append(
        (
            "Geofences API",
            st == 200 and len(geos) > 0,
            f"status={st} count={len(geos)} err={err}",
        )
    )
    results.append(
        (
            "Pylons notify-on-enter",
            pylon_ok,
            f"found={bool(pylon)} enabled={None if not pylon else pylon.get('enabled')} "
            f"notify={None if not pylon else pylon.get('notifyOnEnter')} msg={msg}",
        )
    )

    st, d, err = get(
        BASE + "/api/history?list=logbook&days=7&tz=Pacific/Auckland", H
    )
    days = d.get("days") or []
    from datetime import timedelta, timezone

    auckland = timezone(timedelta(hours=12))  # NZST (approx; health check only)
    today = datetime.now(auckland).date().isoformat()
    day = next((x for x in days if x.get("date") == today), None)
    dist = (day or {}).get("distanceM") or 0
    results.append(
        (
            "Logbook API",
            st == 200 and d.get("ok") is not False,
            f"status={st} days={len(days)} today={today} todayDistM={round(dist)} "
            f"sessions={(day or {}).get('sessionCount')} err={err}",
        )
    )

    st, d, err = get(OVERLAY + "/api/traccar?action=snapshot&source=rowing")
    ov_dev = d.get("devices") or []
    ov_pos = d.get("positions") or []
    results.append(
        (
            "AHD overlay rowing snapshot",
            st == 200 and d.get("error") is None,
            f"status={st} devices={len(ov_dev)} positions={len(ov_pos)} "
            f"err={err or d.get('error')}",
        )
    )

    st, d, err = get(
        OVERLAY
        + "/api/traccar?action=logbook&source=rowing&days=7&tz=Pacific/Auckland"
    )
    ov_days = d.get("days") or []
    results.append(
        (
            "AHD overlay logbook",
            st == 200 and d.get("ok") is not False and d.get("error") is None,
            f"status={st} days={len(ov_days)} err={err or d.get('error')}",
        )
    )

    print()
    fails = 0
    for name, passed, detail in results:
        mark = "PASS" if passed else "FAIL"
        if not passed:
            fails += 1
        print(f"[{mark}] {name}")
        print(f"       {detail}")

    print()
    print("Online devices (up to 12):")
    for x in sorted(online, key=lambda z: str(z.get("deviceId")))[:12]:
        print(
            f"  {x.get('deviceId')} athlete={x.get('athleteId') or '-'} "
            f"lastSeenAgo={x.get('lastSeenAgoSec')}s"
        )
    if not online:
        print("  (none online right now)")

    print()
    print(f"Summary: {len(results) - fails}/{len(results)} checks passed")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
