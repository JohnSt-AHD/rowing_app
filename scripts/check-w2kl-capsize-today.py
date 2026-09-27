#!/usr/bin/env python3
"""Capsize events for W2- KL today (Pacific/Auckland)."""
import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
UID = "W2- KL"
AUCKLAND = timezone(timedelta(hours=12))


def get(path: str):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fmt_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc).astimezone(AUCKLAND).strftime(
        "%Y-%m-%d %H:%M:%S %Z"
    )


def main():
    now_utc = datetime.now(timezone.utc)
    day_start = datetime(2026, 7, 20, 0, 0, 0, tzinfo=AUCKLAND).astimezone(timezone.utc)
    frm = day_start.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to = now_utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    print(f"Auckland today window: {frm} -> {to}\n")

    lb = get("/api/history?list=logbook&days=2&tz=Pacific/Auckland")
    for day in lb.get("days", []):
        if day.get("date") == "2026-07-20":
            print("=== logbook 2026-07-20 ===")
            print("capsizeCount:", day.get("capsizeCount"))
            for s in day.get("sessions", []):
                if UID.replace(" ", "") in (s.get("deviceName") or "").replace(" ", ""):
                    print(json.dumps(s, indent=2))

    devs = get("/api/devices?windowSec=86400&onlineSec=86400&includeMetrics=1").get(
        "devices", []
    )
    d = next((x for x in devs if x.get("deviceId") == UID), None)
    print("\n=== device capsize alert state ===")
    if d:
        keys = [k for k in d if "capsize" in k.lower()]
        print({k: d.get(k) for k in keys})

    sess = get(f"/api/history?list=sessions&uniqueId={urllib.parse.quote(UID)}").get(
        "sessions", []
    )
    today_sess = []
    for s in sess:
        started = s.get("started_at") or ""
        if started >= frm or started >= "2026-07-20":
            today_sess.append(s)
    print(f"\n=== sessions touching today: {len(today_sess)} ===")
    for s in today_sess:
        print(
            s.get("session_id", "")[:8],
            "started",
            s.get("started_at"),
            "samples",
            s.get("sample_count"),
        )

    enc_uid = urllib.parse.quote(UID, safe="")
    data = get(
        f"/api/history?format=dashboard&uniqueId={enc_uid}&from={urllib.parse.quote(frm)}&to={urllib.parse.quote(to)}"
    )
    track = data.get("track") or []
    caps = [p for p in track if p.get("capsize")]
    print(
        f"\n=== dashboard today: points={data.get('pointCount')} gps={data.get('gpsCount')} "
        f"capsizeSamples={data.get('capsizeSampleCount')} incidents={len(data.get('capsizeEvents') or [])} ==="
    )

    if caps:
        print("\nAll capsize track points:")
        for p in caps:
            loc = (
                f"{p.get('lat'):.6f}, {p.get('lon'):.6f}"
                if p.get("lat") is not None
                else "no GPS"
            )
            print(f"  {fmt_ms(p['t'])}  {loc}  tilt={p.get('tiltDeg')}")
    else:
        print("No capsize=true samples in today's track.")

    events = data.get("capsizeEvents") or []
    if events:
        print("\nCollapsed capsize incidents (GPS):")
        for ev in events:
            print(
                f"  {fmt_ms(ev['t'])}  {ev.get('lat'):.6f}, {ev.get('lon'):.6f}  tilt={ev.get('tiltDeg')}"
            )

    # Nearest GPS for motion-only capsizes in today's session
    sid = today_sess[0]["session_id"] if today_sess else None
    if sid:
        sdata = get(f"/api/history?format=dashboard&sessionId={sid}")
        strack = sdata.get("track") or []
        scaps = [p for p in strack if p.get("capsize")]
        print(f"\n=== today's session {sid[:8]} capsize points: {len(scaps)} ===")
        gps_pts = [p for p in strack if p.get("lat") is not None]
        for p in scaps:
            loc = "no GPS"
            if p.get("lat") is not None:
                loc = f"{p.get('lat'):.6f}, {p.get('lon'):.6f}"
            else:
                best = min(gps_pts, key=lambda g: abs(g["t"] - p["t"]), default=None)
                if best and abs(best["t"] - p["t"]) <= 120000:
                    loc = f"~{best.get('lat'):.6f}, {best.get('lon'):.6f} (nearest GPS {abs(best['t']-p['t'])/1000:.0f}s)"
            print(f"  {fmt_ms(p['t'])}  {loc}  tilt={p.get('tiltDeg')}")

    # Raw ingest samples for today's session
    if sid:
        raw = get(f"/api/ingest?sessionId={sid}")
        samples = raw.get("samples") or []
        raw_caps = [
            s
            for s in samples
            if (s.get("derived") or {}).get("capsize") or s.get("capsize")
        ]
        print(f"\n=== raw ingest today session: {len(samples)} samples, {len(raw_caps)} capsize ===")

    # All-time W2-KL capsizes
    print("\n=== all stored W2-KL capsize samples ===")
    for s in get(f"/api/history?list=sessions&uniqueId={urllib.parse.quote(UID)}").get(
        "sessions", []
    ):
        sdata = get(f"/api/history?format=dashboard&sessionId={s['session_id']}")
        scaps = [p for p in (sdata.get("track") or []) if p.get("capsize")]
        if not scaps:
            continue
        print(f"session {s['session_id'][:8]} started {s.get('started_at')} ({len(scaps)} samples)")
        gps_pts = [p for p in (sdata.get("track") or []) if p.get("lat") is not None]
        for p in scaps:
            loc = "no GPS"
            if p.get("lat") is not None:
                loc = f"{p.get('lat'):.6f}, {p.get('lon'):.6f}"
            elif gps_pts:
                best = min(gps_pts, key=lambda g: abs(g["t"] - p["t"]))
                if abs(best["t"] - p["t"]) <= 120000:
                    loc = f"~{best.get('lat'):.6f}, {best.get('lon'):.6f}"
            print(f"  {fmt_ms(p['t'])}  {loc}  tilt={p.get('tiltDeg')}")

    # M4x JS capsize today (only capsize on logbook today)
    m4_sid = "1c520948-ab15-4f63-a6f0-33471c73055f"
    m4 = get(f"/api/history?format=dashboard&sessionId={m4_sid}")
    print("\n=== M4x JS capsize session today (for reference) ===")
    for p in [x for x in (m4.get("track") or []) if x.get("capsize")]:
        loc = f"{p.get('lat'):.6f}, {p.get('lon'):.6f}" if p.get("lat") else "no GPS"
        print(f"  {fmt_ms(p['t'])}  {loc}  tilt={p.get('tiltDeg')}")
    for ev in m4.get("capsizeEvents") or []:
        print(
            f"  incident {fmt_ms(ev['t'])}  {ev.get('lat'):.6f}, {ev.get('lon'):.6f}"
        )


if __name__ == "__main__":
    main()
