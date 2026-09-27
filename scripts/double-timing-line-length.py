#!/usr/bin/env python3
"""Double timing line segment length while keeping the midpoint fixed."""

import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
COURSE_GROUP = "2 km course"
EARTH_R = 6371000
HEADERS = {
    "Accept": "application/json",
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl, dn = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dl / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dn / 2) ** 2
    return 2 * EARTH_R * math.asin(min(1, math.sqrt(h)))


def double_endpoints(lat1, lon1, lat2, lon2):
    mid_lat = (lat1 + lat2) / 2
    mid_lon = (lon1 + lon2) / 2
    d_lat = lat2 - lat1
    d_lon = lon2 - lon1
    return (
        mid_lat - d_lat,
        mid_lon - d_lon,
        mid_lat + d_lat,
        mid_lon + d_lon,
    )


def fetch(url, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def main():
    dry_run = "--dry-run" in sys.argv
    payload = fetch(f"{BASE}/api/timing-lines")
    lines = [
        l
        for l in payload.get("lines", [])
        if (l.get("courseGroup") or "Other") == COURSE_GROUP and l.get("enabled", True)
    ]
    if not lines:
        print(f"No enabled lines found for course group {COURSE_GROUP!r}")
        return 1

    print(f"{'DRY RUN — ' if dry_run else ''}Doubling line length for {len(lines)} lines in {COURSE_GROUP!r}")
    print(f"{'ID':>4}  {'Type':<7}  {'Name':<16}  {'Before m':>9}  {'After m':>9}")
    print("-" * 58)

    updates = []
    for line in sorted(lines, key=lambda l: (l.get("sortOrder", 0), l.get("distanceM") or 0, l["id"])):
        lat1, lon1, lat2, lon2 = line["lat1"], line["lon1"], line["lat2"], line["lon2"]
        before = haversine_m(lat1, lon1, lat2, lon2)
        n1, nl1, n2, nl2 = double_endpoints(lat1, lon1, lat2, lon2)
        after = haversine_m(n1, nl1, n2, nl2)
        print(
            f"{line['id']:>4}  {line.get('lineType','?'):<7}  {(line.get('name') or '')[:16]:<16}  "
            f"{before:9.1f}  {after:9.1f}"
        )
        updates.append(
            {
                "id": line["id"],
                "name": line.get("name"),
                "before_m": before,
                "after_m": after,
                "body": {"lat1": n1, "lon1": nl1, "lat2": n2, "lon2": nl2},
            }
        )

    if dry_run:
        print("\nDry run only — no changes written.")
        return 0

    ok = 0
    for item in updates:
        url = f"{BASE}/api/timing-lines?id={urllib.parse.quote(str(item['id']))}"
        try:
            res = fetch(url, method="PATCH", body=item["body"])
            if not res.get("ok"):
                print(f"FAILED id={item['id']}: {res}")
                continue
            ok += 1
        except urllib.error.HTTPError as err:
            print(f"FAILED id={item['id']}: HTTP {err.code} {err.read().decode()[:200]}")
        except Exception as err:
            print(f"FAILED id={item['id']}: {err}")

    print(f"\nUpdated {ok}/{len(updates)} lines.")
    return 0 if ok == len(updates) else 1


if __name__ == "__main__":
    raise SystemExit(main())
