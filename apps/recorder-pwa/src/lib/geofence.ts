/** Geofence types and geometry (mirrors api/lib/geofence.js). */

export type GeofenceKind = 'boat_park';
export type GeofenceShapeType = 'circle' | 'polygon';

export type GeofenceConfig = {
  id: number;
  name: string;
  kind: GeofenceKind | string;
  shapeType: GeofenceShapeType;
  centerLat: number;
  centerLon: number;
  radiusM: number;
  polygonCoords: Array<[number, number]>;
  enabled: boolean;
  /** GPS + upload interval (s) while inside this zone (when not suppressing). */
  economyIntervalSec: number;
  disableCapsize: boolean;
  /** Do not queue/upload telemetry while inside. */
  suppressRecording: boolean;
  /** Auto-stop session after dwell inside. */
  autoStopOnEnter: boolean;
  /** Auto-start session after dwell outside (armed standby). */
  autoStartOnExit: boolean;
  /** Seconds of continuous inside/outside before auto start/stop. */
  sessionDwellSec: number;
  /** Show phone notification on zone entry (background). */
  notifyOnEnter?: boolean;
  /** Custom notification body; default uses zone name. */
  entryNotifyMessage?: string;
};

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function distanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function pointInCircle(
  lat: number,
  lon: number,
  centerLat: number,
  centerLon: number,
  radiusM: number,
): boolean {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(centerLat) ||
    !Number.isFinite(centerLon) ||
    !Number.isFinite(radiusM) ||
    radiusM <= 0
  ) {
    return false;
  }
  return distanceM(lat, lon, centerLat, centerLon) <= radiusM;
}

export function pointInPolygon(lat: number, lon: number, ring: Array<[number, number]>): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function parsePolygonCoords(raw: unknown): Array<[number, number]> {
  if (!raw) return [];
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const ring: Array<[number, number]> = [];
  for (const pt of value) {
    if (Array.isArray(pt) && pt.length >= 2) {
      const lat = Number(pt[0]);
      const lon = Number(pt[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    } else if (pt && typeof pt === 'object') {
      const obj = pt as Record<string, unknown>;
      const lat = Number(obj.lat ?? obj.latitude);
      const lon = Number(obj.lon ?? obj.longitude ?? obj.lng);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    }
  }
  return ring.length >= 3 ? ring : [];
}

export function pointInZoneGeometry(g: GeofenceConfig, lat: number, lon: number): boolean {
  if (!g.enabled) return false;
  if (g.shapeType === 'polygon') {
    return pointInPolygon(lat, lon, g.polygonCoords);
  }
  return pointInCircle(lat, lon, g.centerLat, g.centerLon, g.radiusM);
}

export function pointInGeofence(g: GeofenceConfig, lat: number, lon: number): boolean {
  if (!g.enabled || g.kind !== 'boat_park') return false;
  return pointInZoneGeometry(g, lat, lon);
}

export function findNotifyZoneAt(
  lat: number,
  lon: number,
  geofences: GeofenceConfig[],
): GeofenceConfig | null {
  for (const g of geofences) {
    if (!g.notifyOnEnter) continue;
    if (pointInZoneGeometry(g, lat, lon)) return g;
  }
  return null;
}

export function entryNotifyMessageFor(g: GeofenceConfig): string {
  const custom = g.entryNotifyMessage?.trim();
  if (custom) return custom;
  const name = g.name.trim() || 'zone';
  return `Please check course, ${name} ahead`;
}

export function findBoatParkAt(
  lat: number,
  lon: number,
  geofences: GeofenceConfig[],
): GeofenceConfig | null {
  for (const g of geofences) {
    if (pointInGeofence(g, lat, lon)) return g;
  }
  return null;
}

function boolFlag(raw: Record<string, unknown>, camel: string, snake: string): boolean {
  if (Object.prototype.hasOwnProperty.call(raw, camel)) return raw[camel] === true;
  if (Object.prototype.hasOwnProperty.call(raw, snake)) return raw[snake] === true;
  return false;
}

function sessionDwellFromRaw(raw: Record<string, unknown>): number {
  const v = Number(raw.sessionDwellSec ?? raw.session_dwell_sec);
  if (Number.isFinite(v) && v >= 5) return Math.min(600, Math.max(5, Math.round(v)));
  return 45;
}

export function normalizeGeofence(raw: Record<string, unknown>): GeofenceConfig {
  const shapeType =
    String(raw.shapeType ?? raw.shape_type ?? 'circle').toLowerCase() === 'polygon'
      ? 'polygon'
      : 'circle';
  const polygonCoords =
    shapeType === 'polygon'
      ? parsePolygonCoords(raw.polygonCoords ?? raw.polygon_coords)
      : [];
  const economyIntervalSec = economyIntervalFromRaw(raw);
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ''),
    kind: String(raw.kind ?? 'boat_park'),
    shapeType,
    centerLat: Number(raw.centerLat ?? raw.center_lat),
    centerLon: Number(raw.centerLon ?? raw.center_lon),
    radiusM: Number(raw.radiusM ?? raw.radius_m),
    polygonCoords,
    enabled: raw.enabled !== false,
    economyIntervalSec,
    disableCapsize: raw.disableCapsize !== false && raw.disable_capsize !== false,
    suppressRecording: boolFlag(raw, 'suppressRecording', 'suppress_recording'),
    autoStopOnEnter: boolFlag(raw, 'autoStopOnEnter', 'auto_stop_on_enter'),
    autoStartOnExit: boolFlag(raw, 'autoStartOnExit', 'auto_start_on_exit'),
    sessionDwellSec: sessionDwellFromRaw(raw),
    notifyOnEnter: boolFlag(raw, 'notifyOnEnter', 'notify_on_enter'),
    entryNotifyMessage: String(raw.entryNotifyMessage ?? raw.entry_notify_message ?? ''),
  };
}

function economyIntervalFromRaw(raw: Record<string, unknown>): number {
  const unified = Number(raw.economyIntervalSec ?? raw.economy_interval_sec);
  if (Number.isFinite(unified) && unified >= 1) return Math.max(1, unified);
  const gps = Number(raw.economyGpsIntervalSec ?? raw.economy_gps_interval_sec);
  const upload = Number(raw.economyUploadIntervalSec ?? raw.economy_upload_interval_sec);
  if (Number.isFinite(gps) && gps >= 1 && Number.isFinite(upload) && upload >= 1) {
    return Math.max(1, Math.max(gps, upload));
  }
  if (Number.isFinite(gps) && gps >= 1) return Math.max(1, gps);
  if (Number.isFinite(upload) && upload >= 1) return Math.max(1, upload);
  return 30;
}
