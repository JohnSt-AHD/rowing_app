import {
  connectHeartRate,
  type HeartRateMonitor,
  type HrReading,
} from '@rowing/sensor-adapters';

const LS_HR_DEVICE = 'rnz_hr_device_v1';

export type SavedHrDevice = {
  deviceId: string;
  name: string;
};

export type HrConnectionStatus = {
  connected: boolean;
  name: string | null;
  lastBpm: number | null;
  savedDevice: SavedHrDevice | null;
};

type SessionSink = (r: HrReading) => void;

let monitor: HeartRateMonitor | null = null;
let connected = false;
let lastName: string | null = null;
let lastBpm: number | null = null;
let sessionSink: SessionSink | null = null;
const listeners = new Set<() => void>();

function readSaved(): SavedHrDevice | null {
  try {
    const raw = localStorage.getItem(LS_HR_DEVICE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedHrDevice;
    if (!parsed?.deviceId) return null;
    return {
      deviceId: String(parsed.deviceId),
      name: String(parsed.name || 'HR monitor'),
    };
  } catch {
    return null;
  }
}

function writeSaved(device: SavedHrDevice): void {
  localStorage.setItem(LS_HR_DEVICE, JSON.stringify(device));
}

function notify(): void {
  for (const cb of listeners) cb();
}

function handleReading(r: HrReading): void {
  lastBpm = r.bpm;
  connected = true;
  sessionSink?.(r);
  notify();
}

function handleDisconnectMessage(msg: string, onLog?: (m: string) => void): void {
  onLog?.(msg);
  if (/disconnect/i.test(msg)) {
    connected = false;
    monitor = null;
    notify();
  }
}

export function getHrConnectionStatus(): HrConnectionStatus {
  return {
    connected: connected && monitor != null,
    name: lastName,
    lastBpm,
    savedDevice: readSaved(),
  };
}

export function subscribeHrConnection(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Recorder attaches this so live BPM feeds the active session. */
export function setHrSessionSink(sink: SessionSink | null): void {
  sessionSink = sink;
}

export function isHrConnected(): boolean {
  return connected && monitor != null;
}

/**
 * Pair (or reconnect) a BLE heart-rate strap.
 * Works with or without an active recording session — call from a user gesture.
 */
export async function pairHeartRate(
  onLog?: (m: string) => void,
): Promise<boolean> {
  const saved = readSaved();
  if (monitor) {
    try {
      await monitor.disconnect();
    } catch {
      /* ignore */
    }
    monitor = null;
  }
  connected = false;
  notify();

  if (saved?.deviceId) {
    onLog?.(`Trying remembered strap (${saved.name})…`);
  } else {
    onLog?.('Looking for a Bluetooth heart-rate strap…');
  }

  const next = await connectHeartRate(
    handleReading,
    (m) => handleDisconnectMessage(m, onLog),
    saved ? { deviceId: saved.deviceId, name: saved.name } : undefined,
  );

  if (!next) {
    connected = false;
    lastName = null;
    notify();
    onLog?.('HR: no monitor selected.');
    return false;
  }

  monitor = next;
  lastName = next.name;
  connected = true;
  if (next.deviceId) {
    writeSaved({ deviceId: next.deviceId, name: next.name });
  }
  onLog?.(`Connected: ${next.name}`);
  notify();
  return true;
}

/** Best-effort reconnect to the last strap (may work on native without a picker). */
export async function tryReconnectSavedHr(
  onLog?: (m: string) => void,
): Promise<boolean> {
  if (isHrConnected()) return true;
  const saved = readSaved();
  if (!saved?.deviceId) return false;
  return pairHeartRate(onLog);
}

export async function disconnectHeartRate(): Promise<void> {
  if (monitor) {
    try {
      await monitor.disconnect();
    } catch {
      /* ignore */
    }
  }
  monitor = null;
  connected = false;
  lastBpm = null;
  notify();
}
