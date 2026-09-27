#!/usr/bin/env python3
import json
import statistics
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

BASE = "https://rowing-app-recorder-pwa.vercel.app"
NZ = timezone(timedelta(hours=12))


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return json.load(r)


def ts_ms(p):
    t = p.get("t") or p.get("time")
    if t is None:
        return None
    if isinstance(t, (int, float)):
        return float(t)
    return datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp() * 1000


def analyze_sid(prefix):
    sessions = get("/api/history?list=sessions&uniqueId=A2").get("sessions", [])
    s = next(x for x in sessions if x["session_id"].startswith(prefix))
    tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []

    rows = []
    for p in tr:
        if p.get("lat") is None:
            continue
        ms = ts_ms(p)
        if ms is None:
            continue
        rows.append({"t": ms, "lat": p["lat"], "lon": p["lon"]})
    rows.sort(key=lambda r: r["t"])

    print(f"\nSession {prefix}  samples={s.get('sample_count')}  gps={len(rows)}")
    sess_st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
    print(f"Session started_at: {sess_st.strftime('%H:%M:%S')} NZ")

    if len(rows) < 2:
        return

    st = datetime.fromtimestamp(rows[0]["t"] / 1000, tz=NZ)
    en = datetime.fromtimestamp(rows[-1]["t"] / 1000, tz=NZ)
    dur_s = (rows[-1]["t"] - rows[0]["t"]) / 1000
    print(f"GPS span: {st.strftime('%H:%M:%S')} -> {en.strftime('%H:%M:%S')} ({dur_s:.0f}s = {dur_s/60:.1f}min)")

    gaps = [(rows[i]["t"] - rows[i - 1]["t"]) / 1000 for i in range(1, len(rows))]
    steady = [g for g in gaps if g >= 0.75]
    in10 = sum(1 for g in steady if 8.0 <= g <= 12.5)
    in1 = sum(1 for g in steady if 0.75 <= g <= 1.35)

    print(f"Steady gaps n={len(steady)} med={statistics.median(steady):.2f}s")
    print(f"1s band: {100*in1/len(steady):.1f}%   10s band: {100*in10/len(steady):.1f}%")
    print(f"Top gaps: {Counter(round(g, 2) for g in steady).most_common(8)}")
    print(f">30s stalls: {sum(1 for g in gaps if g > 30)}")

    # Show first/last 5 points
    print("First 5 fixes:")
    for r in rows[:5]:
        lt = datetime.fromtimestamp(r["t"] / 1000, tz=NZ).strftime("%H:%M:%S")
        print(f"  {lt}  t_ms={r['t']:.0f}")
    print("Last 5 fixes:")
    for r in rows[-5:]:
        lt = datetime.fromtimestamp(r["t"] / 1000, tz=NZ).strftime("%H:%M:%S")
        print(f"  {lt}  t_ms={r['t']:.0f}")

    # Segment ending ~08:13: window 08:06-08:13
    seg_start = datetime(2026, 7, 2, 8, 6, 0, tzinfo=NZ).timestamp() * 1000
    seg_end = datetime(2026, 7, 2, 8, 13, 30, tzinfo=NZ).timestamp() * 1000
    seg = [r for r in rows if seg_start <= r["t"] <= seg_end]
    if len(seg) >= 2:
        sg = [(seg[i]["t"] - seg[i - 1]["t"]) / 1000 for i in range(1, len(seg))]
        ss = [g for g in sg if g >= 0.75]
        s10 = sum(1 for g in ss if 8.0 <= g <= 12.5)
        s1 = sum(1 for g in ss if 0.75 <= g <= 1.35)
        sst = datetime.fromtimestamp(seg[0]["t"] / 1000, tz=NZ)
        sen = datetime.fromtimestamp(seg[-1]["t"] / 1000, tz=NZ)
        sdur = (seg[-1]["t"] - seg[0]["t"]) / 1000
        print(f"\nWindow 08:06-08:13:30 -> {len(seg)} pts, {sdur:.0f}s")
        print(f"  {sst.strftime('%H:%M:%S')} to {sen.strftime('%H:%M:%S')}")
        if ss:
            print(f"  steady med={statistics.median(ss):.2f}s  1s={100*s1/len(ss):.1f}%  10s={100*s10/len(ss):.1f}%")
            print(f"  top: {Counter(round(g, 2) for g in ss).most_common(6)}")


for prefix in ("7212e59d", "1df4736a"):
    analyze_sid(prefix)
