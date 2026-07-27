import { registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';
import type { GpsReading, GpsWatcher } from '../types';

const BackgroundGeolocation =
  registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

/**
 * GPS via foreground service + background location (screen off / app in background).
 * Requires android.useLegacyBridge and POST_NOTIFICATIONS on Android 13+.
 */
export function startBackgroundGpsWatcher(
  onReading: (r: GpsReading) => void,
  intervalMs: number,
  onError?: (msg: string) => void,
): GpsWatcher {
  let watcherId: string | undefined;
  let stopped = false;
  let lastEmit = 0;

  void BackgroundGeolocation.addWatcher(
    {
      backgroundMessage: 'CrewSight GPS active — keep the app for live tracking.',
      backgroundTitle: 'CrewSight',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    },
    (location, err) => {
      if (stopped) return;
      if (err) {
        const msg =
          typeof err === 'object' && err && 'message' in err
            ? String((err as { message?: string }).message)
            : String(err);
        onError?.(msg);
        return;
      }
      if (!location) return;

      const now = Date.now();
      if (now - lastEmit < intervalMs) return;
      lastEmit = now;

      const fixMs =
        typeof location.time === 'number' && Number.isFinite(location.time)
          ? location.time
          : now;

      onReading({
        t: fixMs,
        fixMs,
        lat: location.latitude,
        lon: location.longitude,
        acc: location.accuracy,
        spd: location.speed ?? undefined,
        hdg: location.bearing ?? undefined,
        alt: location.altitude ?? undefined,
      });
    },
  )
    .then((id) => {
      watcherId = id;
    })
    .catch((e) => {
      onError?.(e instanceof Error ? e.message : String(e));
    });

  return {
    stop: async () => {
      stopped = true;
      if (watcherId) {
        await BackgroundGeolocation.removeWatcher({ id: watcherId });
        watcherId = undefined;
      }
    },
  };
}
