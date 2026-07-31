import { registerPlugin } from '@capacitor/core';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export type NativeCapsizeMonitorConfig = {
  sessionId: string;
  deviceId: string;
  ingestUrl: string;
  ingestToken?: string;
  athleteId?: string;
  enableGps?: boolean;
  enableMotion?: boolean;
  gpsIntervalMs?: number;
  startedAt?: number;
};

export type NativeActiveSession = {
  active: boolean;
  serviceRunning: boolean;
  standbyArmed?: boolean;
  autoStartedSession?: boolean;
  sessionId?: string;
  deviceId?: string;
  athleteId?: string;
  startedAt?: number;
};

export type NativeStandbyStatus = {
  armed: boolean;
  inside: boolean;
  zoneName: string | null;
  message: string;
  outsideDwellRemainingSec: number | null;
};

export type NativeGeofenceStandbyConfig = {
  deviceId: string;
  ingestUrl: string;
  ingestToken?: string;
  athleteId?: string;
  enableGps?: boolean;
  enableMotion?: boolean;
  gpsIntervalMs?: number;
};

export type NativeRecordingPulse = {
  lastGps?: { t: number; lat: number; lon: number; spd?: number; acc?: number; fixMs?: number };
  nativeGpsCount?: number;
  /** GPS fixes sent on heartbeat fallback (timer stall). */
  heartbeatGpsCount?: number;
  serviceRunning?: boolean;
  enableGps?: boolean;
  gpsIntervalMs?: number;
  /** Ms since last timer/callback GPS upload enqueue. */
  lastGpsUploadAgoMs?: number | null;
  /** Ms since a GPS sample was last added to the ingest buffer. */
  lastGpsSampleOfferedAgoMs?: number | null;
  /** Ms since last fused/legacy location callback. */
  lastFusedDeliveryAgoMs?: number | null;
  /** Ms since last good fix was cached in memory/prefs. */
  latestGpsCachedAgoMs?: number | null;
  ingestBufferCount?: number;
  pendingIngestBatches?: number;
  upload?: {
    seq?: number;
    ok?: boolean;
    code?: number;
    samples?: number;
    okCount?: number;
    failCount?: number;
    t?: number;
  };
};

export type NativeEconomyMode = {
  active: boolean;
  gpsIntervalMs: number;
  uploadIntervalMs: number;
  enableCapsize: boolean;
  suppressRecording?: boolean;
};

export type NativeRecordingSetupStatus = {
  ready: boolean;
  notifications: boolean;
  locationForeground: boolean;
  locationBackground: boolean;
  locationAlways: boolean;
  batteryUnrestricted: boolean;
  openedLocationSettings?: boolean;
  openedBatterySettings?: boolean;
};

export type NativeGeofenceZone = {
  name: string;
  kind?: string;
  shapeType: 'circle' | 'polygon';
  centerLat: number;
  centerLon: number;
  radiusM: number;
  polygonCoords: Array<[number, number]>;
  enabled: boolean;
  economyIntervalSec: number;
  disableCapsize: boolean;
  suppressRecording?: boolean;
  autoStopOnEnter?: boolean;
  autoStartOnExit?: boolean;
  sessionDwellSec?: number;
};

export interface NativeCapsizeMonitorPlugin {
  start(config: NativeCapsizeMonitorConfig): Promise<void>;
  stop(): Promise<void>;
  getActiveSession(): Promise<NativeActiveSession>;
  setUpright(options: { x: number; y: number; z: number }): Promise<void>;
  setStrokeRate(options: { spm: number }): Promise<void>;
  setLiveMapMode(options: { active: boolean }): Promise<void>;
  setGpsIntervalMs(options: { gpsIntervalMs: number }): Promise<void>;
  setEconomyMode(mode: NativeEconomyMode): Promise<void>;
  setGeofences(options: { geofences: NativeGeofenceZone[] }): Promise<void>;
  checkRecordingSetup(): Promise<NativeRecordingSetupStatus>;
  prepareRecording(): Promise<NativeRecordingSetupStatus>;
  getPulse(): Promise<NativeRecordingPulse>;
  armGeofenceStandby(config: NativeGeofenceStandbyConfig): Promise<void>;
  transitionToStandby(): Promise<void>;
  disarmGeofenceStandby(): Promise<void>;
  getStandbyStatus(): Promise<NativeStandbyStatus>;
}

const CapsizeMonitor = registerPlugin<NativeCapsizeMonitorPlugin>('CapsizeMonitor');

