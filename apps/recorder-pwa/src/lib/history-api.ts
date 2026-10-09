import type { RecorderSettings } from '@rowing/telemetry-types';
import { normalizeIngestUrl } from '../upload/telemetry-api';

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

export type SessionsListResult = {
  sessions: SessionSummary[];
  persisted: boolean;
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

function normalizeDashboardPayload(raw: DashboardHistoryPayload): DashboardHistoryPayload {
  return {
    ...raw,
    boatClass: pickTrimmed(raw.boatClass, raw.boat_class),
    athleteId: pickTrimmed(raw.athleteId, raw.athlete_id),
  };
}

/** API origin from ingest URL (`…/api/ingest` → origin). */
export function apiBaseFromSettings(settings: RecorderSettings): string {
  const ingest = normalizeIngestUrl(String(settings.ingestUrl ?? '').trim());
  if (!ingest) return '';
  try {
    const u = new URL(ingest, typeof window !== 'undefined' ? window.location.origin : undefined);
    if (u.pathname.endsWith('/api/ingest')) {
      u.pathname = u.pathname.slice(0, -'/api/ingest'.length) || '/';
    } else if (u.pathname.endsWith('/ingest')) {
      u.pathname = u.pathname.replace(/\/ingest\/?$/, '') || '/';
    }
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch {
    return '';
  }
}

export function authHeaders(settings: RecorderSettings): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  const token = String(settings.ingestToken ?? '').trim();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function historyErrorMessage(status: number, body?: { error?: string }): string {
  if (status === 401) return 'History 401 — set Password (ingest token) in Settings';
  if (status === 503) {
    return body?.error || 'No database — session history needs Postgres on the server';
  }
  return body?.error || `History ${status}`;
}

export async function listSessions(
  settings: RecorderSettings,
  deviceId: string,
): Promise<SessionsListResult> {
  const base = apiBaseFromSettings(settings);
  if (!base) throw new Error('Set URL in Settings before loading history');
  const url = `${base}/api/history?list=sessions&uniqueId=${encodeURIComponent(deviceId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  const data = (await res.json().catch(() => ({}))) as {
    sessions?: SessionSummary[];
    persisted?: boolean;
    error?: string;
  };
  if (!res.ok) throw new Error(historyErrorMessage(res.status, data));
  return {
    sessions: (data.sessions ?? []).map(normalizeSessionSummary),
    persisted: data.persisted !== false,
  };
}

export async function loadSessionDashboard(
  settings: RecorderSettings,
  sessionId: string,
): Promise<DashboardHistoryPayload> {
  const base = apiBaseFromSettings(settings);
  if (!base) throw new Error('Set URL in Settings before loading history');
  const url = `${base}/api/history?format=dashboard&sessionId=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { headers: authHeaders(settings) });
  const data = (await res.json().catch(() => ({}))) as DashboardHistoryPayload & {
    error?: string;
    ok?: boolean;
  };
  if (!res.ok) throw new Error(historyErrorMessage(res.status, data));
  return normalizeDashboardPayload(data);
}
