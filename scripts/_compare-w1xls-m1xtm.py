#!/usr/bin/env python3
"""Compare W1x LS (live) vs M1x TM (earlier today) APK GPS reporting."""
import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
AUCKLAND = timezone(timedelta(hours=12))
NOW = datetime.now(AUCKLAND)
TODAY = NOW.date()


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def hav(a, b, c, d):
    r = 6371000
    p1, p2 = math.radians(a), math.radians(c)
    dlat, dlon = math.radians(c - a), math.radians(d - b)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(h)))


def split500(v):
    if v is None or v < 0.25:
        return None
    s = 500 / float(v)
    return f"{int(s // 60)}:{s % 60:04.1f}"


def to_ms(t):
    if t is None:
        return None
    if isinstance(t, (int, float)):
        return float(t)
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def analyze_track(track, label, t_min=None, t_max=None):
    gps = [p for p in track if p.get("lat") is not None]
    if t_min:
        gps = [p for p in gps if p["t"] >= t_min]
    if t_max:
        gps = [p for p in gps if p["t"] <= t_max]
    gps = sorted(gps, key=lambda x: x["t"])
    if len(gps) < 2:
        print(f"  {label}: only {len(gps)} fixes")
        return None
    gaps = []
    dists = []
    implied = []
    teleports = []
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        gaps.append(dt)
        dists.append(dist)
        if dt > 0:
            implied.append(dist / dt)
        if dt <= 8 and dist > 35:
            teleports.append((dt, dist, dist / dt if dt else 0))
    gs = sorted(gaps)
    out = {
        "fixes": len(gps),
        "span_min": round((gps[-1]["t"] - gps[0]["t"]) / 60000, 1),
        "median_gap_s": round(statistics.median(gaps), 2),
        "p95_gap_s": round(gs[int(0.95 * (len(gs) - 1))], 2),
        "max_gap_s": round(max(gaps), 1),
        "gaps_ge_8s": sum(1 for g in gaps if g >= 8),
        "gaps_le_1s": sum(1 for g in gaps if g <= 1),
        "median_dist_m": round(statistics.median(dists), 1),
        "p95_dist_m": round(sorted(dists)[int(0.95 * (len(dists) - 1))], 1),
        "median_implied_mps": round(statistics.median(implied), 2) if implied else None,
        "teleports_35m_in_8s": len(teleports),
        "fixMs_pct": round(
            100
            * sum(1 for p in gps if p.get("fixMs") or (p.get("attributes") or {}).get("gpsFixMs"))
            / len(gps),
            1,
        ),
    }
    prov = {}
    src = {}
    for p in gps[-40:]:
        attrs = p.get("attributes") or {}
        pr = attrs.get("provider") or p.get("provider") or "none"
        ss = attrs.get("sampleSource") or p.get("sampleSource") or "none"
        prov[pr] = prov.get(pr, 0) + 1
        src[ss] = src.get(ss, 0) + 1
    out["providers_tail40"] = prov
    out["sources_tail40"] = src
    print(f"  {label}: {out}")
    return out


def map_snapshot(uid):
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == uid), None)
    dev = get("/api/devices?windowSec=120&onlineSec=600&includeMetrics=1")
    d = next((x for x in dev.get("devices", []) if x.get("deviceId") == uid), None)
    print(f"\n{'=' * 70}\n  LIVE MAP: {uid}\n{'=' * 70}")
    if not pos:
        print("  not on map")
        return
    legacy = pos.get("gpsFixMs") is None and pos.get("gpsProvider") is None
    print(
        f"  online={pos.get('online')} seen={pos.get('lastSeenAgoSec')}s "
        f"fixAge={pos.get('fixAgeSec')}s ingestAgo={pos.get('ingestAgoSec')}s"
    )
    print(
        f"  APK debug: {'LEGACY' if legacy else 'NEW'} "
        f"gpsProvider={pos.get('gpsProvider')} sampleSource={pos.get('gpsSampleSource')} "
        f"uploadLag={pos.get('uploadLagSec')}s gpsFixAge={pos.get('gpsFixAgeSec')}s"
    )
    print(
        f"  pace raw={split500(pos.get('speed'))} path={split500(pos.get('pathSpeedMps'))} "
        f"display={split500(pos.get('displaySpeedMps'))} acc={pos.get('accuracy')} "
        f"stroke={pos.get('displayStrokeRate')}"
    )
    if d:
        g = d.get("gps") or {}
        print(
            f"  devices API: gpsHz={g.get('rateHz')} cnt={g.get('count')} "
            f"fixAge={g.get('ageSec')}s ingestAgo={g.get('ingestAgoSec')}s"
        )
    polls = []
    prev = None
    for i in range(6):
        mp2 = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
        p2 = next(x for x in mp2["positions"] if x["deviceId"] == uid)
        row = {
            "i": i,
            "fixAge": p2.get("fixAgeSec"),
            "path": round(p2.get("pathSpeedMps") or 0, 2),
            "disp": round(p2.get("displaySpeedMps") or 0, 2),
            "raw": round(p2.get("speed") or 0, 2),
        }
        if prev:
            row["poll_jump_m"] = round(
                hav(prev["latitude"], prev["longitude"], p2["latitude"], p2["longitude"]),
                1,
            )
        polls.append(row)
        prev = p2
        if i < 5:
            time.sleep(3)
    print("  map poll (3s):", polls)
    path_jumps = [p.get("poll_jump_m") for p in polls if p.get("poll_jump_m") is not None]
    if path_jumps:
        print(
            f"  poll position jumps: med={statistics.median(path_jumps):.1f}m "
            f"max={max(path_jumps):.1f}m"
        )


