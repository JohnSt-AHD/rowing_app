import { authHeaders, type CoachSettings } from './settings';

export type FleetDevice = {
  deviceId: string;
  athleteId?: string | null;
  online?: boolean;
  lastSeenAgoSec?: number;
  gps?: { ageSec?: number | null; present?: boolean; displayAgeSec?: number | null; ingestAgoSec?: number | null };
  /** Resolved GPS fix age (map + API). */
  gpsAgeSec?: number;
  rowing?: {
    strokeRate?: number | null;
    strokeRateValid?: boolean;
    capsize?: boolean;
  };
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
  capsize?: boolean;
  fixAgeSec?: number;
  fixMs?: number;
  lastSeenAgoSec?: number;
  online?: boolean;
};

function apiBase(settings: CoachSettings): string {
  return String(settings.apiBaseUrl ?? '').replace(/\/$/, '');
}

export async function fetchDevices(settings: CoachSettings): Promise<FleetDevice[]> {
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

export async function clearCapsizeAlert(settings: CoachSettings, deviceId?: string) {
  const url = `${apiBase(settings)}/api/capsize-clear`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify(deviceId ? { deviceId } : {}),
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
};

export type HistoryDevice = {
  uniqueId?: string;
  unique_id?: string;
  deviceId?: string;
  name?: string;
  sampleCount?: number;
};

export async function listHistoryDevices(settings: CoachSettings): Promise<HistoryDevice[]> {
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
  const url = `${apiBase(settings)}/api/history?list=sessions&uniqueId=${encodeURIComponent(deviceId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`Sessions ${res.status}`);
  const data = (await res.json()) as { sessions?: SessionSummary[] };
  return data.sessions ?? [];
}

export type HistoryPoint = {
  t: number;
  lat?: number;
  lon?: number;
  speed?: number;
  strokeRate?: number;
  capsize?: boolean;
};

export type DashboardHistoryPayload = {
  track?: HistoryPoint[];
  from?: string;
  to?: string;
  uniqueId?: string;
};

export async function loadDeviceHistoryRange(
  settings: CoachSettings,
  deviceId: string,
  fromIso: string,
  toIso: string,
): Promise<DashboardHistoryPayload> {
  const url =
    `${apiBase(settings)}/api/history?format=dashboard` +
    `&uniqueId=${encodeURIComponent(deviceId)}` +
    `&from=${encodeURIComponent(fromIso)}` +
    `&to=${encodeURIComponent(toIso)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`History ${deviceId} ${res.status}`);
  const data = (await res.json()) as DashboardHistoryPayload;
  return data;
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
  const url = `${apiBase(settings)}/api/history?format=dashboard&sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  if (!res.ok) throw new Error(`History ${res.status}`);
  return (await res.json()) as DashboardHistoryPayload;
}
