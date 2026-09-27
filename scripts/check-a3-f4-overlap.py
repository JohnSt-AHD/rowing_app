#!/usr/bin/env python3
"""A3 vs F4 overlap comparison during concurrent 1s test."""
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


def dedupe(pts, min_gap=0.75):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap:
            out.append(p)
    return out


def load_session(uid, prefix=None):
    sessions = get(f"/api/history?list=sessions&uniqueId={uid}").get("sessions", [])
    s = sessions[0]
    if prefix:
        s = next(x for x in sessions if x["session_id"].startswith(prefix))
    tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
    rows = sorted([{"t": p["t"]} for p in tr if p.get("lat")], key=lambda r: r["t"])
    return s, rows


def analyze_rows(rows, label):
    if len(rows) < 2:
        print(f"{label}: insufficient data ({len(rows)} pts)")
        return
    gaps = [(rows[i]["t"] - rows[i - 1]["t"]) / 1000 for i in range(1, len(rows))]
    steady = [g for g in gaps if g >= 0.75]
    micro = len(gaps) - len(steady)
    ded = dedupe(rows)
    dg = [(ded[i]["t"] - ded[i - 1]["t"]) / 1000 for i in range(1, len(ded))]
    in1 = sum(1 for g in dg if 0.75 <= g <= 1.35)
    dur = (rows[-1]["t"] - rows[0]["t"]) / 1000
    st = datetime.fromtimestamp(rows[0]["t"] / 1000, tz=NZ)
    en = datetime.fromtimestamp(rows[-1]["t"] / 1000, tz=NZ)
    print(f"\n{label}")
    print(f"  {st.strftime('%H:%M:%S')} -> {en.strftime('%H:%M:%S')}  ({dur:.0f}s)")
    print(f"  raw={len(rows)} dedup={len(ded)}  rate={len(ded)/max(dur,1):.2f}/s  expected ~{dur:.0f} @1s")
    print(f"  micro gaps (<0.75s): {micro}")
    print(f"  dedup median={statistics.median(dg):.3f}s  1s band={100*in1/len(dg):.1f}%")
    print(f"  stalls >5s: {sum(1 for g in dg if g > 5)}  >10s: {sum(1 for g in dg if g > 10)}")
    print(f"  top dedup gaps: {Counter(round(g, 2) for g in dg).most_common(6)}")
    big = [(g, datetime.fromtimestamp(ded[i+1]['t']/1000, tz=NZ).strftime('%H:%M:%S'))
           for i, g in enumerate(dg) if g > 5]
    if big:
        print(f"  large gaps: {big}")


_, a3 = load_session("A3", "8c5cb0f8")
_, f4 = load_session("F4", "b96df90f")

overlap_start = max(a3[0]["t"], f4[0]["t"])
overlap_end = min(a3[-1]["t"], f4[-1]["t"])
a3_ov = [p for p in a3 if overlap_start <= p["t"] <= overlap_end]
f4_ov = [p for p in f4 if overlap_start <= p["t"] <= overlap_end]

ost = datetime.fromtimestamp(overlap_start / 1000, tz=NZ)
oen = datetime.fromtimestamp(overlap_end / 1000, tz=NZ)
print(f"=== Overlap window: {ost.strftime('%H:%M:%S')} - {oen.strftime('%H:%M:%S')} NZ ===")

analyze_rows(a3, "A3 CrewSight (full session)")
analyze_rows(f4, "F4 KRI (full session)")
analyze_rows(a3_ov, "A3 overlap")
analyze_rows(f4_ov, "F4 overlap")

# Live check
for uid in ("A3", "F4"):
    live = get(f"/api/history?uniqueId={uid}&limit=3")
    if live:
        last = live[-1] if isinstance(live, list) else live
        if isinstance(last, dict) and last.get("lat"):
            t = last.get("t") or last.get("time")
            if isinstance(t, (int, float)):
                lt = datetime.fromtimestamp(t / 1000, tz=NZ)
            else:
                lt = datetime.fromisoformat(str(t).replace("Z", "+00:00")).astimezone(NZ)
            print(f"\n{uid} latest fix: {lt.strftime('%H:%M:%S')} NZ")
