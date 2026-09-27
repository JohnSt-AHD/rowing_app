#!/usr/bin/env python3
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

BASE = "https://rowing-app-recorder-pwa.vercel.app"
H = {"Authorization": "Bearer rnz", "Accept": "application/json"}
NZ = timezone(timedelta(hours=12))


def get(path):
    with urllib.request.urlopen(urllib.request.Request(BASE + path, headers=H), timeout=90) as r:
        return __import__("json").load(r)


sid = next(
    s["session_id"]
    for s in get("/api/history?list=sessions&uniqueId=" + urllib.parse.quote("W2- KL"))["sessions"]
    if s["session_id"].startswith("be01b0da")
)
tr = get("/api/history?format=dashboard&sessionId=" + urllib.parse.quote(sid))["track"]
cut = int(datetime(2026, 8, 4, 8, 15, 30, tzinfo=NZ).timestamp() * 1000)
tail = [p for p in tr if p.get("t", 0) >= cut]
print(f"samples since 08:15:30 NZ: {len(tail)}")
for p in tail:
    ts = datetime.fromtimestamp(p["t"] / 1000, NZ).strftime("%H:%M:%S")
    kind = "GPS" if p.get("lat") is not None else "no-gps"
    print(f"  {ts} {kind:6} stroke={p.get('strokeRate')} capsize={p.get('capsize')}")
