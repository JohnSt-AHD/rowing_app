import type { GpsReading, GpsWatcher } from '../types';

function positionToReading(pos: GeolocationPosition): GpsReading {
  const c = pos.coords;
  return {
    t: pos.timestamp,
    lat: c.latitude,
    lon: c.longitude,
    acc: c.accuracy,
    spd: c.speed ?? undefined,
    hdg: c.heading ?? undefined,
    alt: c.altitude ?? undefined,
  };
}

/**
 * Prefer fresh getCurrentPosition each tick. Do not replay a stale last fix
 * with a new timestamp — that breaks geofence leave detection.
 */
export function startGpsWatcher(
  onReading: (r: GpsReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): GpsWatcher {
  if (!navigator.geolocation) {
    onError?.('Geolocation not supported');
    return { stop: () => {} };
  }

  let watchId: number | null = null;
  let last: GpsReading | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const opts: PositionOptions = {
    enableHighAccuracy: true,
    maximumAge: Math.min(2000, Math.max(0, intervalMs)),
    timeout: 15000,
  };

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      last = positionToReading(pos);
      if (!stopped) onReading(last);
    },
    (err) => onError?.(err.message),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );

  timer = setInterval(() => {
    if (stopped) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        last = positionToReading(pos);
        if (!stopped) onReading(last);
      },
      (err) => {
        onError?.(err.message);
        // Only fall back if the cached fix is still reasonably fresh.
        if (last && Date.now() - last.t < intervalMs * 2) {
          onReading(last);
        }
      },
      opts,
    );
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
      if (timer) clearInterval(timer);
    },
  };
}

export type { GpsReading, GpsWatcher };