def session_analysis(uid, prefer_today=True, morning_only=False):
    print(f"\n{'=' * 70}\n  HISTORY: {uid}\n{'=' * 70}")
    sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote(uid)).get("sessions") or []
    if not sess:
        print("  no sessions")
        return
    picked = None
    for s in sess:
        st = datetime.fromisoformat(str(s["started_at"]).replace("Z", "+00:00")).astimezone(AUCKLAND)
        if prefer_today and st.date() != TODAY:
            continue
        if morning_only and st.hour >= 12:
            continue
        picked = s
        break
    if not picked:
        picked = sess[0]
    st = datetime.fromisoformat(str(picked["started_at"]).replace("Z", "+00:00")).astimezone(AUCKLAND)
    sid = picked["session_id"]
    print(
        f"  session {sid[:8]} started {st.strftime('%Y-%m-%d %H:%M')} "
        f"samples={picked.get('sample_count')}"
    )
    track = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid)).get("track") or []
    gps = [p for p in track if p.get("lat") is not None]
    moving = [p for p in gps if (p.get("spd") or 0) > 0.5]
    if len(moving) >= 20:
        t0 = moving[0]["t"]
        t1 = moving[-1]["t"]
        analyze_track(track, "moving window", t_min=t0, t_max=t1)
    analyze_track(track, "full session")
    t_start = to_ms(picked.get("started_at"))
    analyze_track(track, "first 60 min", t_min=t_start, t_max=t_start + 3600000)


def main():
    print(f"Compare APK reporting @ {NOW.strftime('%Y-%m-%d %H:%M:%S')} NZ")
    map_snapshot("W1x LS")
    session_analysis("W1x LS", prefer_today=True)
    map_snapshot("M1x TM")
    # M1x TM has no session on Aug 3 — use latest morning session (Jul 30) as reference.
    print("\n  NOTE: M1x TM has no session today; comparing latest outing Jul 30 morning.")
    session_analysis("M1x TM", prefer_today=False, morning_only=False)
    deep_compare()


def deep_compare():
    print(f"\n{'=' * 70}\n  DEEP COMPARE\n{'=' * 70}")

    w1 = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("W1x LS")).get("sessions") or []
    m1 = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M1x TM")).get("sessions") or []
    if not w1 or not m1:
        return

    w_track = get(
        "/api/history?format=dashboard&sessionId=" + urllib.parse.quote(w1[0]["session_id"])
    ).get("track") or []
    m_track = get(
        "/api/history?format=dashboard&sessionId=" + urllib.parse.quote(m1[0]["session_id"])
    ).get("track") or []

    w_start = to_ms(w1[0]["started_at"])
    analyze_track(w_track, "W1x LS today (full)", t_min=w_start, t_max=w_start + 55 * 60 * 1000)

    m_start = to_ms(m1[0]["started_at"])
    analyze_track(m_track, "M1x TM Jul 30 (first 90m)", t_min=m_start, t_max=m_start + 90 * 60 * 1000)

    gps = sorted([p for p in w_track if p.get("lat")], key=lambda x: x["t"])
    print("\n  W1x LS sample GPS jumps (>30m within 5s):")
    shown = 0
    for i in range(1, len(gps)):
        dt = (gps[i]["t"] - gps[i - 1]["t"]) / 1000
        dist = hav(gps[i - 1]["lat"], gps[i - 1]["lon"], gps[i]["lat"], gps[i]["lon"])
        if dt <= 5 and dist > 30 and shown < 10:
            ts = datetime.fromtimestamp(gps[i]["t"] / 1000, tz=AUCKLAND).strftime("%H:%M:%S")
            attrs = gps[i].get("attributes") or {}
            print(
                f"    {ts} dt={dt:.1f}s dist={dist:.0f}m acc={gps[i].get('acc')} "
                f"spd={gps[i].get('spd')} src={attrs.get('sampleSource')} prov={attrs.get('provider')}"
            )
            shown += 1

    # Live map fields for W1x LS
    mp = get("/api/map-positions?onlineSec=600&staleSec=7200&predictMode=rowing")
    pos = next(p for p in mp["positions"] if p["deviceId"] == "W1x LS")
    print("\n  W1x LS live map telemetry fields:")
    for k in [
        "gpsProvider",
        "gpsSampleSource",
        "gpsFixMs",
        "gpsFixAgeSec",
        "uploadLagSec",
        "fixAgeSec",
        "ingestAgoSec",
        "pathSpeedMps",
        "displaySpeedMps",
        "recentPathSpeedMps",
        "speed",
        "accuracy",
        "telemetryStale",
    ]:
        if pos.get(k) is not None:
            print(f"    {k}={pos.get(k)}")


if __name__ == "__main__":
    main()
