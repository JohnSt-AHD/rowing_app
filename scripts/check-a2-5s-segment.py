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


def dedupe_burst(pts, min_gap_s=0.75):
    out = [pts[0]] if pts else []
    for p in pts[1:]:
        if (p["t"] - out[-1]["t"]) / 1000 >= min_gap_s:
            out.append(p)
    return out


sessions = get("/api/history?list=sessions&uniqueId=A2").get("sessions", [])
s = next(x for x in sessions if x["session_id"].startswith("69f4bd18"))
tr = get(f"/api/history?format=dashboard&sessionId={s['session_id']}").get("track") or []
rows = sorted([{"t": p["t"]} for p in tr if p.get("lat")], key=lambda r: r["t"])

sess_st = datetime.fromisoformat(s["started_at"].replace("Z", "+00:00")).astimezone(NZ)
seg_start = sess_st.timestamp() * 1000
seg_end = datetime(2026, 7, 2, 8, 21, 5, tzinfo=NZ).timestamp() * 1000
seg = [r for r in rows if seg_start <= r["t"] <= seg_end]
ded = dedupe_burst(seg)
gaps = [(ded[i]["t"] - ded[i - 1]["t"]) / 1000 for i in range(1, len(ded))]

st = datetime.fromtimestamp(seg[0]["t"] / 1000, tz=NZ)
en = datetime.fromtimestamp(seg[-1]["t"] / 1000, tz=NZ)
dur = (seg[-1]["t"] - seg[0]["t"]) / 1000

in5 = sum(1 for g in gaps if 4.0 <= g <= 6.5)
in3 = sum(1 for g in gaps if 2.5 <= g <= 3.5)
in10 = sum(1 for g in gaps if 8.0 <= g <= 12.5)

print(f"Session 69f4bd18 — 5s test from session start to ~08:21")
print(f"Window: {st.strftime('%H:%M:%S')} -> {en.strftime('%H:%M:%S')} ({dur:.0f}s = {dur/60:.1f} min)")
print(f"Raw pts: {len(seg)}  Deduped: {len(ded)}  Expected @5s: ~{dur/5:.0f}")
if gaps:
    print(f"Gap median: {statistics.median(gaps):.2f}s  mean: {statistics.mean(gaps):.2f}s")
    print(f"5s band (4-6.5s): {in5}/{len(gaps)} = {100*in5/len(gaps):.1f}%")
    print(f"~3s alt: {in3}/{len(gaps)} = {100*in3/len(gaps):.1f}%")
    print(f"~10s gaps: {in10}/{len(gaps)} = {100*in10/len(gaps):.1f}%")
    print(f"Top gaps: {Counter(round(g, 2) for g in gaps).most_common(10)}")
    print(f"Stalls >30s: {sum(1 for g in gaps if g > 30)}")

print("\nGap timeline (deduped):")
for i, g in enumerate(gaps):
    lt = datetime.fromtimestamp(ded[i + 1]["t"] / 1000, tz=NZ).strftime("%H:%M:%S")
    tag = ""
    if 4.0 <= g <= 6.5:
        tag = " OK-5s"
    elif 8.0 <= g <= 12.5:
        tag = " ~10s"
    elif g > 30:
        tag = " STALL"
    print(f"  +{g:6.2f}s  {lt}{tag}")
