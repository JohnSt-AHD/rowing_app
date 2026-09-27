#!/usr/bin/env python3
"""Live M1x TM reporting diagnosis — app vs server."""
import json
import statistics
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
DEVICE = "M1x TM"


def get(path, auth=True):
    headers = {"Accept": "application/json"}
    if auth:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(BASE + path, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def fmt_ts(ms):
    if ms is None:
        return "—"
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%H:%M:%S")


def gap_stats(ts_ms):
    ts = sorted(ts_ms)
    if len(ts) < 2:
        return None
    gaps = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
    gs = sorted(gaps)
    dur = (ts[-1] - ts[0]) / 1000
    return {
        "n": len(ts),
        "dur_sec": round(dur, 1),
        "median_gap": round(statistics.median(gaps), 2),
        "mean_gap": round(statistics.mean(gaps), 2),
        "p95_gap": round(gs[int(0.95 * (len(gs) - 1))], 2),
        "max_gap": round(max(gaps), 2),
        "min_gap": round(min(gaps), 2),
        "hz": round(len(ts) / dur, 3) if dur > 0 else 0,
        "burst_1s": sum(1 for g in gaps if g <= 1.5),
        "burst_3s": sum(1 for g in gaps if 1.5 < g <= 4.0),
        "slow_5s": sum(1 for g in gaps if g > 4.0),
    }


def print_device(d, label=""):
    g = d.get("gps") or {}
    hb = d.get("heartbeat") or {}
    drv = d.get("derived") or {}
    print(f"\n--- {label or DEVICE} ---")
    print(
        f" online={d.get('online')} session={str(d.get('sessionId', ''))[:12]}…"
        f" lastSeen={d.get('lastSeenAgoSec')}s ingestHz={d.get('ingestRateHz')}"
    )
    print(
        f" GPS present={g.get('present')} rateHz={g.get('rateHz')} count={g.get('count')}"
        f" ageSec={g.get('ageSec')} displayAge={g.get('displayAgeSec')}"
    )
    print(
        f" fixClockAge={g.get('gpsFixAgeSec')} uploadLag={g.get('uploadLagSec')}"
        f" fixClockLag={g.get('fixClockLagSec')} ingestAgo={g.get('ingestAgoSec')}"
    )
    last = g.get("last") or {}
    print(
        f" lastFix uploadT={fmt_ts(last.get('t'))} fixMs={fmt_ts(last.get('fixMs'))}"
        f" provider={last.get('provider')} source={last.get('sampleSource')}"
    )
    print(
        f" heartbeat rateHz={hb.get('rateHz')} ageSec={hb.get('ageSec')}"
        f" inBoatPark={drv.get('inBoatPark')} capsize={d.get('rowing', {}).get('capsize')}"
    )


def main():
    print(f"=== Live check {DEVICE} @ {datetime.now(timezone.utc).isoformat()} ===")

    # Poll devices 6 times over ~25s to see server-side receive cadence
    poll_snapshots = []
    for i in range(6):
        data = get("/api/devices?windowSec=300&onlineSec=600&includeMetrics=1")
        d = next((x for x in data.get("devices", []) if x.get("deviceId") == DEVICE), None)
        health = data.get("health") or {}
        if d:
            g = d.get("gps") or {}
            poll_snapshots.append(
                {
                    "i": i,
                    "polledAt": data.get("polledAt"),
                    "lastSeenAgoSec": d.get("lastSeenAgoSec"),
                    "ingestHz": d.get("ingestRateHz"),
                    "gpsHz": g.get("rateHz"),
                    "gpsCount": g.get("count"),
                    "ageSec": g.get("ageSec"),
                    "displayAgeSec": g.get("displayAgeSec"),
                    "gpsFixAgeSec": g.get("gpsFixAgeSec"),
                    "uploadLagSec": g.get("uploadLagSec"),
                    "fixClockLagSec": g.get("fixClockLagSec"),
                    "totalSamples": d.get("totalSamples"),
                }
            )
        else:
            poll_snapshots.append({"i": i, "missing": True})
        if i == 0:
            print(f" storage={data.get('storage')} persisted={data.get('persisted')}")
            print(f" fleet health: {json.dumps(health, default=str)}")
            if d:
                print_device(d, "current snapshot")
        time.sleep(5)

    print("\n--- Poll cadence (server view, 5s apart) ---")
    for s in poll_snapshots:
        if s.get("missing"):
            print(f" [{s['i']}] NOT FOUND")
            continue
        print(
            f" [{s['i']}] lastSeen={s['lastSeenAgoSec']}s ingestHz={s['ingestHz']}"
            f" gpsHz={s['gpsHz']} gpsCnt={s['gpsCount']} total={s['totalSamples']}"
            f" age={s['ageSec']} display={s['displayAgeSec']}"
            f" fixClock={s['gpsFixAgeSec']} uploadLag={s['uploadLagSec']}"
            f" fixLag={s['fixClockLagSec']}"
        )

    # Map position
    try:
        mp = get("/api/map-positions?onlineSec=600&staleSec=3600", auth=False)
        pos = next((p for p in mp.get("positions", []) if p.get("deviceId") == DEVICE), None)
        if pos:
            print("\n--- Map position ---")
            print(json.dumps(pos, indent=2, default=str))
        else:
            print("\n--- Map position: not on map ---")
    except Exception as e:
        print(f"\n--- Map position error: {e} ---")

    # Recent history (last 30 min)
    now = datetime.now(timezone.utc)
    from_dt = (now - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    to_dt = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    route = get(
        f"/api/history?uniqueId={urllib.parse.quote(DEVICE)}&from={urllib.parse.quote(from_dt)}&to={urllib.parse.quote(to_dt)}"
    )
    positions = route.get("positions") or []
    print(f"\n--- History route last 30m: {len(positions)} GPS points ---")
    if positions:
        ts = []
        upload_lags = []
        fix_ages = []
        for p in positions[-8:]:
            t_ms = p.get("t")
            if t_ms is None and p.get("fixTime"):
                t_ms = int(
                    datetime.fromisoformat(str(p["fixTime"]).replace("Z", "+00:00")).timestamp()
                    * 1000
                )
            ts.append(t_ms)
            attrs = p.get("attributes") or {}
            print(
                f"  {fmt_ts(t_ms)} lat={p.get('latitude')} uploadLag={attrs.get('uploadLagSec')}"
                f" fixAge={attrs.get('gpsFixAgeSec')} source={attrs.get('gpsSampleSource')}"
            )
            if attrs.get("uploadLagSec") is not None:
                upload_lags.append(float(attrs["uploadLagSec"]))
            if attrs.get("gpsFixAgeSec") is not None:
                fix_ages.append(float(attrs["gpsFixAgeSec"]))
        stats = gap_stats([p.get("t") or 0 for p in positions if p.get("t")])
        if stats:
            print(f" GPS gap stats: {json.dumps(stats)}")
        if upload_lags:
            print(
                f" uploadLagSec median={statistics.median(upload_lags):.1f}"
                f" max={max(upload_lags):.1f} (from attrs on tail)"
            )

    # Active session ingest samples
    d0 = get("/api/devices?windowSec=300&onlineSec=600")
    dev = next((x for x in d0.get("devices", []) if x.get("deviceId") == DEVICE), None)
    sid = dev.get("sessionId") if dev else None
    if sid:
        raw = get(f"/api/ingest?sessionId={urllib.parse.quote(sid, safe='')}")
        samples = raw.get("samples") or []
        gps_samples = [s for s in samples if s.get("gps")]
        gps_ts = [s["t"] for s in gps_samples]
        all_ts = [s["t"] for s in samples]
        print(f"\n--- Session ingest ({sid[:12]}…) samples={len(samples)} gps={len(gps_samples)} ---")
        gps_stats = gap_stats(gps_ts)
        all_stats = gap_stats(all_ts)
        if gps_stats:
            print(f" GPS upload gaps: {json.dumps(gps_stats)}")
        if all_stats:
            print(f" All-sample gaps: {json.dumps(all_stats)}")
        # Burst detection: clusters of >=3 uploads within 5s windows
        bursts = 0
        for i in range(len(all_ts)):
            window_end = all_ts[i] + 5000
            cnt = sum(1 for t in all_ts if all_ts[i] <= t <= window_end)
            if cnt >= 4:
                bursts += 1
        print(f" 5s windows with >=4 uploads: {bursts} (higher => burst upload pattern)")
        for s in gps_samples[-6:]:
            g = s.get("gps") or {}
            t_upload = s.get("t")
            fix_ms = g.get("fixMs")
            if fix_ms:
                lag = (t_upload - fix_ms) / 1000
                print(
                    f"  upload={fmt_ts(t_upload)} fixMs={fmt_ts(fix_ms)} lag={lag:.1f}s"
                    f" source={g.get('sampleSource')}"
                )
            else:
                print(f"  upload={fmt_ts(t_upload)} no fixMs source={g.get('sampleSource')}")
    else:
        print("\n--- No active session for ingest ---")

    # Compare poll totalSamples delta
    valid = [s for s in poll_snapshots if not s.get("missing")]
    if len(valid) >= 2:
        d_total = valid[-1]["totalSamples"] - valid[0]["totalSamples"]
        d_gps = valid[-1]["gpsCount"] - valid[0]["gpsCount"]
        elapsed = (len(valid) - 1) * 5
        print(
            f"\n--- Over {elapsed}s poll window: totalSamples +{d_total}, gpsCount +{d_gps} ---"
        )
        if d_gps > elapsed / 2:
            print(" => High GPS count growth: app sending frequently (not server batching alone)")
        elif d_gps <= 1 and valid[-1]["lastSeenAgoSec"] <= 10:
            print(" => Steady/low GPS growth with fresh lastSeen: likely economy or sparse GPS")
        if valid[-1].get("uploadLagSec") and valid[-1]["uploadLagSec"] > 30:
            print(" => Large uploadLag: fix timestamp old before upload (app-side batch/cache)")
        if valid[-1].get("fixClockLagSec") and valid[-1]["fixClockLagSec"] > 20:
            print(" => fixClockLag: satellite fix clock behind upload clock")


if __name__ == "__main__":
    main()
