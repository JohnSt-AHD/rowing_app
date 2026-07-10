/**
 * Geofence geometry helpers (circle + polygon zones).
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in metres. */
function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function pointInCircle(lat, lon, centerLat, centerLon, radiusM) {
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

/** Ray casting; ring is [[lat, lon], ...] with at least 3 points. */
function pointInPolygon(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (!Array.isArray(pi) || !Array.isArray(pj) || pi.length < 2 || pj.length < 2) {
      return false;
    }
    const yi = Number(pi[0]);
    const xi = Number(pi[1]);
    const yj = Number(pj[0]);
    const xj = Number(pj[1]);
    if (!Number.isFinite(yi) || !Number.isFinite(xi) || !Number.isFinite(yj) || !Number.isFinite(xj)) {
      return false;
    }
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function parsePolygonCoords(raw) {
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
  const ring = [];
  for (const pt of value) {
    if (Array.isArray(pt) && pt.length >= 2) {
      const lat = Number(pt[0]);
      const lon = Number(pt[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    } else if (pt && typeof pt === 'object') {
      const lat = Number(pt.lat ?? pt.latitude);
      const lon = Number(pt.lon ?? pt.longitude ?? pt.lng);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    }
  }
  return ring.length >= 3 ? ring : [];
}

function normalizePolygonInput(raw) {
  return parsePolygonCoords(raw);
}

function polygonCentroid(ring) {
  let latSum = 0;
  let lonSum = 0;
  for (const [lat, lon] of ring) {
    latSum += lat;
    lonSum += lon;
  }
  return { lat: latSum / ring.length, lon: lonSum / ring.length };
}

function polygonBoundingRadiusM(ring) {
  const c = polygonCentroid(ring);
  let maxR = 1;
  for (const [lat, lon] of ring) {
    maxR = Math.max(maxR, distanceM(c.lat, c.lon, lat, lon));
  }
  return maxR;
}

function pointInGeofence(g, lat, lon) {
  if (!g || g.enabled === false || g.kind !== 'boat_park') return false;
  if (g.shapeType === 'polygon') {
    return pointInPolygon(lat, lon, g.polygonCoords);
  }
  return pointInCircle(lat, lon, g.centerLat, g.centerLon, g.radiusM);
}

/** @param {Array<object>} geofences */
function findBoatParkAt(lat, lon, geofences) {
  if (!Array.isArray(geofences)) return null;
  for (const g of geofences) {
    if (pointInGeofence(g, lat, lon)) return g;
  }
  return null;
}

function economyIntervalSecFromInput(input) {
  const unified = Number(input?.economyIntervalSec ?? input?.economy_interval_sec);
  if (Number.isFinite(unified) && unified >= 1) return Math.max(1, unified);
  const gps = Number(input?.economyGpsIntervalSec ?? input?.economy_gps_interval_sec);
  const upload = Number(input?.economyUploadIntervalSec ?? input?.economy_upload_interval_sec);
  if (Number.isFinite(gps) && gps >= 1 && Number.isFinite(upload) && upload >= 1) {
    return Math.max(1, Math.max(gps, upload));
  }
  if (Number.isFinite(gps) && gps >= 1) return Math.max(1, gps);
  if (Number.isFinite(upload) && upload >= 1) return Math.max(1, upload);
  return 30;
}

function normalizeGeofence(row) {
  const shapeType =
    String(row.shape_type ?? row.shapeType ?? 'circle').toLowerCase() === 'polygon'
      ? 'polygon'
      : 'circle';
  const polygonCoords =
    shapeType === 'polygon' ? parsePolygonCoords(row.polygon_coords ?? row.polygonCoords) : [];
  const economyIntervalSec = economyIntervalSecFromInput(row);
  const sessionDwellSec = sessionDwellSecFromInput(row);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind || 'boat_park',
    shapeType,
    centerLat: Number(row.center_lat ?? row.centerLat),
    centerLon: Number(row.center_lon ?? row.centerLon),
    radiusM: Number(row.radius_m ?? row.radiusM),
    polygonCoords,
    enabled: row.enabled !== false,
    economyIntervalSec,
    economyGpsIntervalSec: economyIntervalSec,
    economyUploadIntervalSec: economyIntervalSec,
    disableCapsize: row.disable_capsize !== false && row.disableCapsize !== false,
    /** Drop GPS/telemetry while inside (server + phone). */
    suppressRecording:
      row.suppress_recording === true || row.suppressRecording === true,
    /** End session after dwell inside zone. */
    autoStopOnEnter: row.auto_stop_on_enter === true || row.autoStopOnEnter === true,
    /** Start session after dwell outside zone (armed standby). */
    autoStartOnExit: row.auto_start_on_exit === true || row.autoStartOnExit === true,
    sessionDwellSec,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

function sessionDwellSecFromInput(input) {
  const v = Number(input?.sessionDwellSec ?? input?.session_dwell_sec);
  if (Number.isFinite(v) && v >= 5) return Math.min(600, Math.max(5, Math.round(v)));
  return 45;
}

function boolFromInput(input, camel, snake, defaultTrue = false) {
  if (input == null) return defaultTrue;
  if (Object.prototype.hasOwnProperty.call(input, camel)) {
    return input[camel] === true;
  }
  if (Object.prototype.hasOwnProperty.call(input, snake)) {
    return input[snake] === true;
  }
  return defaultTrue;
}

/** Find a boat-park zone that suppresses recording at this point. */
function findSuppressRecordingAt(lat, lon, geofences) {
  if (!Array.isArray(geofences)) return null;
  for (const g of geofences) {
    if (!pointInGeofence(g, lat, lon)) continue;
    if (g.suppressRecording !== true) continue;
    return g;
  }
  return null;
}

module.exports = {
  distanceM,
  pointInCircle,
  pointInPolygon,
  parsePolygonCoords,
  normalizePolygonInput,
  polygonCentroid,
  polygonBoundingRadiusM,
  pointInGeofence,
  findBoatParkAt,
  findSuppressRecordingAt,
  normalizeGeofence,
  economyIntervalSecFromInput,
  sessionDwellSecFromInput,
  boolFromInput,
};
