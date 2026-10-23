import {
  adminAuthHeaders,
  authHeaders,
  type CoachSettings,
} from './settings';
import {
  demoDeviceHistoryRange,
  demoDevices,
  demoHistoryDevices,
  demoLogbook,
  demoMapPositions,
  demoSessionDashboard,
  demoSessionsFor,
  demoTimingLines,
  isDemoMode,
} from './demo-mode';

export type FleetDevice = {
  deviceId: string;
  /** Device / outing name (recorder Name = deviceId). */
  name?: string | null;
  /** Rower / athlete name when known (walk-up); not the coach. */
  athleteId?: string | null;
  /** Coach name from latest session (recorder Settings → Coach). */
  coach?: string | null;
  boatId?: number | string | null;
  boatClass?: string | null;
  boatName?: string | null;
  online?: boolean;
  lastSeenAgoSec?: number;
  /** Walk-up / logbook-only session (no GPS). */
  noGps?: boolean;
  /** recorder | walkup | manager */
  source?: string | null;
  /** coach when this is a Manager / coach-launch tablet. */
  role?: string | null;
  walkupSessionId?: string | null;
  gps?: { ageSec?: number | null; present?: boolean; displayAgeSec?: number | null; ingestAgoSec?: number | null };
  /** Resolved GPS fix age (map + API). */
  gpsAgeSec?: number;
  rowing?: {
    strokeRate?: number | null;
    strokeRateValid?: boolean;
    capsize?: boolean;
  };
  displayStrokeRate?: number | null;
  strokeRateMedian?: number | null;
};

export type MapPosition = {
  deviceId: string;
  latitude: number;
  longitude: number;
  smoothLatitude?: number;
  smoothLongitude?: number;
  speed?: number | null;
  course?: number | null;
  strokeRate?: number | null;
  strokeRateValid?: boolean;
  capsize?: boolean;
  fixAgeSec?: number;
  fixMs?: number;
  lastSeenAgoSec?: number;
  telemetryStale?: boolean;
  online?: boolean;
  athleteId?: string | null;
  accuracy?: number | null;
  compass?: number | null;
  gpsProvider?: string | null;
  gpsSampleSource?: string | null;
  pathSpeedMps?: number | null;
  recentPathSpeedMps?: number | null;
  displaySpeedMps?: number | null;
  displayStrokeRate?: number | null;
  strokeRateMedian?: number | null;
  strokeMedianWindowSec?: number;
  source?: string | null;
  role?: string | null;
  boatClass?: string | null;
};

export type FleetCoach = {
  id: string;
  name: string;
  sortOrder?: number;
};

export type FleetBoat = {
  id: string;
  name: string;
  boatClass: string;
  label?: string;
  sortOrder?: number;
  enabled?: boolean;
};

export type FleetConfig = {
  ok?: boolean;
  coaches: FleetCoach[];
  boats: FleetBoat[];
  showOtherBoatsOnMap?: boolean;
  persisted?: boolean;
};

const DEFAULT_FLEET_COACHES: FleetCoach[] = ['Mike', 'Tom', 'James', 'Nick', 'Other'].map(
  (name, i) => ({ id: `coach-${i + 1}`, name, sortOrder: i }),
);

export function defaultFleetConfig(): FleetConfig {
  return { coaches: DEFAULT_FLEET_COACHES, boats: [], persisted: false };
}

export async function fetchFleetConfig(settings: CoachSettings): Promise<FleetConfig> {
  if (isDemoMode()) return defaultFleetConfig();
  const url = `${apiBase(settings)}/api/fleet-config`;
  try {
    const res = await fetch(url, { headers: authHeaders(settings) });
    const data = (await res.json()) as FleetConfig & { error?: string };
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `Fleet ${res.status}`);
    }
    return {
      coaches: Array.isArray(data.coaches) && data.coaches.length ? data.coaches : DEFAULT_FLEET_COACHES,
      boats: data.boats ?? [],
      showOtherBoatsOnMap: Boolean(data.showOtherBoatsOnMap),
      persisted: data.persisted,
    };
  } catch {
    return defaultFleetConfig();
  }
}

