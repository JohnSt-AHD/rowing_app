#!/usr/bin/env python3
"""
Simulate CrewSight native GPS upload cadence (CapsizeMonitorService bucket timer).

Models:
  - settings.ts: sampleRateSec -> gpsIntervalMs
  - scheduleGpsFlush: fires every effectiveGpsIntervalMs()
  - maybeUploadGpsFix: one sample per time bucket (legacy CrewSight — replaced by window average)
  - uploadWindowAverageGps: KRI model — collect @500ms, one weighted upload per report interval
"""
from __future__ import annotations

import statistics
from collections import Counter
from dataclasses import dataclass


def intervals_from_sample_rate_sec(sec: float) -> dict:
    """Mirror apps/recorder-pwa/src/lib/settings.ts"""
    sample_sec = max(0.5, sec)
    ms = round(sample_sec * 1000)
    return {
        "gpsIntervalMs": ms,
        "uploadBatchMs": max(3000, ms * 2),
    }


@dataclass
class SimResult:
    label: str
    gps_interval_ms: int
    uploads: list[int]
    mode: str

    def gap_stats(self) -> dict:
        if len(self.uploads) < 2:
            return {"n": 0}
        gaps = [(self.uploads[i] - self.uploads[i - 1]) / 1000 for i in range(1, len(self.uploads))]
        steady = [g for g in gaps if g >= 0.75]
        target = self.gps_interval_ms / 1000
        lo, hi = target * 0.75, target * 1.35
        in_band = sum(1 for g in steady if lo <= g <= hi)
        return {
            "n": len(gaps),
            "steady_n": len(steady),
            "med": round(statistics.median(steady), 3) if steady else None,
            "mean": round(statistics.mean(steady), 3) if steady else None,
            "in_band_pct": round(100 * in_band / len(steady), 1) if steady else 0,
            "top": Counter(round(g, 2) for g in steady).most_common(4),
        }


def simulate_ideal(gps_interval_ms: int, duration_ms: int = 180_000, start_ms: int = 0) -> list[int]:
    """One upload per timer tick — perfect scheduler."""
    interval = max(500, gps_interval_ms)
    times = []
    t = start_ms + interval
    last_bucket = -1
    while t <= start_ms + duration_ms:
        bucket = t // interval
        if bucket > last_bucket:
            times.append(t)
            last_bucket = bucket
        t += interval
    return times


def simulate_bucket_logic(gps_interval_ms: int, duration_ms: int = 180_000, start_ms: int = 0) -> list[int]:
    """Mirror maybeUploadGpsFix bucket assignment (Java)."""
    interval = max(500, gps_interval_ms)
    times: list[int] = []
    last_bucket = -1
    last_offered = 0
    t = start_ms
    while t <= start_ms + duration_ms:
        ingest_t = t
        bucket = ingest_t // interval
        if bucket <= last_bucket:
            if ingest_t - last_offered < interval:
                t += 50
                continue
            bucket = last_bucket + 1
        last_bucket = bucket
        last_offered = ingest_t
        times.append(ingest_t)
        t += interval
    return times


def simulate_double_upload_tick(
    gps_interval_ms: int, duration_ms: int = 180_000, start_ms: int = 0
) -> list[int]:
    """Each timer tick uploads cached fix then fresh fix (~same ms) — seen on A2 @ 1s."""
    interval = max(500, gps_interval_ms)
    times: list[int] = []
    last_bucket = -1
    last_offered = 0
    t = start_ms + interval
    while t <= start_ms + duration_ms:
        for offset in (0, 15):  # cached then fresh 15ms later
            ingest_t = t + offset
            bucket = ingest_t // interval
            if bucket <= last_bucket:
                if ingest_t - last_offered < interval:
                    continue
                bucket = last_bucket + 1
            last_bucket = bucket
            last_offered = ingest_t
            times.append(ingest_t)
        t += interval
    return times


