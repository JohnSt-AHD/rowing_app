/** Stroke-period boat-speed smoothing — averages over ~1–2 hull surge cycles. */

export type TimeSpeedPoint = {
  tMs: number;
  speedMps: number;
  strokeRateSpm?: number | null;
};

export type StrokeSpeedWindowOpts = {
  /** Number of stroke periods to average (default 2). */
  strokes?: number;
  minMs?: number;
  maxMs?: number;
  /** Used when SPM is missing / invalid. */
  fallbackMs?: number;
};

const DEFAULT_STROKES = 2;
const DEFAULT_MIN_MS = 4_000;
const DEFAULT_MAX_MS = 10_000;
const DEFAULT_FALLBACK_MS = 8_000;

/** Valid rowing SPM for window sizing. */
function usableSpm(spm: number | null | undefined): number | null {
  if (spm == null || !Number.isFinite(spm)) return null;
  if (spm < 15 || spm > 50) return null;
  return spm;
}

/** Rolling window length from stroke rate (ms). */
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

/**
 * Causal mean of speed over the last ~N stroke periods at each sample.
 * Removes drive/check surge while staying responsive when pressure changes.
 */
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

/** Live HUD / streaming average over a stroke-period window. */
export class StrokePeriodSpeedAvg {
  private samples: { t: number; v: number }[] = [];
  private spm: number | null = null;
  private opts: StrokeSpeedWindowOpts;

  constructor(opts: StrokeSpeedWindowOpts = {}) {
    this.opts = opts;
  }

  setStrokeRate(spm: number | null | undefined): void {
    this.spm = usableSpm(spm);
  }

  push(value: number, t = Date.now()): void {
    if (!Number.isFinite(value) || value < 0.15) return;
    this.samples.push({ t, v: value });
    this.prune(t);
  }

  private prune(now: number): void {
    const windowMs = strokePeriodWindowMs(this.spm, this.opts);
    const cutoff = now - windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  average(): number | undefined {
    if (!this.samples.length) return undefined;
    this.prune(Date.now());
    if (!this.samples.length) return undefined;
    let sum = 0;
    for (const s of this.samples) sum += s.v;
    return sum / this.samples.length;
  }

  clear(): void {
    this.samples = [];
    this.spm = null;
  }
}
