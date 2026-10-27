/** Shared telemetry schemas for recorder PWA and ingest API. */

export type GpsSample = {
  lat: number;
  lon: number;
  acc?: number;
  spd?: number;
  /** GPS course-over-ground (degrees). */
  hdg?: number;
  /** Magnetometer / device compass (degrees). Omitted when hardware has no compass. */
  compass?: number;
  alt?: number;
  /** Android/Geolocation fix clock (ms) — when the position was measured, not upload time. */
  fixMs?: number;
  /** fused / gps / network — underlying Android provider when known. */
  provider?: string;
  /** How this fix was produced on device (window_avg, heartbeat_cache, etc.). */
  sampleSource?: string;
};

export type MotionSample = {
  ax: number;
  ay: number;
  az: number;
};

export type HrSample = {
  bpm: number;
  contact?: boolean;
};

export type DerivedSample = {
  /** Strokes per minute from boat surge (15–50 when valid). */
  strokeRate?: number;
  /** Boat tipped past ~90° from session-start upright. */
  capsize?: boolean;
  /** Local UX: phone is upright again. Does not clear Manager/RowSafe sticky. */
  capsizeCleared?: boolean;
  /** Athlete recalled the fleet alarm (I'm OK / false alarm). */
  capsizeRecalled?: boolean;
  /** Angle from calibrated upright (degrees). */
  tiltDeg?: number;
  /** Session alive ping (no GPS required). */
  heartbeat?: boolean;
  /** Device battery 0–100 (reported periodically). */
  batteryPct?: number;
  /** Inside a dashboard boat-park geofence (economy mode). */
  inBoatPark?: boolean;
  /** Completed or snapshot CrewSight workout (piece / intervals). */
  workout?: Record<string, unknown>;
};

export type TelemetrySample = {
  t: number;
  gps?: GpsSample;
  motion?: MotionSample;
  hr?: HrSample;
  derived?: DerivedSample;
};

export type TelemetryBatch = {
  sessionId: string;
  deviceId: string;
  athleteId?: string;
  /** Selected fleet boat id from manager setup. */
  boatId?: string;
  /** Denormalised boat class code (e.g. M1x) for server display. */
  boatClass?: string;
  samples: TelemetrySample[];
};

export type RecorderSettings = {
  deviceId: string;
  /**
   * Coach display names for the outing (comma-separated). Uploaded as ingest
   * `athleteId` (legacy column name); the API maps it to `coach` for Manager /
   * RowSafe — not the Athlete label.
   */
  athleteId: string;
  /** First selected coach roster id (legacy single-select). */
  coachId?: string;
  /** Selected coach roster ids from fleet config (Manager → Coaches & Boats). */
  coachIds?: string[];
  /** Selected boat id from fleet config. */
  boatId: string;
  /** Boat class code for prognostic pace (from selected boat). */
  boatClass: string;
  ingestUrl: string;
  ingestToken: string;
  gpsIntervalMs: number;
  motionIntervalMs: number;
  /** Min interval between motion-only upload samples (when GPS is off). */
  motionUploadIntervalMs: number;
  uploadBatchMs: number;
  enableGps: boolean;
  enableMotion: boolean;
  enableHr: boolean;
  /** Best-effort recording when screen locks or app is in background. */
  enableBackgroundRecording: boolean;
  /** Keep screen awake while recording (Screen Wake Lock API). */
  keepScreenOn: boolean;
  /**
   * Arm geofence standby: auto-start when leaving boat park, auto-stop when entering.
   * Best on native app with Always location.
   */
  geofenceSessionControl: boolean;
};

/** Production ingest API (Vercel). Used as default on phones and new installs. */
export const DEFAULT_INGEST_URL =
  'https://rowing-app-recorder-pwa.vercel.app/api/ingest';

export const DEFAULT_SETTINGS: RecorderSettings = {
  deviceId: '',
  athleteId: '',
  coachId: '',
  coachIds: [],
  boatId: '',
  boatClass: '',
  ingestUrl: DEFAULT_INGEST_URL,
  ingestToken: '',
  gpsIntervalMs: 10000,
  motionIntervalMs: 50,
  motionUploadIntervalMs: 10000,
  uploadBatchMs: 20000,
  enableGps: true,
  enableMotion: true,
  enableHr: true,
  enableBackgroundRecording: true,
  keepScreenOn: true,
  geofenceSessionControl: true,
};

export function normalizeCoachName(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/** Split a stored coach field (`Mike` or `Mike, Tom`) into display names. */
export function parseCoachNames(value?: string | null): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of raw.split(/[,;|]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = normalizeCoachName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function formatCoachNames(names: Array<string | null | undefined>): string {
  return parseCoachNames(names.filter(Boolean).join(', ')).join(', ');
}

export function coachNamesInclude(
  haystack?: string | null,
  coach?: string | null,
): boolean {
  const want = normalizeCoachName(coach);
  if (!want) return false;
  return parseCoachNames(haystack).some((name) => normalizeCoachName(name) === want);
}

export function selectedCoachIds(settings: {
  coachIds?: string[] | null;
  coachId?: string | null;
}): string[] {
  const many = Array.isArray(settings.coachIds)
    ? settings.coachIds.map((id) => String(id ?? '').trim()).filter(Boolean)
    : [];
  if (many.length) {
    const seen = new Set<string>();
    return many.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  const one = String(settings.coachId ?? '').trim();
  return one ? [one] : [];
}

export type SessionMeta = {
  sessionId: string;
  deviceId: string;
  athleteId: string;
  startedAt: number;
  endedAt?: number;
};

export type IngestResponse = {
  ok: boolean;
  received?: number;
  sessionId?: string;
  ended?: boolean;
  persisted?: boolean;
};
