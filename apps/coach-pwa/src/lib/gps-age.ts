import type { FleetDevice, MapPosition } from './api';

const GPS_LIVE_SEC = 30;
const GPS_STALE_SEC = 300;
const TELEMETRY_STALE_SEC = GPS_LIVE_SEC;
const PIPELINE_LAG_SEC = 20;

/** Match server/dashboard: prefer ingest age when fix timestamp lags upload. */
export function displayGpsAgeSec(
  fixAgeSec?: number | null,
  ingestAgoSec?: number | null,
): number | null {
  if (fixAgeSec == null || !Number.isFinite(fixAgeSec)) return null;
  if (ingestAgoSec == null || !Number.isFinite(ingestAgoSec)) return fixAgeSec;
  if (fixAgeSec - ingestAgoSec > PIPELINE_LAG_SEC) return ingestAgoSec;
  return fixAgeSec;
}

export function resolveGpsDisplayAge(
  device?: FleetDevice,
  position?: MapPosition,
): number | null {
  if (device) {
    const merged = device.gpsAgeSec ?? device.gps?.displayAgeSec;
    if (merged != null && Number.isFinite(merged)) return merged;
    return displayGpsAgeSec(device.gps?.ageSec, device.gps?.ingestAgoSec);
  }
  if (position) {
    return displayGpsAgeSec(position.fixAgeSec, position.lastSeenAgoSec);
  }
  return null;
}

export type GpsFixState = 'live' | 'amber' | 'lost';

export function gpsFixState(ageSec?: number | null): GpsFixState {
  if (ageSec == null || !Number.isFinite(ageSec)) return 'lost';
  if (ageSec <= GPS_LIVE_SEC) return 'live';
  if (ageSec <= GPS_STALE_SEC) return 'amber';
  return 'lost';
}

export function gpsStatusLabel(ageSec?: number | null): string {
  const state = gpsFixState(ageSec);
  if (state === 'live') return 'GPS live';
  if (state === 'amber') return `GPS ${Math.round(ageSec!)}s ago`;
  return 'GPS stale';
}

export function isTelemetryStale(lastSeenAgoSec?: number | null): boolean {
  if (lastSeenAgoSec == null || !Number.isFinite(lastSeenAgoSec)) return false;
  return lastSeenAgoSec > TELEMETRY_STALE_SEC;
}

export function markerColorForState(state: GpsFixState, capsize: boolean): string {
  if (capsize) return '#ef4444';
  if (state === 'live') return '#38bdf8';
  if (state === 'amber') return '#fbbf24';
  return '#94a3b8';
}
