import { isDemoMode } from './demo-mode';

export const LS_API_BASE = 'coach_api_base';
export const LS_TOKEN = 'coach_ingest_token';
export const LS_COACH_ID = 'coach_device_coach_id';
export const LS_COACH_NAME = 'coach_device_coach_name';
export const LS_SHARE_LOCATION = 'coach_share_location';
export const LS_LOCATION_INTERVAL_MS = 'coach_location_interval_ms';
/** RNZ ADMIN_TOKEN — session only (not localStorage). */
export const SS_ADMIN_TOKEN = 'coach_admin_token';

/** Production fleet API (same deployment as rower ingest). */
export const DEFAULT_API_BASE_URL =
  'https://rowing-app-recorder-pwa.vercel.app';

/** Default GPS upload interval for this Manager / coach tablet. */
export const DEFAULT_LOCATION_INTERVAL_MS = 20_000;

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export type CoachSettings = {
  apiBaseUrl: string;
  ingestToken: string;
  /** Fleet-config coach id (Manager → Coaches & Boats). */
  coachId: string;
  /** Display name uploaded as this tablet’s live device. */
  coachName: string;
  /** Publish GPS so RowSafe / Manager maps show this tablet. */
  shareLocation: boolean;
  /** Milliseconds between location uploads. Default 20s. */
  locationIntervalMs: number;
};

/** In-memory only — never written to localStorage. */
const DEMO_SETTINGS: CoachSettings = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  ingestToken: 'demo',
  coachId: 'coach-2',
  coachName: 'Tom',
  shareLocation: true,
  locationIntervalMs: DEFAULT_LOCATION_INTERVAL_MS,
};

function readShareLocation(): boolean {
  try {
    return localStorage.getItem(LS_SHARE_LOCATION) !== '0';
  } catch {
    return true;
  }
}

function readLocationIntervalMs(): number {
  try {
    const n = Number(localStorage.getItem(LS_LOCATION_INTERVAL_MS));
    if (Number.isFinite(n) && n >= 5_000 && n <= 120_000) return Math.round(n);
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCATION_INTERVAL_MS;
}

export function clampLocationIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_LOCATION_INTERVAL_MS;
  return Math.min(120_000, Math.max(5_000, Math.round(ms)));
}

function defaultApiBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location?.origin && !IS_NATIVE) {
    try {
      const host = new URL(window.location.origin).hostname;
      if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host.endsWith('.vercel.app')
      ) {
        return window.location.origin;
      }
    } catch {
      /* ignore */
    }
  }
  return DEFAULT_API_BASE_URL;
}

export function loadSettings(): CoachSettings {
  if (isDemoMode()) {
    return {
      ...DEMO_SETTINGS,
      apiBaseUrl: defaultApiBaseUrl(),
    };
  }
  const stored = localStorage.getItem(LS_API_BASE)?.trim() ?? '';
  return {
    apiBaseUrl: stored || defaultApiBaseUrl(),
    ingestToken: localStorage.getItem(LS_TOKEN)?.trim() ?? '',
    coachId: localStorage.getItem(LS_COACH_ID)?.trim() ?? '',
    coachName: localStorage.getItem(LS_COACH_NAME)?.trim() ?? '',
    shareLocation: readShareLocation(),
    locationIntervalMs: readLocationIntervalMs(),
  };
}

export function saveSettings(s: CoachSettings): void {
  if (isDemoMode()) return;
  localStorage.setItem(LS_API_BASE, s.apiBaseUrl.trim());
  localStorage.setItem(LS_TOKEN, s.ingestToken.trim());
  localStorage.setItem(LS_COACH_ID, s.coachId.trim());
  localStorage.setItem(LS_COACH_NAME, s.coachName.trim());
  localStorage.setItem(LS_SHARE_LOCATION, s.shareLocation ? '1' : '0');
  localStorage.setItem(
    LS_LOCATION_INTERVAL_MS,
    String(clampLocationIntervalMs(s.locationIntervalMs)),
  );
}

export function apiUrl(path: string, settings: CoachSettings): string {
  const base = settings.apiBaseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function authHeaders(settings: CoachSettings): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (settings.ingestToken) {
    h.Authorization = `Bearer ${settings.ingestToken}`;
  }
  return h;
}

export function loadAdminToken(): string {
  try {
    return sessionStorage.getItem(SS_ADMIN_TOKEN)?.trim() ?? '';
  } catch {
    return '';
  }
}

export function saveAdminToken(token: string): void {
  try {
    const t = token.trim();
    if (t) sessionStorage.setItem(SS_ADMIN_TOKEN, t);
    else sessionStorage.removeItem(SS_ADMIN_TOKEN);
  } catch {
    /* ignore */
  }
}

export function clearAdminToken(): void {
  saveAdminToken('');
}

export function adminAuthHeaders(adminToken: string): HeadersInit {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (adminToken.trim()) {
    h.Authorization = `Bearer ${adminToken.trim()}`;
  }
  return h;
}
