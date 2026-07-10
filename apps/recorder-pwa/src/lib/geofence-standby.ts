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

const DEFAULT_WATCH_MS = 15000;
const ZONE_FETCH_TIMEOUT_MS = 8000;

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

  // Arm GPS immediately — do not block on zone fetch (can hang if API is slow).
  emit('Armed — loading geofences…');
  void refreshZones(true).then(() => {
    if (stopped) return;
    const autoStartZones = () =>
      geofences.filter((g) => g.enabled && g.autoStartOnExit === true);
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

  const autoStartZones = () =>
    geofences.filter((g) => g.enabled && g.autoStartOnExit === true);

  const dwellMsFor = () => {
    const zones = autoStartZones();
    const sec = zones[0]?.sessionDwellSec ?? 45;
    return Math.max(5000, sec * 1000);
  };

  const onFix = (lat: number, lon: number) => {
    if (stopped || startTriggered) return;
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

    const dwellMs = dwellMsFor();
    const now = Date.now();
    if (outsideSinceMs == null) outsideSinceMs = now;
    const elapsed = now - outsideSinceMs;
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

  const watchMs = Math.max(DEFAULT_WATCH_MS, 15000);

  const gps = startGpsWatcher(
    (r) => {
      if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) onFix(r.lat, r.lon);
    },
    watchMs,
    (m) => {
      hooks.onLog(`Standby GPS: ${m}`);
      emit(`Armed — GPS: ${m}`);
    },
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
      try {
        gps.stop();
      } catch {
        /* ignore */
      }
      emit('Standby off');
    },
  };
}
