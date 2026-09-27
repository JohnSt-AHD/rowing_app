#!/usr/bin/env python3
import json
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
TOKEN = "rnz"
SID = "315e22f9-3c4e-4a56-a82c-6d308f1623cd"
AUCKLAND = timezone(timedelta(hours=12))


def get(path):
    req = urllib.request.Request(
        BASE + path,
        headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def nz_ms(y, m, d, hh, mm, ss=0):
    return int(
        datetime(y, m, d, hh, mm, ss, tzinfo=AUCKLAND).astimezone(timezone.utc).timestamp() * 1000
    )


def analyze_window(track, t0, t1, label):
    pts = [p for p in track if t0 <= p.get("t", 0) <= t1]
    gps = [p for p in pts if p.get("lat") is not None]
    print(f"\n=== {label} ===")
    print(f" window samples={len(pts)} gps={len(gps)}")
    if len(gps) < 2:
        return
    ts = sorted(p["t"] for p in gps)
    gaps = [(ts[i] - ts[i - 1]) / 1000 for i in range(1, len(ts))]
    gs = sorted(gaps)
    bursts = sum(1 for i, t in enumerate(ts) if sum(1 for x in ts if t <= x <= t + 5000) >= 4)
    print(
        f" median={statistics.median(gaps):.2f}s p95={gs[int(0.95*(len(gs)-1))]:.2f}s"
        f" min={min(gaps):.2f}s max={max(gaps):.2f}s"
        f" le1s={sum(1 for g in gaps if g<=1)} le1.5s={sum(1 for g in gaps if g<=1.5)}"
        f" 1.5-4s={sum(1 for g in gaps if 1.5<g<=4)} gt4s={sum(1 for g in gaps if g>4)}"
        f" burst5s>=4={bursts}"
    )
    # show any sub-1.5s gaps
    fast = [(ts[i], ts[i + 1], gaps[i]) for i in range(len(gaps)) if gaps[i] <= 1.5]
    if fast:
        print(" fast gaps:")
        for a, b, g in fast[:10]:
            print(
                " ",
                datetime.fromtimestamp(a / 1000, tz=AUCKLAND).strftime("%H:%M:%S"),
                "->",
                datetime.fromtimestamp(b / 1000, tz=AUCKLAND).strftime("%H:%M:%S"),
                f"{g:.2f}s",
            )
    caps = [p for p in pts if p.get("capsize")]
    print(f" capsize points={len(caps)}")


dash = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(SID))
track = dash.get("track") or []
print("full session track", len(track), "from", dash.get("startedAt"), "to latest", max((p['t'] for p in track), default=0))

windows = [
    ("Yesterday NZ 06:25-06:35 (1st capsize ~06:29)", nz_ms(2026, 7, 27, 6, 25), nz_ms(2026, 7, 27, 6, 35)),
    ("Yesterday NZ 06:43-06:53 (2nd capsize ~06:47)", nz_ms(2026, 7, 27, 6, 43), nz_ms(2026, 7, 27, 6, 53)),
    ("Yesterday NZ 07:00-07:15", nz_ms(2026, 7, 27, 7, 0), nz_ms(2026, 7, 27, 7, 15)),
    ("Today NZ last 15m", int((datetime.now(AUCKLAND) - timedelta(minutes=15)).timestamp() * 1000), int(datetime.now(AUCKLAND).timestamp() * 1000)),
    ("Today NZ last 60m", int((datetime.now(AUCKLAND) - timedelta(minutes=60)).timestamp() * 1000), int(datetime.now(AUCKLAND).timestamp() * 1000)),
]

for label, t0, t1 in windows:
    analyze_window(track, t0, t1, label)

# Session metadata
print("\nSession sample_count from list:")
sess = get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("M1x TM"))
if sess.get("sessions"):
    s = sess["sessions"][0]
    print(json.dumps(s, indent=2))

# Check if fixMs exists anywhere in recent samples via ingest (memory may not have it)
try:
    raw = get("/api/ingest?sessionId=" + urllib.parse.quote(SID))
    samples = raw.get("samples") or []
    print("\nIngest endpoint samples", len(samples), "storage", raw.get("storage"))
    gps = [s for s in samples if s.get("gps")]
    with_fix = sum(1 for s in gps if (s.get("gps") or {}).get("fixMs"))
    print(" gps with fixMs", with_fix, "/", len(gps))
except Exception as e:
    print("ingest err", e)
