import { isDemoMode } from './demo-mode';
import {
  COACH_BOAT_CLASS,
  MANAGER_SOURCE,
  managerDeviceId,
} from './coach-identity';
import {
  clampLocationIntervalMs,
  type CoachSettings,
} from './settings';

const LS_SESSION = 'coach_location_session_v1';

export type CoachLocationStatus = {
  running: boolean;
  deviceId: string;
  lastFixMs: number | null;
  lastOkMs: number | null;
  lastError: string | null;
};

type StoredSession = { sessionId: string; deviceId: string };

let timer: ReturnType<typeof setInterval> | null = null;
let settings: CoachSettings | null = null;
let session: StoredSession | null = null;
let lastFixMs: number | null = null;
let lastOkMs: number | null = null;
let lastError: string | null = null;
let inFlight = false;
let onStatus: ((s: CoachLocationStatus) => void) | null = null;

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.sessionId || !parsed?.deviceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredSession(next: StoredSession | null): void {
  try {
    if (!next) localStorage.removeItem(LS_SESSION);
    else localStorage.setItem(LS_SESSION, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function ingestUrl(s: CoachSettings): string {
  return `${String(s.apiBaseUrl ?? '').replace(/\/$/, '')}/api/ingest`;
}

function emitStatus(): void {
  onStatus?.(getCoachLocationStatus());
}

function ensureSession(deviceId: string): StoredSession {
  const prev = session || readStoredSession();
  if (prev && prev.deviceId === deviceId && prev.sessionId) {
    session = prev;
    return prev;
  }
  session = { sessionId: crypto.randomUUID(), deviceId };
  writeStoredSession(session);
  return session;
}

async function postIngest(s: CoachSettings, body: Record<string, unknown>): Promise<void> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (s.ingestToken.trim()) headers.Authorization = `Bearer ${s.ingestToken.trim()}`;
  const res = await fetch(ingestUrl(s), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text.trim().slice(0, 160) || `Ingest ${res.status}`);
  }
}

function readPosition(): Promise<GeolocationPosition> {
  if (!navigator.geolocation) {
    return Promise.reject(new Error('This device has no GPS / location'));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 8_000,
    });
  });
}

async function uploadFix(s: CoachSettings): Promise<void> {
  const deviceId = managerDeviceId(s.coachName);
  if (!deviceId) throw new Error('Select a coach first');
  const pos = await readPosition();
  lastFixMs = pos.timestamp || Date.now();
  const coords = pos.coords;
  const sess = ensureSession(deviceId);
  const now = Date.now();
  await postIngest(s, {
    sessionId: sess.sessionId,
    deviceId,
    athleteId: s.coachName.trim(),
    boatClass: COACH_BOAT_CLASS,
    source: MANAGER_SOURCE,
    samples: [
      {
        t: now,
        gps: {
          lat: coords.latitude,
          lon: coords.longitude,
          acc: Number.isFinite(coords.accuracy) ? coords.accuracy : undefined,
          spd:
            coords.speed != null && Number.isFinite(coords.speed) && coords.speed >= 0
              ? coords.speed
              : undefined,
          hdg:
            coords.heading != null && Number.isFinite(coords.heading)
              ? coords.heading
              : undefined,
          fixMs: lastFixMs,
          sampleSource: 'manager_watch',
        },
        derived: { heartbeat: true },
      },
    ],
  });
  lastOkMs = now;
  lastError = null;
}

async function tick(): Promise<void> {
  if (inFlight || !settings) return;
  inFlight = true;
  try {
    await uploadFix(settings);
  } catch (err) {
    const geo = err as GeolocationPositionError;
    if (geo && typeof geo.code === 'number') {
      if (geo.code === geo.PERMISSION_DENIED) {
        lastError = 'Location permission denied';
      } else if (geo.code === geo.POSITION_UNAVAILABLE) {
        lastError = 'GPS unavailable';
      } else if (geo.code === geo.TIMEOUT) {
        lastError = 'GPS timed out';
      } else {
        lastError = geo.message || 'Location failed';
      }
    } else {
      lastError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    inFlight = false;
    emitStatus();
  }
}

async function endStoredSession(s: CoachSettings, sess: StoredSession): Promise<void> {
  try {
    await postIngest(s, {
      action: 'end',
      sessionId: sess.sessionId,
      deviceId: sess.deviceId,
      athleteId: s.coachName.trim() || undefined,
      endedAt: Date.now(),
    });
  } catch {
    /* best-effort — tablet may be offline */
  }
}

export function getCoachLocationStatus(): CoachLocationStatus {
  return {
    running: timer != null,
    deviceId: settings ? managerDeviceId(settings.coachName) : '',
    lastFixMs,
    lastOkMs,
    lastError,
  };
}

export function stopCoachLocation(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  emitStatus();
}

export async function startCoachLocation(
  next: CoachSettings,
  statusCb?: (s: CoachLocationStatus) => void,
): Promise<void> {
  onStatus = statusCb || onStatus;
  if (isDemoMode()) {
    stopCoachLocation();
    lastError = null;
    emitStatus();
    return;
  }
  const intervalMs = clampLocationIntervalMs(next.locationIntervalMs);
  const deviceId = managerDeviceId(next.coachName);
  const canRun =
    next.shareLocation &&
    Boolean(deviceId) &&
    Boolean(next.apiBaseUrl.trim()) &&
    Boolean(next.ingestToken.trim());
  if (!canRun) {
    const prev = session || readStoredSession();
    if (prev && settings) void endStoredSession(settings, prev);
    session = null;
    writeStoredSession(null);
    settings = next;
    stopCoachLocation();
    if (!next.shareLocation) lastError = null;
    else if (!deviceId) lastError = 'Select a coach to share location';
    else if (!next.ingestToken.trim()) lastError = 'Save the ingest password first';
    emitStatus();
    return;
  }
  settings = { ...next, locationIntervalMs: intervalMs };
  const prev = session || readStoredSession();
  if (prev && prev.deviceId !== deviceId) {
    void endStoredSession(settings, prev);
    session = null;
    writeStoredSession(null);
  }
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), intervalMs);
  emitStatus();
  void tick();
}

export function syncCoachLocation(
  next: CoachSettings,
  statusCb?: (s: CoachLocationStatus) => void,
): void {
  void startCoachLocation(next, statusCb);
}
