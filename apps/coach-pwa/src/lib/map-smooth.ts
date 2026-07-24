import type { MapPosition } from './api';

const TICK_MS = 100;
const MAX_EXTRAPOLATE_SEC = 6;
const MIN_SPEED_MPS = 0.25;
const GPS_LIVE_SEC = 30;

type TrackState = {
  lat: number;
  lon: number;
  fixMs: number;
  speedMps: number | null;
  courseDeg: number | null;
  online: boolean;
};

const tracks = new Map<string, TrackState>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(deviceId: string, lat: number, lon: number) => void>();

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

function toDeg(r: number) {
  return (r * 180) / Math.PI;
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function destinationLatLon(
  lat: number,
  lon: number,
  courseDeg: number,
  distanceM: number,
): [number, number] {
  if (distanceM <= 0) return [lat, lon];
  const R = 6371000;
  const δ = distanceM / R;
  const θ = toRad(courseDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
}

function anchorLatLon(p: MapPosition): { lat: number; lon: number } {
  const slat = p.smoothLatitude ?? p.latitude;
  const slon = p.smoothLongitude ?? p.longitude;
  return { lat: slat, lon: slon };
}

function fixMsFor(p: MapPosition): number {
  if (p.fixMs != null && Number.isFinite(p.fixMs)) return p.fixMs;
  if (p.fixAgeSec != null && Number.isFinite(p.fixAgeSec)) {
    return Date.now() - p.fixAgeSec * 1000;
  }
  return Date.now();
}

/** Latest speed estimate for a device (from API or derived between fixes). */
export function trackSpeedMps(deviceId: string): number | null {
  const state = tracks.get(deviceId);
  if (state?.speedMps == null || !Number.isFinite(state.speedMps) || state.speedMps < 0) {
    return null;
  }
  return state.speedMps;
}

export function resolveSpeedMps(p: MapPosition): number | null {
  const path = p.pathSpeedMps ?? p.displaySpeedMps;
  if (path != null && Number.isFinite(path) && path >= 0.25) return path;
  return trackSpeedMps(p.deviceId);
}

/** Coach-facing stroke rate: 15s median when available, else latest reading. */
export function resolveStrokeRate(p: MapPosition): number | null {
  const spm = p.displayStrokeRate ?? p.strokeRate ?? null;
  if (spm == null || !Number.isFinite(spm) || spm <= 0) return null;
  return spm;
}

export function syncMapTracks(positions: MapPosition[]) {
  const seen = new Set<string>();
  for (const p of positions) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    seen.add(p.deviceId);
    const fixMs = fixMsFor(p);
    const { lat, lon } = anchorLatLon(p);
    const prev = tracks.get(p.deviceId);
    let speedMps = p.pathSpeedMps ?? p.displaySpeedMps ?? null;
    let courseDeg = p.course ?? null;

    if (prev && prev.fixMs !== fixMs) {
      const dt = (fixMs - prev.fixMs) / 1000;
      if (dt > 0.05) {
        const dist = haversineM(prev.lat, prev.lon, lat, lon);
        if (speedMps == null) speedMps = dist / dt;
        courseDeg = bearingDeg(prev.lat, prev.lon, lat, lon);
      }
    } else if (prev) {
      speedMps = prev.speedMps;
      courseDeg = prev.courseDeg;
    }

    tracks.set(p.deviceId, {
      lat,
      lon,
      fixMs,
      speedMps,
      courseDeg,
      online: p.online !== false,
    });
  }
  for (const id of tracks.keys()) {
    if (!seen.has(id)) tracks.delete(id);
  }
}

export function displayLatLon(deviceId: string): { lat: number; lon: number } | null {
  const state = tracks.get(deviceId);
  if (!state) return null;
  const fixAgeSec = (Date.now() - state.fixMs) / 1000;
  if (!state.online || fixAgeSec > GPS_LIVE_SEC) {
    return { lat: state.lat, lon: state.lon };
  }
  const stepSec = Math.min(Math.max(0, fixAgeSec), MAX_EXTRAPOLATE_SEC);
  const speed = state.speedMps;
  if (
    speed != null &&
    speed >= MIN_SPEED_MPS &&
    state.courseDeg != null &&
    Number.isFinite(state.courseDeg)
  ) {
    const [lat, lon] = destinationLatLon(
      state.lat,
      state.lon,
      state.courseDeg,
      speed * stepSec,
    );
    return { lat, lon };
  }
  return { lat: state.lat, lon: state.lon };
}

export function onMapDisplayTick(
  cb: (deviceId: string, lat: number, lon: number) => void,
): () => void {
  listeners.add(cb);
  if (!tickTimer) {
    tickTimer = setInterval(() => {
      for (const [id] of tracks) {
        const pos = displayLatLon(id);
        if (pos) {
          for (const fn of listeners) fn(id, pos.lat, pos.lon);
        }
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

export function clearMapTracks() {
  tracks.clear();
}