export type TimingLine = {
  id: number;
  name: string;
  lineType: 'start' | 'finish' | 'split';
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  distanceM: number | null;
  sortOrder: number;
  courseGroup: string | null;
  courseBearingDeg: number | null;
  enabled: boolean;
};

export type TimingLinesPayload = {
  ok?: boolean;
  org?: string;
  persisted?: boolean;
  lines?: TimingLine[];
  error?: string;
};

function apiBase(settings: CoachSettings): string {
  return String(settings.apiBaseUrl ?? '').replace(/\/$/, '');
}

export async function fetchDevices(settings: CoachSettings): Promise<FleetDevice[]> {
  if (isDemoMode()) return demoDevices();
  const url = `${apiBase(settings)}/api/devices?windowSec=60&onlineSec=120`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Devices 401 — set ingest token in Settings');
    }
    throw new Error(`Devices ${res.status}`);
  }
  const data = (await res.json()) as { devices?: FleetDevice[] };
  return (data.devices ?? []).map((d) => ({
    ...d,
    deviceId: String(d.deviceId ?? ''),
  }));
}

export async function fetchMapPositions(settings: CoachSettings): Promise<MapPosition[]> {
  if (isDemoMode()) return demoMapPositions();
  const url = `${apiBase(settings)}/api/map-positions?onlineSec=120&staleSec=3600&predictMode=rowing`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Map 401 — set ingest token in Settings');
    }
    throw new Error(`Map ${res.status}`);
  }
  const data = (await res.json()) as { positions?: MapPosition[] };
  return (data.positions ?? [])
    .map((p) => ({
      ...p,
      deviceId: String(p.deviceId ?? ''),
    }))
    .filter(
      (p) => p.deviceId && Number.isFinite(p.latitude) && Number.isFinite(p.longitude),
    );
}

export async function fetchTimingLines(settings: CoachSettings): Promise<TimingLinesPayload> {
  if (isDemoMode()) return demoTimingLines();
  const url = `${apiBase(settings)}/api/timing-lines`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Timing lines 401 — check ingest token in Settings');
    }
    throw new Error(`Timing lines ${res.status}`);
  }
  return (await res.json()) as TimingLinesPayload;
}

export type CapsizeAckSource = 'manager' | 'rowsafe' | 'remote';

export type CapsizeDayLogEntry = {
  id: string;
  deviceId: string;
  name: string;
  lat: number | null;
  lon: number | null;
  startedAt: number;
  status: 'active' | 'acknowledged' | 'cleared';
  ackedAt?: number;
  ackedBy?: string;
  ackSource?: CapsizeAckSource;
};

export async function fetchCapsizeDayLog(
  settings: CoachSettings,
): Promise<CapsizeDayLogEntry[] | null> {
  if (isDemoMode()) return null;
  const url = `${apiBase(settings)}/api/capsize-day-log`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`Capsize log ${res.status}`);
  const data = (await res.json()) as { events?: CapsizeDayLogEntry[] };
  return Array.isArray(data.events) ? data.events : [];
}

export async function clearCapsizeAlert(
  settings: CoachSettings,
  deviceId?: string,
  meta?: { ackedBy?: string; ackSource?: CapsizeAckSource },
) {
  if (isDemoMode()) return { ok: true, helpNotified: [], cleared: deviceId ? [deviceId] : [] };
  const url = `${apiBase(settings)}/api/capsize-clear`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(deviceId ? { deviceId } : {}),
      ackedBy: meta?.ackedBy,
      ackSource: meta?.ackSource || 'manager',
    }),
  });
  if (!res.ok) throw new Error(`Clear capsize ${res.status}`);
  return res.json();
}

