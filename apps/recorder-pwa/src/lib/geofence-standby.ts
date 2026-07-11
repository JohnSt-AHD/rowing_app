/**
 * Armed geofence standby: low-rate GPS watch while idle.
 * Auto-starts a session after dwell outside a zone with autoStartOnExit.
 */
import type { RecorderSettings } from '@rowing/telemetry-types';
import { startGpsWatcher } from '@rowing/sensor-adapters';
import { findBoatParkAt, type GeofenceConfig } from './geofence';
import { fetchGeofences } from './geofence-service';

export type StandbyStatus = {
  armed: boolean;
  inside: boolean;
  zoneName: string | null;
  message: string;
};

export type StandbyController = {
  stop: () => void;
  getStatus: () => StandbyStatus;
};

type StandbyHooks = {
  onStatus: (status: StandbyStatus) => void;
  onAutoStart: () => void | Promise<void>;
  onLog: (msg: string) => void;
};

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';
/** Poll often enough that leave-park is noticed; background GPS on native. */
const WATCH_MS = 5000;
const ZONE_FETCH_TIMEOUT_MS = 8000;
/** Ignore GPS readings whose fix time is older than this (stale replay). */
const MAX_FIX_AGE_MS = 20000;

export async function startGeofenceStandby(
  settings: RecorderSettings,
  hooks: StandbyHooks,
): Promise<StandbyController> {
  let geofences: GeofenceConfig[] = [];
  let stopped = false;
  let inside = false;
  let zoneName: string | null = null;
  let outsideSinceMs: number | null = null;
  let startTriggered = false;
  let lastFreshFixMs = 0;
  let message = 'Armed — waiting for GPS…';

  const emit = (nextMessage: string) => {
    message = nextMessage;
    hooks.onStatus({
      armed: !stopped,
      inside,
      zoneName,
      message,
    });
  };

  const autoStartZones = () =>
    geofences.filter((g) => g.enabled && g.autoStartOnExit === true);

  const dwellMsFor = () => {
    const zones = autoStartZones();
    const sec = zones[0]?.sessionDwellSec ?? 45;
    return Math.max(5000, sec * 1000);
  };

  const refreshZones = async (force = false) => {
    try {
      geofences = await fetchGeofences(
        settings.ingestUrl,
        settings.ingestToken,
        force,
        ZONE_FETCH_TIMEOUT_MS,
      );
    } catch (e) {
      hooks.onLog(
        `Geofence fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  emit('Armed — loading geofences…');
  void refreshZones(true).then(() => {
    if (stopped) return;
    if (!autoStartZones().length) {
      hooks.onLog(
        'No auto-start geofences loaded yet (check ingest token / network). GPS watch is on.',
      );
      emit('Armed — waiting for GPS (no auto-start zones yet)');
    } else {
      hooks.onLog(
        `Geofence standby armed — auto-start after leaving park (${autoStartZones().length} zone(s)).`,
      );
      emit('Armed — waiting for GPS…');
    }
  });

  const tryAutoStart = () => {
    if (stopped || startTriggered) return;
    if (!autoStartZones().length) return;
    if (inside) return;
    if (outsideSinceMs == null) return;
    if (!lastFreshFixMs) return;

    const dwellMs = dwellMsFor();
    const elapsed = Date.now() - outsideSinceMs;
    if (elapsed < dwellMs) {
      const left = Math.ceil((dwellMs - elapsed) / 1000);
      emit(`Outside park — auto-start in ${left}s`);
      return;
    }

    startTriggered = true;
    emit('Starting session…');
    hooks.onLog('Left geofence — auto-starting session.');
    void Promise.resolve(hooks.onAutoStart()).catch((e) => {
      startTriggered = false;
      outsideSinceMs = null;
      hooks.onLog(`Auto-start failed: ${e instanceof Error ? e.message : String(e)}`);
      emit('Armed — auto-start failed, retrying…');
    });
  };

  const onFix = (lat: number, lon: number, fixMs: number) => {
    if (stopped || startTriggered) return;

    const age = Date.now() - fixMs;
    if (age > MAX_FIX_AGE_MS) {
      emit(`Armed — GPS stale (${Math.round(age / 1000)}s), waiting for fresh fix…`);
      return;
    }
    lastFreshFixMs = fixMs;

    if (!autoStartZones().length) {
      emit('Armed — GPS ok, waiting for auto-start zones…');
      return;
    }

    const match = findBoatParkAt(lat, lon, geofences);
    const blocking = match != null && match.autoStartOnExit === true;
    inside = blocking;
    zoneName = blocking ? match!.name : null;

    if (blocking) {
      outsideSinceMs = null;
      emit(`In ${match!.name} — leave park to auto-start`);
      return;
    }

    if (outsideSinceMs == null) outsideSinceMs = Date.now();
    tryAutoStart();
  };

  // Wall-clock dwell — do not rely on GPS callback rate alone.
  const dwellTimer = setInterval(() => {
    if (stopped || startTriggered) return;
    if (inside || outsideSinceMs == null) return;
    if (Date.now() - lastFreshFixMs > MAX_FIX_AGE_MS) {
      emit('Armed — GPS stale, waiting for fresh fix…');
      return;
    }
    tryAutoStart();
  }, 1000);

  const gps = startGpsWatcher(
    (r) => {
      if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
        const fixMs = Number.isFinite(r.t) ? r.t : Date.now();
        onFix(r.lat, r.lon, fixMs);
      }
    },
    WATCH_MS,
    (m) => {
      hooks.onLog(`Standby GPS: ${m}`);
      emit(`Armed — GPS: ${m}`);
    },
    { enableBackground: IS_NATIVE },
  );

  const refreshTimer = setInterval(() => {
    void refreshZones(true);
  }, 5 * 60 * 1000);

  return {
    getStatus: () => ({
      armed: !stopped,
      inside,
      zoneName,
      message,
    }),
    stop: () => {
      stopped = true;
      clearInterval(refreshTimer);
      clearInterval(dwellTimer);
      try {
        void Promise.resolve(gps.stop());
      } catch {
        /* ignore */
      }
      emit('Standby off');
    },
  };
}
