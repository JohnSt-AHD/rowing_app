#!/usr/bin/env python3
"""Compare app versions for W1x LS and M1x TM."""
import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UIDS = ["W1x LS", "M1x TM"]
NZ = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def find_version(obj, path=""):
    hits = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            lk = str(k).lower()
            if any(x in lk for x in ("version", "appversion", "build", "apk", "versionname", "versioncode")):
                hits.append((f"{path}.{k}" if path else k, v))
            hits.extend(find_version(v, f"{path}.{k}" if path else k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:50]):
            hits.extend(find_version(v, f"{path}[{i}]"))
    return hits


def main():
    print(f"=== Version check {datetime.now(NZ).strftime('%Y-%m-%d %H:%M:%S')} NZ ===\n")

    # Devices list
    try:
        devs = get("/api/devices?windowSec=604800&onlineSec=604800&includeMetrics=1").get("devices") or []
    except Exception as e:
        print("devices failed:", e)
        devs = []

    for uid in UIDS:
        print(f"========== {uid} ==========")
        d = next((x for x in devs if x.get("deviceId") == uid), None)
        if d:
            hits = find_version(d)
            print("Devices API version-ish fields:")
            if hits:
                for k, v in hits:
                    print(f"  {k} = {v}")
            else:
                print("  (none found)")
            # also print top-level keys for clues
            metaish = {k: d.get(k) for k in d if any(x in k.lower() for x in ("meta", "app", "ver", "client", "ua", "user"))}
            if metaish:
                print("  metaish:", metaish)
        else:
            print("  not in devices window")

        enc = urllib.parse.quote(uid, safe="")
        sessions = get(f"/api/history?list=sessions&uniqueId={enc}").get("sessions") or []
        print(f"Sessions: {len(sessions)}")
        for s in sessions[:3]:
            sid = s.get("session_id") or s.get("sessionId")
            print(f"  session {str(sid)[:8]} started={s.get('started_at') or s.get('startedAt')}")
            hits = find_version(s)
            for k, v in hits:
                print(f"    {k} = {v}")
            if sid:
                dash = get(f"/api/history?format=dashboard&sessionId={urllib.parse.quote(sid)}")
                hits = find_version({k: dash.get(k) for k in dash if k != "track"})
                print("  dashboard meta version-ish:")
                if hits:
                    for k, v in hits:
                        print(f"    {k} = {v}")
                else:
                    print("    (none in dashboard meta)")
                    print("    top keys:", sorted(dash.keys()))
                # inspect a few track points attributes
                track = dash.get("track") or []
                for p in track[:3]:
                    attrs = p.get("attributes") or {}
                    vh = find_version(p) + find_version(attrs)
                    if vh:
                        print("    track point version:", vh)

        # Try ingest endpoint if session known
        if sessions:
            sid = sessions[0].get("session_id") or sessions[0].get("sessionId")
            if sid:
                try:
                    ing = get(f"/api/ingest?sessionId={urllib.parse.quote(sid)}")
                    hits = find_version(ing)
                    print("  ingest peek version-ish:")
                    for k, v in hits[:20]:
                        print(f"    {k} = {v}")
                    if not hits:
                        print("    keys:", sorted(ing.keys()) if isinstance(ing, dict) else type(ing))
                except Exception as e:
                    print("  ingest peek failed:", e)
        print()


if __name__ == "__main__":
    main()