export type SessionSummary = {
  session_id: string;
  unique_id: string;
  started_at: string;
  ended_at?: string | null;
  sample_count?: number;
  boat_class?: string | null;
  boatClass?: string | null;
  athlete_id?: string | null;
  athleteId?: string | null;
};

function pickTrimmed(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return null;
}

function normalizeSessionSummary(raw: SessionSummary): SessionSummary {
  const boatClass = pickTrimmed(raw.boat_class, raw.boatClass);
  const athleteId = pickTrimmed(raw.athlete_id, raw.athleteId);
  return {
    ...raw,
    boat_class: boatClass,
    boatClass,
    athlete_id: athleteId,
    athleteId,
  };
}

export type HistoryDevice = {
  uniqueId?: string;
  unique_id?: string;
  deviceId?: string;
  name?: string;
  sampleCount?: number;
};

export async function listHistoryDevices(settings: CoachSettings): Promise<HistoryDevice[]> {
  if (isDemoMode()) return demoHistoryDevices();
  const url = `${apiBase(settings)}/api/history?list=devices`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`Devices ${res.status}`);
  const data = (await res.json()) as { devices?: HistoryDevice[] };
  return data.devices ?? [];
}

export async function listSessions(
  settings: CoachSettings,
  deviceId: string,
): Promise<SessionSummary[]> {
  if (isDemoMode()) return demoSessionsFor(deviceId);
  const url = `${apiBase(settings)}/api/history?list=sessions&uniqueId=${encodeURIComponent(deviceId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`Sessions ${res.status}`);
  const data = (await res.json()) as { sessions?: SessionSummary[] };
  return (data.sessions ?? []).map(normalizeSessionSummary);
}

export type HistoryPoint = {
  t: number;
  lat?: number;
  lon?: number;
  speed?: number;
  hr?: number | null;
  strokeRate?: number;
  capsize?: boolean;
};

export type DashboardHistoryPayload = {
  track?: HistoryPoint[];
  from?: string;
  to?: string;
  uniqueId?: string;
  athleteId?: string | null;
  boatClass?: string | null;
  boat_class?: string | null;
  athlete_id?: string | null;
};

function normalizeDashboardPayload(raw: DashboardHistoryPayload): DashboardHistoryPayload {
  return {
    ...raw,
    boatClass: pickTrimmed(raw.boatClass, raw.boat_class),
    athleteId: pickTrimmed(raw.athleteId, raw.athlete_id),
  };
}

export async function loadDeviceHistoryRange(
  settings: CoachSettings,
  deviceId: string,
  fromIso: string,
  toIso: string,
): Promise<DashboardHistoryPayload> {
  if (isDemoMode()) return demoDeviceHistoryRange(deviceId, fromIso, toIso);
  const url =
    `${apiBase(settings)}/api/history?format=dashboard` +
    `&uniqueId=${encodeURIComponent(deviceId)}` +
    `&from=${encodeURIComponent(fromIso)}` +
    `&to=${encodeURIComponent(toIso)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`History ${deviceId} ${res.status}`);
  const data = (await res.json()) as DashboardHistoryPayload;
  return normalizeDashboardPayload(data);
}

export async function loadSessionTrack(
  settings: CoachSettings,
  sessionId: string,
): Promise<HistoryPoint[]> {
  const payload = await loadSessionDashboard(settings, sessionId);
  return payload.track ?? [];
}