export async function startNativeCapsizeMonitor(
  config: NativeCapsizeMonitorConfig,
): Promise<boolean> {
  if (!IS_NATIVE) return false;
  try {
    await CapsizeMonitor.start({
      sessionId: config.sessionId,
      deviceId: config.deviceId,
      ingestUrl: config.ingestUrl,
      ingestToken: config.ingestToken ?? '',
      athleteId: config.athleteId ?? '',
      enableGps: config.enableGps ?? false,
      enableMotion: config.enableMotion ?? true,
      gpsIntervalMs: config.gpsIntervalMs ?? 1000,
      startedAt: config.startedAt,
    });
    return true;
  } catch {
    return false;
  }
}

export async function getNativeRecordingPulse(): Promise<NativeRecordingPulse | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.getPulse();
  } catch {
    return null;
  }
}

export async function stopNativeCapsizeMonitor(): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.stop();
  } catch {
    /* optional */
  }
}

export async function getNativeActiveSession(): Promise<NativeActiveSession | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.getActiveSession();
  } catch {
    return null;
  }
}

export async function syncNativeCapsizeUpright(
  x: number,
  y: number,
  z: number,
): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setUpright({ x, y, z });
  } catch {
    /* optional */
  }
}

export async function syncNativeStrokeRate(spm: number): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setStrokeRate({ spm });
  } catch {
    /* optional */
  }
}

export async function setNativeLiveMapMode(active: boolean): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setLiveMapMode({ active });
  } catch {
    /* optional */
  }
}

export async function setNativeGpsIntervalMs(gpsIntervalMs: number): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setGpsIntervalMs({ gpsIntervalMs });
  } catch {
    /* optional */
  }
}

export async function setNativeEconomyMode(mode: NativeEconomyMode): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setEconomyMode(mode);
  } catch {
    /* optional */
  }
}

export async function setNativeGeofences(geofences: NativeGeofenceZone[]): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.setGeofences({ geofences });
  } catch {
    /* optional */
  }
}

export async function checkNativeRecordingSetup(): Promise<NativeRecordingSetupStatus | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.checkRecordingSetup();
  } catch {
    return null;
  }
}

export async function prepareNativeRecordingSetup(): Promise<NativeRecordingSetupStatus | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.prepareRecording();
  } catch {
    return null;
  }
}

export async function armNativeGeofenceStandby(
  config: NativeGeofenceStandbyConfig,
): Promise<boolean> {
  if (!IS_NATIVE) return false;
  try {
    await CapsizeMonitor.armGeofenceStandby({
      deviceId: config.deviceId,
      ingestUrl: config.ingestUrl,
      ingestToken: config.ingestToken ?? '',
      athleteId: config.athleteId ?? '',
      enableGps: config.enableGps ?? true,
      enableMotion: config.enableMotion ?? true,
      gpsIntervalMs: config.gpsIntervalMs ?? 1000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function transitionToNativeGeofenceStandby(): Promise<boolean> {
  if (!IS_NATIVE) return false;
  try {
    await CapsizeMonitor.transitionToStandby();
    return true;
  } catch {
    return false;
  }
}

export async function disarmNativeGeofenceStandby(): Promise<void> {
  if (!IS_NATIVE) return;
  try {
    await CapsizeMonitor.disarmGeofenceStandby();
  } catch {
    /* optional */
  }
}

export async function getNativeStandbyStatus(): Promise<NativeStandbyStatus | null> {
  if (!IS_NATIVE) return null;
  try {
    return await CapsizeMonitor.getStandbyStatus();
  } catch {
    return null;
  }
}

/** User-facing log lines after prepareRecording(). */
export function recordingSetupLogLines(
  setup: NativeRecordingSetupStatus,
): string[] {
  const lines: string[] = [];
  if (setup.openedLocationSettings) {
    lines.push(
      'Open Permissions → Location → Allow all the time (or Always), then return to the app.',
    );
  }
  if (setup.openedBatterySettings) {
    lines.push(
      'When asked, allow unrestricted battery (Not optimized / Unrestricted).',
    );
  }
  if (setup.ready) {
    lines.push('Phone setup OK — notifications, location (Always), and battery.');
  } else {
    if (!setup.notifications) {
      lines.push('Allow notifications so recording can run in the background.');
    }
    if (!setup.locationForeground) {
      lines.push('Allow location (precise) for GPS recording.');
    } else if (!setup.locationBackground) {
      lines.push('Set location to Allow all the time — required for GPS with screen off.');
    }
    if (!setup.batteryUnrestricted) {
      lines.push('Set battery to Unrestricted / Not optimized for this app.');
    }
  }
  return lines;
}
