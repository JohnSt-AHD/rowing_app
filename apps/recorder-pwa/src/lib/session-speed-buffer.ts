/** Rolling speed + trail samples for fullscreen Speed chart / Map trail. */

import {
  smoothSpeedByStrokePeriod,
  type TimeSpeedPoint,
} from './stroke-speed-smooth';

export type SpeedSample = {
  t: number;
  speedMps: number;
  lat?: number;
  lon?: number;
  strokeRateSpm?: number | null;
};

const WINDOW_MS = 8 * 60 * 1000;
const MIN_DT_MS = 400;

let samples: SpeedSample[] = [];

export function clearSessionSpeedBuffer(): void {
  samples = [];
}

export function pushSessionSpeedSample(
  sample: SpeedSample,
  now = Date.now(),
): void {
  if (!Number.isFinite(sample.t) || !Number.isFinite(sample.speedMps)) return;
  if (sample.speedMps < 0) return;

  const prev = samples[samples.length - 1];
  if (prev && Math.abs(sample.t - prev.t) < MIN_DT_MS) {
    prev.speedMps = sample.speedMps;
    if (sample.lat != null) prev.lat = sample.lat;
    if (sample.lon != null) prev.lon = sample.lon;
    if (sample.strokeRateSpm != null) prev.strokeRateSpm = sample.strokeRateSpm;
  } else {
    samples.push({ ...sample });
  }

  const cutoff = now - WINDOW_MS;
  while (samples.length && samples[0].t < cutoff) {
    samples.shift();
  }
}

export function getSessionSpeedSamples(now = Date.now()): SpeedSample[] {
  const cutoff = now - WINDOW_MS;
  return samples.filter((s) => s.t >= cutoff);
}

/** Speed samples with stroke-period surge removed (for live graph). */
export function getSessionSpeedSamplesSmoothed(now = Date.now()): SpeedSample[] {
  const raw = getSessionSpeedSamples(now);
  if (raw.length < 2) return raw;
  const pts: TimeSpeedPoint[] = raw.map((s) => ({
    tMs: s.t,
    speedMps: s.speedMps,
    strokeRateSpm: s.strokeRateSpm,
  }));
  const smoothed = smoothSpeedByStrokePeriod(pts);
  return smoothed.map((p, i) => ({
    t: p.tMs,
    speedMps: p.speedMps,
    lat: raw[i]?.lat,
    lon: raw[i]?.lon,
    strokeRateSpm: p.strokeRateSpm,
  }));
}

export function getSessionTrailLatLon(
  now = Date.now(),
): Array<[number, number]> {
  return getSessionSpeedSamples(now)
    .filter(
      (s) =>
        s.lat != null &&
        s.lon != null &&
        Number.isFinite(s.lat) &&
        Number.isFinite(s.lon),
    )
    .map((s) => [s.lat!, s.lon!] as [number, number]);
}

export const SESSION_SPEED_WINDOW_MS = WINDOW_MS;
