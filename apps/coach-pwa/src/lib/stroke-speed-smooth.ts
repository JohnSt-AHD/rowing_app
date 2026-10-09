/** Stroke-period boat-speed smoothing — averages over ~1–2 hull surge cycles. */

export type TimeSpeedPoint = {
  tMs: number;
  speedMps: number;
  strokeRateSpm?: number | null;
};

export type StrokeSpeedWindowOpts = {
  strokes?: number;
  minMs?: number;
  maxMs?: number;
  fallbackMs?: number;
};

const DEFAULT_STROKES = 2;
const DEFAULT_MIN_MS = 4_000;
const DEFAULT_MAX_MS = 10_000;
const DEFAULT_FALLBACK_MS = 8_000;

function usableSpm(spm: number | null | undefined): number | null {
  if (spm == null || !Number.isFinite(spm)) return null;
  if (spm < 15 || spm > 50) return null;
  return spm;
}

export function strokePeriodWindowMs(
  strokeRateSpm: number | null | undefined,
  opts: StrokeSpeedWindowOpts = {},
): number {
  const strokes = opts.strokes ?? DEFAULT_STROKES;
  const minMs = opts.minMs ?? DEFAULT_MIN_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const fallbackMs = opts.fallbackMs ?? DEFAULT_FALLBACK_MS;
  const spm = usableSpm(strokeRateSpm);
  if (spm == null) return fallbackMs;
  const periodMs = 60_000 / spm;
  return Math.round(Math.min(maxMs, Math.max(minMs, strokes * periodMs)));
}

export function smoothSpeedByStrokePeriod(
  points: TimeSpeedPoint[],
  opts: StrokeSpeedWindowOpts = {},
): TimeSpeedPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ ...points[0] }];

  const out: TimeSpeedPoint[] = [];
  let left = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const windowMs = strokePeriodWindowMs(p.strokeRateSpm, opts);
    const cutoff = p.tMs - windowMs;
    while (left < i && points[left].tMs < cutoff) left++;

    let sum = 0;
    let n = 0;
    for (let j = left; j <= i; j++) {
      const v = points[j].speedMps;
      if (Number.isFinite(v) && v >= 0) {
        sum += v;
        n++;
      }
    }
    out.push({
      tMs: p.tMs,
      speedMps: n > 0 ? sum / n : p.speedMps,
      strokeRateSpm: p.strokeRateSpm,
    });
  }

  return out;
}
