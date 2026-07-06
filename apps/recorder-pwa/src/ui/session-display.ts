/** Live session HUD: rainbow rails, rolling speed, pace formatting. */

export {
  MIN_SPEED_MPS,
  formatSplit500m,
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
  idleColor = 'hsl(220, 22%, 18%)',
): void {
  if (!el) return;
  const marker = el.querySelector('[data-rail-marker]') as HTMLElement | null;
  if (t == null) {
    el.style.backgroundColor = idleColor;
    if (marker) marker.style.opacity = '0';
    return;
  }
  const ct = clamp01(t);
  el.style.backgroundColor = rainbowColor(ct);
  if (marker) {
    marker.style.opacity = '1';
    marker.style.top = `${railPositionFromT(ct)}%`;
  }
}