export async function loadSessionDashboard(
  settings: CoachSettings,
  sessionId: string,
): Promise<DashboardHistoryPayload> {
  if (isDemoMode()) return demoSessionDashboard(sessionId);
  const url = `${apiBase(settings)}/api/history?format=dashboard&sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`History ${res.status}`);
  return normalizeDashboardPayload((await res.json()) as DashboardHistoryPayload);
}

export type LogbookSession = {
  sessionId: string;
  uniqueId: string;
  crew: string;
  athleteId?: string | null;
  rowerName?: string | null;
  source?: string | null;
  noGps?: boolean;
  startedAt: string;
  endedAt: string;
  capsize: boolean;
  distanceM: number;
  onWaterMs: number;
};

export type LogbookDay = {
  date: string;
  sessionCount: number;
  capsizeCount: number;
  distanceM: number;
  onWaterMs: number;
  sessions: LogbookSession[];
};

export type LogbookPayload = {
  ok?: boolean;
  timeZone?: string;
  days?: LogbookDay[];
  error?: string;
};

export async function fetchLogbook(
  settings: CoachSettings,
  days = 45,
  timeZone = 'Pacific/Auckland',
): Promise<LogbookPayload> {
  if (isDemoMode()) return demoLogbook();
  const q = new URLSearchParams({
    list: 'logbook',
    days: String(days),
    tz: timeZone,
  });
  const url = `${apiBase(settings)}/api/history?${q.toString()}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  const data = (await res.json().catch(() => ({}))) as LogbookPayload;
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Logbook 401 — set ingest token in Settings');
    }
    throw new Error(data.error || `Logbook ${res.status}`);
  }
  return data;
}

export type AdminOrg = {
  id: number;
  slug: string;
  name: string;
  createdAt?: string | null;
};

export type AdminOrgsPayload = {
  ok?: boolean;
  orgs?: AdminOrg[];
  org?: AdminOrg;
  token?: string;
  warning?: string;
  error?: string;
};

async function adminFetch(
  settings: CoachSettings,
  adminToken: string,
  init?: RequestInit,
): Promise<AdminOrgsPayload> {
  const url = `${apiBase(settings)}/api/admin-orgs`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...adminAuthHeaders(adminToken),
      ...(init?.headers || {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as AdminOrgsPayload;
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Admin 401 — check ADMIN_TOKEN password');
    }
    if (res.status === 503) {
      throw new Error(data.error || 'Admin API unavailable (ADMIN_TOKEN / database)');
    }
    throw new Error(data.error || `Admin ${res.status}`);
  }
  return data;
}

export async function fetchAdminOrgs(
  settings: CoachSettings,
  adminToken: string,
): Promise<AdminOrg[]> {
  const data = await adminFetch(settings, adminToken, { method: 'GET' });
  return data.orgs ?? [];
}

export async function createAdminOrg(
  settings: CoachSettings,
  adminToken: string,
  slug: string,
  name: string,
  token?: string,
): Promise<{ org: AdminOrg; token: string }> {
  const body: { slug: string; name: string; token?: string } = { slug, name };
  if (token) body.token = token;
  const data = await adminFetch(settings, adminToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!data.org || !data.token) throw new Error(data.error || 'Create failed');
  return { org: data.org, token: data.token };
}

export async function renameAdminOrg(
  settings: CoachSettings,
  adminToken: string,
  slug: string,
  name: string,
): Promise<AdminOrg> {
  const data = await adminFetch(settings, adminToken, {
    method: 'PATCH',
    body: JSON.stringify({ slug, name }),
  });
  if (!data.org) throw new Error(data.error || 'Rename failed');
  return data.org;
}

export async function rotateAdminOrgToken(
  settings: CoachSettings,
  adminToken: string,
  slug: string,
): Promise<{ org: AdminOrg; token: string }> {
  const data = await adminFetch(settings, adminToken, {
    method: 'POST',
    body: JSON.stringify({ action: 'rotate', slug }),
  });
  if (!data.org || !data.token) throw new Error(data.error || 'Rotate failed');
  return { org: data.org, token: data.token };
}

export async function setAdminOrgToken(
  settings: CoachSettings,
  adminToken: string,
  slug: string,
  token: string,
): Promise<{ org: AdminOrg; token: string }> {
  const data = await adminFetch(settings, adminToken, {
    method: 'POST',
    body: JSON.stringify({ action: 'set-token', slug, token }),
  });
  if (!data.org || !data.token) throw new Error(data.error || 'Set password failed');
  return { org: data.org, token: data.token };
}
