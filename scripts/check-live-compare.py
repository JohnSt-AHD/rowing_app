#!/usr/bin/env python3
"""Compare H6 (RNZ ingest) vs Traccar devices start/H6."""
import json
import statistics
import urllib.request
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

ROWING = "https://rowing-app-recorder-pwa.vercel.app"
OVERLAY = "https://traccar-overlay.vercel.app"


def get(url: str):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def analyze_positions(positions, label: str) -> None:
    print(f"\n=== {label}: {len(positions)} points ===")
    if not positions:
        return
    for p in positions[-5:]:
        print(
            " ",
            p.get("fixTime") or datetime.fromtimestamp(p["t"] / 1000, tz=timezone.utc).isoformat(),
            p.get("latitude") or p.get("lat"),
            p.get("longitude") or p.get("lon"),
            "acc",
            p.get("accuracy"),
        )
    ts = []
    for p in positions:
        if "t" in p and "fixTime" not in p:
            ts.append(float(p["t"]))
        else:
            ft = p.get("fixTime") or p.get("deviceTime")
            ts.append(
                datetime.fromisoformat(str(ft).replace("Z", "+00:00")).timestamp() * 1000
            )
    ts.sort()
    if len(ts) >= 2:
        gaps = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
        dur = (ts[-1] - ts[0]) / 1000
        gs = sorted(gaps)
        print(
            f" median gap {statistics.median(gaps):.2f}s"
            f" p95 {gs[int(0.95 * len(gs))]:.2f}s"
            f" avg Hz {len(ts) / dur:.3f}"
        )


def main() -> None:
    now = datetime.now(timezone.utc)
    from_dt = (now - timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to_dt = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    print("=== KRI H6 (RNZ ingest) ===")
    dev = get(f"{ROWING}/api/devices?windowSec=300&onlineSec=120&includeMetrics=1")
    h6 = next((d for d in dev.get("devices", []) if d.get("deviceId") == "H6"), None)
    if h6:
        print(
            f" online={h6.get('online')} lastSeen={h6.get('lastSeenAgoSec')}s"
            f" gps={h6.get('gps')} heartbeat={h6.get('heartbeat')}"
        )
    route = get(
        f"{ROWING}/api/history?uniqueId=H6&from={quote(from_dt)}&to={quote(to_dt)}"
    )
    analyze_positions(route, "H6 GPS (history)")

    sess = get(f"{ROWING}/api/history?list=sessions&uniqueId=H6")
    if sess.get("sessions"):
        s = sess["sessions"][0]
        dash = get(
            f"{ROWING}/api/history?format=dashboard&sessionId={quote(s['session_id'])}"
        )
        track = dash.get("track") or []
        gps = [p for p in track if p.get("lat") is not None]
        print(
            f"\n active session {s['session_id'][:8]}"
            f" started {s['started_at']}"
            f" samples={len(track)} gps_fixes={len(gps)}"
        )
        if len(track) >= 2:
            ts = [p["t"] for p in track]
            gaps = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
            print(f" all-sample median gap {statistics.median(gaps):.2f}s")

    print("\n=== Traccar (via overlay) ===")
    snap = get(f"{OVERLAY}/api/traccar?action=snapshot&source=traccar")
    pos_by_dev = {p.get("deviceId"): p for p in snap.get("positions", [])}
    targets = []
    for d in snap.get("devices", []):
        uid = str(d.get("uniqueId") or "")
        name = str(d.get("name") or "")
        if uid.upper() in ("H6", "START") or name.upper() in ("H6", "START"):
            targets.append(d)
            p = pos_by_dev.get(d["id"])
            print(
                f" id={d['id']} uniqueId={uid!r} name={name!r}"
                f" status={d.get('status')} lastUpdate={d.get('lastUpdate')}"
            )
            if p:
                print(
                    f"   latest {p.get('fixTime')}"
                    f" {p.get('latitude')},{p.get('longitude')}"
                    f" acc={p.get('accuracy')}"
                )

    if not targets:
        print(" (no devices named H6 or start — listing all online)")
        for d in snap.get("devices", []):
            if d.get("status") == "online":
                print(f"  online id={d['id']} uniqueId={d.get('uniqueId')!r} name={d.get('name')!r}")

    for d in targets:
        did = d["id"]
        uid = d.get("uniqueId")
        route = get(
            f"{OVERLAY}/api/traccar?action=route&source=traccar&deviceId={did}"
            f"&from={quote(from_dt)}&to={quote(to_dt)}"
        )
        analyze_positions(route, f"Traccar {uid!r} route")


if __name__ == "__main__":
    main()
