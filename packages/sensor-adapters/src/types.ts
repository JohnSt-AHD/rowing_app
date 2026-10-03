import type { GpsSample, HrSample, MotionSample } from '@rowing/telemetry-types';

export type GpsReading = GpsSample & { t: number };
export type MotionReading = MotionSample & { t: number };
export type HrReading = HrSample & { t: number };

export type GpsWatcher = { stop: () => void | Promise<void> };
export type MotionWatcher = { stop: () => void | Promise<void> };

export type HeartRateMonitor = {
  name: string;
  /** Platform device id for reconnect (Capacitor BLE / Web Bluetooth). */
  deviceId?: string;
  disconnect: () => Promise<void>;
};

export type ConnectHeartRateOptions = {
  /** Try reconnecting to a previously paired device before showing the picker. */
  deviceId?: string | null;
  name?: string | null;
};

export type SensorAdapters = {
  startGpsWatcher: (
    onReading: (r: GpsReading) => void,
    intervalMs: number,
    onError?: (msg: string) => void,
    options?: { enableBackground?: boolean },
  ) => GpsWatcher | Promise<GpsWatcher>;
  startMotionWatcher: (
    onReading: (r: MotionReading) => void,
    intervalMs: number,
    onError?: (msg: string) => void,
    options?: { enableBackground?: boolean },
  ) => Promise<MotionWatcher>;
  connectHeartRate: (
    onReading: (r: HrReading) => void,
    onError?: (msg: string) => void,
    options?: ConnectHeartRateOptions,
  ) => Promise<HeartRateMonitor | null>;
  requestNativePermissions?: () => Promise<void>;
};
