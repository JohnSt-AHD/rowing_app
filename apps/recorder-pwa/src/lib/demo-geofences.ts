/**
 * RNZ lake / hazard / lane zones for `?demo=1` only.
 * Live-fetches production with a throwaway Bearer header — never written to settings.
 */

import snapshot from './demo-rnz-geofences.json';
import {
  normalizeGeofence,
  type GeofenceConfig,
  type GeofenceKind,
} from './geofence';

const PROD_GEOFENCES_URL =
  'https://rowing-app-recorder-pwa.vercel.app/api/geofences';
/** In-memory fetch header only. Never persisted. */
const DEMO_RNZ_TOKEN = 'rnz';

let memory: GeofenceConfig[] | null = null;
let inflight: Promise<GeofenceConfig[]> | null = null;

function inferKind(name: string, kind: GeofenceKind | string): GeofenceKind | string {
  const n = name.toLowerCase();
  if (n.includes('up lane')) return 'lane_up';
  if (n.includes('down lane')) return 'lane_down';
  if (n.includes('no-go') || n.includes('nogo') || n.includes('safety zone')) {
    return 'lane_nogo';
  }
  if (n.includes('turnaround')) return 'turnaround';
  return kind;
}

function normalizeList(raw: unknown[]): GeofenceConfig[] {
  return raw
    .map((g) => normalizeGeofence(g as Record<string, unknown>))
    .map((g) => ({ ...g, kind: inferKind(g.name, g.kind) }));
}

export function demoGeofencesSnapshot(): GeofenceConfig[] {
  const list = (snapshot as { geofences?: unknown[] }).geofences ?? [];
  return normalizeList(list);
}

async function fetchLiveRnzGeofences(): Promise<GeofenceConfig[] | null> {
  try {
    const res = await fetch(PROD_GEOFENCES_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${DEMO_RNZ_TOKEN}`,
      },
    });
    const data = (await res.json()) as { ok?: boolean; geofences?: unknown[] };
    if (!res.ok || !data.ok || !Array.isArray(data.geofences) || !data.geofences.length) {
      return null;
    }
    return normalizeList(data.geofences);
  } catch {
    return null;
  }
}

export async function loadDemoGeofences(): Promise<GeofenceConfig[]> {
  if (memory?.length) return memory;
  if (inflight) return inflight;
  inflight = (async () => {
    const live = await fetchLiveRnzGeofences();
    memory = live?.length ? live : demoGeofencesSnapshot();
    return memory;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
