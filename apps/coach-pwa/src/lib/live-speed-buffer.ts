import type { MapPosition } from './api';
import { resolveSpeedMps } from './map-smooth';
import { densifyTimeSeries, smoothSpeedTimeSeries } from './chart-smooth';

/** Interpolate smoothed live speed every N seconds for a dense chart line. */
const LIVE_CHART_DENSIFY_SEC = 0.25;
import { colorForDevice, type ChartSeries } from './history-track';

const WINDOW_MS = 5 * 60 * 1000;

type LivePoint = {
  t: number;
  speedMps: number;
};

type DeviceBuffer = {
  points: LivePoint[];
};

const buffers = new Map<string, DeviceBuffer>();
const deviceOrder = new Map<string, number>();

function prune(buf: DeviceBuffer, now: number): void {
  const cutoff = now - WINDOW_MS;
  buf.points = buf.points.filter((p) => p.t >= cutoff);
}

/** Append latest map samples; keeps a rolling 5-minute window per device. */
export function recordLiveSpeedSamples(positions: MapPosition[]): void {
  const now = Date.now();
  const seen = new Set<string>();

  for (const p of positions) {
    if (!p.deviceId || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    seen.add(p.deviceId);
    const speed = resolveSpeedMps(p);
    if (speed == null) continue;

    const t = p.fixMs ?? now;
    let buf = buffers.get(p.deviceId);
    if (!buf) {
      buf = { points: [] };
      buffers.set(p.deviceId, buf);
      if (!deviceOrder.has(p.deviceId)) {
        deviceOrder.set(p.deviceId, deviceOrder.size);
      }
    }

    const prev = buf.points[buf.points.length - 1];

    if (prev && Math.abs(t - prev.t) < 80) {
      prev.speedMps = speed;
      prune(buf, now);
      continue;
    }

    buf.points.push({ t, speedMps: speed });
    prune(buf, now);
  }

  for (const id of buffers.keys()) {
    if (!seen.has(id)) {
      const buf = buffers.get(id)!;
      prune(buf, now);
      if (!buf.points.length) buffers.delete(id);
    }
  }
}

export function liveSpeedVsTimeSeries(activeDeviceIds: string[]): ChartSeries[] {
  const ids = activeDeviceIds.filter((id) => (buffers.get(id)?.points.length ?? 0) >= 2);
  return ids.map((id, i) => {
    const pts = buffers.get(id)!.points;
    const t0 = pts[0].t;
    const order = deviceOrder.get(id) ?? i;
    const smoothed = densifyTimeSeries(
      smoothSpeedTimeSeries(pts.map((p) => ({ tMs: p.t, value: p.speedMps }))),
      LIVE_CHART_DENSIFY_SEC,
    );
    return {
      id,
      label: id,
      color: colorForDevice(order),
      points: smoothed.map((p) => ({
        x: (p.tMs - t0) / 1000,
        y: p.value * 3.6,
      })),
    };
  });
}

export function clearLiveSpeedBuffers(): void {
  buffers.clear();
  deviceOrder.clear();
}
