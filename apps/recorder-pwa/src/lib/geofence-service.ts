import { normalizeGeofence, type GeofenceConfig } from './geofence';

const CACHE_MS = 5 * 60 * 1000;

let cached: GeofenceConfig[] = [];
let cachedAt = 0;

function geofencesUrl(ingestUrl: string): string {
  const base = ingestUrl.replace(/\/api\/ingest\/?$/i, '');
  return `${base}/api/geofences`;
}

export async function fetchGeofences(
  ingestUrl: string,
  ingestToken?: string,
  force = false,
  timeoutMs = 10000,
): Promise<GeofenceConfig[]> {
  const now = Date.now();
  if (!force && cached.length && now - cachedAt < CACHE_MS) return cached;

  const url = geofencesUrl(ingestUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ingestToken?.trim()) headers.Authorization = `Bearer ${ingestToken.trim()}`;

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    ctrl && timeoutMs > 0
      ? setTimeout(() => ctrl.abort(), timeoutMs)
      : null;

  try {
    const res = await fetch(url, {
      headers,
      signal: ctrl?.signal,
    });
    const data = (await res.json()) as { ok?: boolean; geofences?: unknown[]; error?: string };
    if (res.status === 401) {
      throw new Error('Unauthorized — set ingest token in Settings (must match Vercel).');
    }
    if (!res.ok || !data.ok || !Array.isArray(data.geofences)) {
      throw new Error(data.error || `Geofences ${res.status}`);
    }
    cached = data.geofences.map((g) =>
      normalizeGeofence(g as Record<string, unknown>),
    );
    cachedAt = Date.now();
    return cached;
  } catch (e) {
    if (cached.length) return cached;
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function clearGeofenceCache(): void {
  cached = [];
  cachedAt = 0;
}
