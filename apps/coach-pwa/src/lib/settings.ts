export const LS_API_BASE = 'coach_api_base';
export const LS_TOKEN = 'coach_ingest_token';

/** Production fleet API (same deployment as rower ingest). */
export const DEFAULT_API_BASE_URL =
  'https://rowing-app-recorder-pwa.vercel.app';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export type CoachSettings = {
  apiBaseUrl: string;
  ingestToken: string;
};

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
  const stored = localStorage.getItem(LS_API_BASE)?.trim() ?? '';
  return {
    apiBaseUrl: stored || defaultApiBaseUrl(),
    ingestToken: localStorage.getItem(LS_TOKEN)?.trim() ?? '',
  };
}

export function saveSettings(s: CoachSettings): void {
  localStorage.setItem(LS_API_BASE, s.apiBaseUrl.trim());
  localStorage.setItem(LS_TOKEN, s.ingestToken.trim());
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
