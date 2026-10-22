/**
 * RNZ lake / hazard / lane zones for Manager `?demo=1` only.
 * Live-fetches production with a throwaway Bearer header — never written to settings.
 */

import L from 'leaflet';
import snapshot from './demo-rnz-geofences.json';

const PROD_GEOFENCES_URL =
  'https://rowing-app-recorder-pwa.vercel.app/api/geofences';
/** In-memory fetch header only. Never persisted. */
const DEMO_RNZ_TOKEN = 'rnz';

const LAKE_MASK_OUTER: Array<[number, number]> = [
  [-85, -180],
  [-85, 180],
  [85, 180],
  [85, -180],
];

export type DemoGeofence = {
  id: number;
  name: string;
  kind: string;
  shapeType: string;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  polygonCoords: Array<[number, number]>;
  enabled: boolean;
};

let memory: DemoGeofence[] | null = null;
let inflight: Promise<DemoGeofence[]> | null = null;

function inferKind(name: string, kind: string): string {
  const n = name.toLowerCase();
  if (n.includes('up lane')) return 'lane_up';
  if (n.includes('down lane')) return 'lane_down';
  if (n.includes('no-go') || n.includes('nogo') || n.includes('safety zone')) {
    return 'lane_nogo';
  }
  if (n.includes('turnaround')) return 'turnaround';
  return kind;
}

function normalizeList(raw: unknown[]): DemoGeofence[] {
  return raw.map((item) => {
    const g = item as Record<string, unknown>;
    const name = String(g.name ?? '');
    const coords = Array.isArray(g.polygonCoords)
      ? (g.polygonCoords as Array<[number, number]>)
      : [];
    return {
      id: Number(g.id),
      name,
      kind: inferKind(name, String(g.kind ?? 'boat_park')),
      shapeType: String(g.shapeType ?? 'circle'),
      centerLat: Number(g.centerLat),
      centerLon: Number(g.centerLon),
      radiusM: Number(g.radiusM) || 0,
      polygonCoords: coords,
      enabled: g.enabled !== false,
    };
  });
}

export function demoGeofencesSnapshot(): DemoGeofence[] {
  const list = (snapshot as { geofences?: unknown[] }).geofences ?? [];
  return normalizeList(list);
}

async function fetchLiveRnzGeofences(): Promise<DemoGeofence[] | null> {
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

export async function loadDemoGeofences(): Promise<DemoGeofence[]> {
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

/** Same overlay styling as the recorder session map. */
export function drawDemoGeofencesOnMap(map: L.Map, list: DemoGeofence[]): L.LayerGroup {
  const layer = L.layerGroup().addTo(map);
  for (const g of list) {
    if (!g.enabled) continue;
    const kind = g.kind;
    if (kind === 'lake') {
      const hole =
        g.shapeType === 'polygon' && g.polygonCoords.length >= 3
          ? g.polygonCoords
          : [];
      if (hole.length < 3) continue;
      L.polygon([LAKE_MASK_OUTER, hole], {
        color: '#475569',
        fillColor: '#1e293b',
        fillOpacity: 0.45,
        stroke: false,
        interactive: false,
      }).addTo(layer);
      L.polygon(hole, {
        color: '#94a3b8',
        fill: false,
        weight: 2,
        dashArray: '4 3',
      })
        .bindTooltip(g.name || 'Lake boundary')
        .addTo(layer);
      continue;
    }
    const color =
      kind === 'lane_up'
        ? '#22d3ee'
        : kind === 'lane_down'
          ? '#a78bfa'
          : kind === 'lane_nogo'
            ? '#f97316'
            : kind === 'turnaround'
              ? '#fbbf24'
              : kind === 'hazard'
                ? '#f87171'
                : '#f59e0b';
    const fillOpacity = kind === 'hazard' ? 0.35 : 0.28;
    if (g.shapeType === 'circle' && g.radiusM > 0) {
      L.circle([g.centerLat, g.centerLon], {
        radius: g.radiusM,
        color,
        fillColor: color,
        fillOpacity,
        weight: 2,
      })
        .bindTooltip(g.name || 'Geofence')
        .addTo(layer);
    } else if (g.shapeType === 'polygon' && g.polygonCoords.length >= 3) {
      L.polygon(g.polygonCoords, {
        color,
        fillColor: color,
        fillOpacity,
        weight: 2,
      })
        .bindTooltip(g.name || 'Geofence')
        .addTo(layer);
    }
  }
  const course = list.find(
    (g) => g.name.toLowerCase() === 'course' && g.polygonCoords.length >= 3,
  );
  const lake = list.find((g) => g.kind === 'lake' && g.polygonCoords.length >= 3);
  const focus = course ?? lake;
  if (focus) {
    map.fitBounds(L.latLngBounds(focus.polygonCoords), {
      padding: [24, 24],
      maxZoom: 15,
      animate: false,
    });
  }
  return layer;
}
