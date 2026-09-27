#!/usr/bin/env python3
"""Analyze A2 moving session — speed quality for Manager display."""
import json
import math
import statistics
import sys
import urllib.request

BASE = "https://rowing-app-recorder-pwa.vercel.app"
UID = sys.argv[1] if len(sys.argv) > 1 else "A2"


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.load(r)


def hav_m(lat1, lon1, lat2, lon2):
    dlat = (lat2 - lat1) * 111320
    dlon = (lon2 - lon1) * 111320 * 0.85
    return math.hypot(dlat, dlon)


def main():
    sessions = get(f"/api/history?list=sessions&uniqueId={UID}").get("sessions", [])
    if not sessions:
        print(f"No sessions for {UID}")
        return
    sid = sessions[0]["session_id"]
    meta = sessions[0]
    print(f"Session {sid[:8]}  started {meta['started_at']}  samples={meta.get('sample_count')}")

    tr = get(f"/api/history?format=dashboard&sessionId={sid}").get("track") or []
    tr = [p for p in tr if p.get("lat") is not None and p.get("lon") is not None]
    print(f"GPS track points: {len(tr)}")
    if len(tr) < 2:
        return

    derived = []
    reported = []
    pairs = []
    for i in range(1, len(tr)):
        dt = (tr[i]["t"] - tr[i - 1]["t"]) / 1000
        if dt <= 0:
            continue
        d = hav_m(tr[i - 1]["lat"], tr[i - 1]["lon"], tr[i]["lat"], tr[i]["lon"])
        v_der = d / dt
        v_rep = tr[i].get("speed")
        derived.append(v_der)
        if v_rep is not None:
            reported.append(v_rep)
        pairs.append((v_rep, v_der, dt))

    rep_nz = [x for x in reported if x and x > 0.1]
    der_nz = [x for x in derived if x > 0.1]
    print("\n--- Reported speed (device/API field) ---")
    print(f"  nonzero: {len(rep_nz)}/{len(reported)}")
    if rep_nz:
        print(f"  min/med/p90/max m/s: {min(rep_nz):.2f} / {statistics.median(rep_nz):.2f} / "
              f"{sorted(rep_nz)[int(len(rep_nz)*0.9)]:.2f} / {max(rep_nz):.2f}")
        print(f"  >8 m/s (29 km/h): {sum(1 for x in rep_nz if x > 8)}")
        print(f"  zeros: {sum(1 for x in reported if x == 0)}")

    print("\n--- Derived speed (position deltas) ---")
    if der_nz:
        print(f"  min/med/p90/max m/s: {min(der_nz):.2f} / {statistics.median(der_nz):.2f} / "
              f"{sorted(der_nz)[int(len(der_nz)*0.9)]:.2f} / {max(der_nz):.2f}")
        print(f"  >8 m/s: {sum(1 for x in der_nz if x > 8)}")

    jumps = []
    for i in range(1, len(reported)):
        if reported[i - 1] is None or reported[i] is None:
            continue
        jumps.append(abs(reported[i] - reported[i - 1]))
    if jumps:
        print(f"\n--- Reported speed step jumps ---")
        print(f"  med jump: {statistics.median(jumps):.2f} m/s  max jump: {max(jumps):.2f} m/s")
        print(f"  jumps >5 m/s: {sum(1 for j in jumps if j > 5)}")

    dist = sum(
        hav_m(tr[i - 1]["lat"], tr[i - 1]["lon"], tr[i]["lat"], tr[i]["lon"])
        for i in range(1, len(tr))
    )
    dur = (tr[-1]["t"] - tr[0]["t"]) / 1000
    print(f"\n--- Track ---")
    print(f"  distance ~{dist:.0f} m in {dur:.0f} s  avg {dist/max(dur,1):.2f} m/s ({dist/max(dur,1)*3.6:.1f} km/h)")

    print("\n--- Sample (last 12 fixes) ---")
    for p in tr[-12:]:
        print(f"  spd={p.get('speed')} acc={p.get('acc')}")


if __name__ == "__main__":
    main()
