/** Time-stamped scalar samples (e.g. speed m/s). */
export type TimeValuePoint = {
  tMs: number;
  value: number;
};

export type SpeedSmoothOptions = {
  /** EMA time constant — higher = smoother (seconds). */
  tauSec?: number;
  /** Cap how fast displayed speed can change (m/s²). */
  maxAccelMps2?: number;
  /** Ignore brief GPS dropouts when still moving (m/s). */
  glitchHoldAboveMps?: number;
};

const DEFAULT_TAU_SEC = 12;
const DEFAULT_MAX_ACCEL = 1.0;
const DEFAULT_GLITCH_HOLD = 1.5;

/**
 * Causal EMA smoothing for speed traces — softens GPS spikes and brief dropouts
 * without lagging real acceleration for more than a few seconds.
 */
export function smoothSpeedTimeSeries(
  points: TimeValuePoint[],
  opts: SpeedSmoothOptions = {},
): TimeValuePoint[] {
  if (points.length <= 1) return points.map((p) => ({ ...p }));

  const tauSec = opts.tauSec ?? DEFAULT_TAU_SEC;
  const maxAccel = opts.maxAccelMps2 ?? DEFAULT_MAX_ACCEL;
  const glitchHold = opts.glitchHoldAboveMps ?? DEFAULT_GLITCH_HOLD;

  const out: TimeValuePoint[] = [{ tMs: points[0].tMs, value: points[0].value }];

  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const sample = points[i];
    const dtSec = Math.max(0.05, (sample.tMs - prev.tMs) / 1000);

    let target = sample.value;
    if (target < 0.3 && prev.value >= glitchHold) {
      // Brief zero/low GPS speed while track was moving — decay gently.
      target = prev.value * Math.exp(-dtSec / 18);
    }

    const maxDelta = maxAccel * dtSec;
    const clamped = Math.max(prev.value - maxDelta, Math.min(prev.value + maxDelta, target));
    const alpha = 1 - Math.exp(-dtSec / tauSec);
    const value = prev.value + alpha * (clamped - prev.value);

    out.push({ tMs: sample.tMs, value: Math.max(0, value) });
  }

  return out;
}

/** Smooth chart points that share a monotonic time axis (x = seconds from start). */
export function smoothChartSeriesByTime(
  points: { x: number; y: number }[],
  t0Ms: number,
  yToValue: (y: number) => number,
  valueToY: (v: number) => number,
  opts?: SpeedSmoothOptions,
  stepSec = 0.25,
): { x: number; y: number }[] {
  if (points.length <= 1) return points.slice();

  const smoothed = smoothSpeedTimeSeries(
    points.map((p) => ({ tMs: t0Ms + p.x * 1000, value: yToValue(p.y) })),
    opts,
  );

  return densifyChartSeries(
    smoothed.map((p) => ({
      x: (p.tMs - t0Ms) / 1000,
      y: valueToY(p.value),
    })),
    stepSec,
  );
}

/** Linear interpolation of an already-smoothed series for a denser chart line. */
export function densifyTimeSeries(
  points: TimeValuePoint[],
  stepSec = 0.25,
): TimeValuePoint[] {
  if (points.length <= 1) return points.map((p) => ({ ...p }));

  const stepMs = Math.max(50, stepSec * 1000);
  const out: TimeValuePoint[] = [{ ...points[0] }];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const span = b.tMs - a.tMs;
    if (span <= 0) continue;

    for (let tMs = a.tMs + stepMs; tMs < b.tMs; tMs += stepMs) {
      const f = (tMs - a.tMs) / span;
      out.push({
        tMs,
        value: a.value + f * (b.value - a.value),
      });
    }
    out.push({ ...b });
  }

  return out;
}

export function densifyChartSeries(
  points: { x: number; y: number }[],
  stepSec = 0.25,
): { x: number; y: number }[] {
  if (points.length <= 1) return points.slice();

  const step = Math.max(0.05, stepSec);
  const out: { x: number; y: number }[] = [{ ...points[0] }];

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const span = b.x - a.x;
    if (span <= 0) continue;

    for (let x = a.x + step; x < b.x - step * 0.01; x += step) {
      const f = (x - a.x) / span;
      out.push({ x, y: a.y + f * (b.y - a.y) });
    }
    out.push({ ...b });
  }

  return out;
}