def simulate_jitter(gps_interval_ms: int, duration_ms: int = 180_000, jitter_ms: int = 80) -> list[int]:
    """Timer with +/- jitter (real devices)."""
    interval = max(500, gps_interval_ms)
    times = simulate_bucket_logic(gps_interval_ms, duration_ms)
    # Deterministic jitter pattern (no random — reproducible)
    out = []
    sign = 1
    for i, t in enumerate(times):
        j = ((i * 37) % (jitter_ms + 1)) * sign
        sign *= -1
        out.append(t + j)
    out.sort()
    return out


def run_case(sample_sec: float) -> None:
    cfg = intervals_from_sample_rate_sec(sample_sec)
    ms = cfg["gpsIntervalMs"]
    label = f"{sample_sec:g}s"
    print(f"\n=== Setting: {label} (gpsIntervalMs={ms}, uploadBatchMs={cfg['uploadBatchMs']}) ===")

    modes = [
        ("ideal timer", simulate_ideal(ms)),
        ("bucket logic", simulate_bucket_logic(ms)),
        ("double-upload tick", simulate_double_upload_tick(ms)),
        ("bucket + jitter", simulate_jitter(ms)),
    ]

    for mode_name, uploads in modes:
        stats = SimResult(label, ms, uploads, mode_name).gap_stats()
        dur_s = (uploads[-1] - uploads[0]) / 1000 if len(uploads) >= 2 else 0
        rate = len(uploads) / max(dur_s, 1)
        print(
            f"  {mode_name:22}  uploads={len(uploads):4}  "
            f"steady_med={stats.get('med')}s  in_band={stats.get('in_band_pct')}%  "
            f"rate={rate:.2f}/s  top={stats.get('top')}"
        )


def assert_expectations() -> None:
    """Automated checks — ideal model should match setting within tolerance."""
    failures = []
    for sec in (1, 5, 10):
        ms = intervals_from_sample_rate_sec(sec)["gpsIntervalMs"]
        uploads = simulate_bucket_logic(ms, duration_ms=300_000)
        gaps = [(uploads[i] - uploads[i - 1]) / 1000 for i in range(1, len(uploads))]
        med = statistics.median(gaps)
        if not (sec * 0.9 <= med <= sec * 1.1):
            failures.append(f"{sec}s bucket model: median gap {med:.2f}s (expected ~{sec}s)")
        # double-upload should NOT change steady-gap median for 1s (pairs are sub-second)
        dbl = simulate_double_upload_tick(ms, duration_ms=60_000)
        d_gaps = [g for g in [(dbl[i] - dbl[i - 1]) / 1000 for i in range(1, len(dbl))] if g >= 0.75]
        if d_gaps:
            d_med = statistics.median(d_gaps)
            if not (sec * 0.9 <= d_med <= sec * 1.15):
                failures.append(
                    f"{sec}s double-upload steady med {d_med:.2f}s (expected ~{sec}s)"
                )
    if failures:
        print("\nASSERT FAILURES:")
        for f in failures:
            print(f"  - {f}")
        return False
    print("\nAll bucket-model assertions passed (ideal scheduler matches 1/5/10s settings).")
    return True


def main() -> None:
    print("CrewSight reporting interval simulation")
    print("Native: scheduleGpsFlush every gpsIntervalMs; uploadWindowAverageGps one sample per interval.")
    for sec in (1, 5, 10):
        run_case(sec)
    ok = assert_expectations()
    print(
        "\nInterpretation:"
        "\n  - If bucket/ideal sim matches setting but field data does not,"
        " the interval was not applied (session not restarted) or economy geofence overrode it."
        "\n  - uploadWindowAverageGps (KRI): collect fixes @500ms, one accuracy-weighted sample per interval."
        "\n  - fused fix + bucket timer (one sample per bucket) matches KRI-style 1 Hz clients."
        "\n  - double-upload tick was removed; sub-second pairs should no longer appear."
        "\n  - geofence economy no longer overrides gpsIntervalMs (user setting always wins)."
    )
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
