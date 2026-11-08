/** Live session HUD: rainbow rails, rolling speed, pace formatting. */

export {
  MIN_SPEED_MPS,
  formatSplit500m,
  formatPrognostic,
  splitSecFromMps,
  parseBoatClass,
  formatPaceWithPrognostic,
} from '@rowing/rowing-pace';

export const SPLIT_SLOW_SEC = 2 * 60 + 30; // 2:30 /500m
export const SPLIT_FAST_SEC = 60 + 15; // 1:15 /500m
export const HR_SLOW_BPM = 100;
export const HR_FAST_BPM = 200;
export const SPEED_AVG_WINDOW_MS = 10_000;
export const STROKE_AVG_WINDOW_MS = 15_000;

export function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

/** Rainbow hue 0 (red) → 300 (violet) for normalized 0–1. */
export function rainbowColor(t: number): string {
  const hue = clamp01(t) * 300;
  return `hsl(${hue}, 92%, 48%)`;
}

/** Split seconds → 0 slow (2:30) … 1 fast (1:15). */
export function splitSecToT(splitSec: number): number {
  return clamp01((SPLIT_SLOW_SEC - splitSec) / (SPLIT_SLOW_SEC - SPLIT_FAST_SEC));
}

export function hrToT(bpm: number): number {
  return clamp01((bpm - HR_SLOW_BPM) / (HR_FAST_BPM - HR_SLOW_BPM));
}

/**
 * Prognostic palette, low → high. Same hexes as speedChartColorForPrognostic
 * (cyan, green, yellow, orange, red, purple).
 */
export const HR_BAR_COLORS = [
  '#00e5ff',
  '#34d399',
  '#fbbf24',
  '#f97316',
  '#ef4444',
  '#c084fc',
] as const;

/**
 * HR rail fill. The on-screen scale is HR_SLOW_BPM (100) to HR_FAST_BPM (200).
 * That span is six equal slices of those prognostic colours, low to high.
 * Not boat speed, and not a medical heart-rate zone. Readings outside
 * 100–200 clamp to the end colour. Callers skip this when no monitor reading.
 */
export function hrBarColor(bpm: number): string {
  const t = hrToT(bpm);
  const n = HR_BAR_COLORS.length;
  if (t >= 1) return HR_BAR_COLORS[n - 1];
  return HR_BAR_COLORS[Math.min(n - 1, Math.floor(t * n))];
}

/**
 * Stroke-rate box border. Same six hexes as HR_BAR_COLORS.
 * The shown rate is a whole number, so the band follows Math.round:
 * ≤20 cyan, 21–25 green, 26–30 yellow, 31–35 orange, 36–40 red, ≥41 purple.
 * 20 stays cyan and 41 is purple, so those integers are not left between bands.
 */
export function strokeRateZoneColor(spm: number): string {
  const n = Math.round(spm);
  if (n <= 20) return HR_BAR_COLORS[0];
  if (n <= 25) return HR_BAR_COLORS[1];
  if (n <= 30) return HR_BAR_COLORS[2];
  if (n <= 35) return HR_BAR_COLORS[3];
  if (n <= 40) return HR_BAR_COLORS[4];
  return HR_BAR_COLORS[5];
}

/** Vertical marker: 0% top = fast, 100% bottom = slow. */
export function railPositionFromT(t: number): number {
  return (1 - clamp01(t)) * 100;
}

export class MetricRollingAvg {
  private samples: { t: number; v: number }[] = [];

  constructor(
    private windowMs: number,
    private minValue = 0,
  ) {}

  push(value: number): void {
    if (value <= this.minValue) return;
    const now = Date.now();
    this.samples.push({ t: now, v: value });
    const cutoff = now - this.windowMs;
    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  average(): number | undefined {
    if (!this.samples.length) return undefined;
    let sum = 0;
    for (const s of this.samples) sum += s.v;
    return sum / this.samples.length;
  }

  clear(): void {
    this.samples = [];
  }
}

export function updateSpectrumRail(
  el: HTMLElement | null,
  t: number | undefined,
  options?: { fillColor?: string; idleColor?: string },
): void {
  if (!el) return;
  const idleColor = options?.idleColor ?? 'hsl(220, 22%, 18%)';
  const marker = el.querySelector('[data-rail-marker]') as HTMLElement | null;
  if (t == null) {
    el.style.backgroundColor = idleColor;
    if (marker) marker.style.opacity = '0';
    return;
  }
  const ct = clamp01(t);
  el.style.backgroundColor = options?.fillColor ?? rainbowColor(ct);
  if (marker) {
    marker.style.opacity = '1';
    marker.style.top = `${railPositionFromT(ct)}%`;
  }
}
