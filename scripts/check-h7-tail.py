#!/usr/bin/env python3
"""Tail of H7 session: GPS vs heartbeats."""
import json
import urllib.request
from datetime import datetime, timezone
from urllib.parse import quote

BASE = "https://rowing-app-recorder-pwa.vercel.app"


def get(path: str):
    req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def to_ms(t) -> float:
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def main() -> None:
    sess = get("/api/history?list=sessions&uniqueId=H7")
    cur = sess.get("sessions", [{}])[0]
    st = cur["started_at"]
    sid = cur["session_id"][:8]
    from_iso = datetime.fromisoformat(st.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    route = get(f"/api/history?uniqueId=H7&from={quote(from_iso)}")
    now_ms = datetime.now(timezone.utc).timestamp() * 1000

    gps = hb = other = 0
    print(f"Session {sid} started {st} total points {len(route)}")
    print("\nLast 25 samples (newest last):")
    tail = route[-25:] if len(route) >= 25 else route
    for p in tail:
        if not isinstance(p, dict):
            continue
        attrs = p.get("attributes") or {}
        is_hb = bool(attrs.get("heartbeat"))
        has_gps = p.get("latitude") is not None
        ft = p.get("fixTime") or p.get("deviceTime")
        age = (now_ms - to_ms(ft)) / 1000 if ft else None
        if has_gps:
            gps += 1
            kind = "GPS"
        elif is_hb:
            hb += 1
            kind = "HB "
        else:
            other += 1
            kind = "??? "
        print(
            f"  {kind} fixTime={ft} age={age:.0f}s "
            f"lat={p.get('latitude')} stroke={attrs.get('strokeRate')}"
        )

    # Gap analysis: time since last GPS vs last any sample
    last_gps = None
    last_any = None
    for p in reversed(route):
        if not isinstance(p, dict):
            continue
        ft = p.get("fixTime") or p.get("deviceTime")
        if ft and last_any is None:
            last_any = to_ms(ft)
        if p.get("latitude") is not None and last_gps is None:
            last_gps = to_ms(ft)
        if last_gps and last_any:
            break

    print(f"\nLast GPS age: {(now_ms - last_gps) / 1000:.0f}s" if last_gps else "No GPS")
    print(f"Last sample age: {(now_ms - last_any) / 1000:.0f}s" if last_any else "No samples")


if __name__ == "__main__":
    main()
