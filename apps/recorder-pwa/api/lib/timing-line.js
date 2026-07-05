/**
 * Timing line geometry — course lines, splits, crossing detection.
 */
const { distanceM } = require('./geofence');

const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function destinationLatLon(lat, lon, bearingDeg, distM) {
  if (!Number.isFinite(distM) || distM <= 0) return [lat, lon];
  const δ = distM / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return [toDeg(φ2), toDeg(λ2)];
}

function validateEndpoints(lat1, lon1, lat2, lon2) {
  const a = Number(lat1);
  const b = Number(lon1);
  const c = Number(lat2);
  const d = Number(lon2);
  if (![a, b, c, d].every(Number.isFinite)) {
    throw new Error('Line endpoints must be valid numbers');
  }
  if (distanceM(a, b, c, d) < 5) {
    throw new Error('Timing line must span at least 5 metres');
  }
  return { lat1: a, lon1: b, lat2: c, lon2: d };
}

function normalizeLineType(raw) {
  const t = String(raw ?? 'split').toLowerCase();
  if (t === 'start' || t === 'finish' || t === 'split') return t;
  return 'split';
}

function normalizeTimingLine(row) {
  return {
    id: row.id,
    name: row.name,
    lineType: normalizeLineType(row.line_type ?? row.lineType),
    lat1: Number(row.lat1),
    lon1: Number(row.lon1),
    lat2: Number(row.lat2),
    lon2: Number(row.lon2),
    distanceM:
      row.distance_m != null || row.distanceM != null
        ? Number(row.distance_m ?? row.distanceM)
        : null,
    sortOrder: Number(row.sort_order ?? row.sortOrder ?? 0),
    courseGroup: row.course_group ?? row.courseGroup ?? null,
    courseBearingDeg:
      row.course_bearing_deg != null || row.courseBearingDeg != null
        ? Number(row.course_bearing_deg ?? row.courseBearingDeg)
        : null,
    enabled: row.enabled !== false,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

/** Bearing from point 1 → point 2 (degrees, 0 = north). */
function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Perpendicular to line (two options). Default: clockwise +90° from line bearing. */
function courseBearingFromLine(lat1, lon1, lat2, lon2, direction = 'right') {
  const lineBrg = bearingDeg(lat1, lon1, lat2, lon2);
  return direction === 'left' ? (lineBrg + 270) % 360 : (lineBrg + 90) % 360;
}

function lineMidpoint(lat1, lon1, lat2, lon2) {
  return { lat: (lat1 + lat2) / 2, lon: (lon1 + lon2) / 2 };
}

/** Parallel line offset along course bearing by distanceM. */
function parallelLineAtDistance(lat1, lon1, lat2, lon2, courseBearingDeg, offsetM) {
  const [a1, b1] = destinationLatLon(lat1, lon1, courseBearingDeg, offsetM);
  const [a2, b2] = destinationLatLon(lat2, lon2, courseBearingDeg, offsetM);
  return { lat1: a1, lon1: b1, lat2: a2, lon2: b2 };
}

/**
 * Generate split line specs from a start line + course bearing.
 * @returns {Array<{ name: string, lineType: string, distanceM: number, lat1, lon1, lat2, lon2, sortOrder }>}
 */
function generateSplitLines({
  startLat1,
  startLon1,
  startLat2,
  startLon2,
  courseBearingDeg,
  splitIntervalM,
  totalDistanceM,
  courseGroup,
}) {
  const interval = Number(splitIntervalM);
  const total = Number(totalDistanceM);
  if (!Number.isFinite(interval) || interval < 50) {
    throw new Error('splitIntervalM must be at least 50 metres');
  }
  if (!Number.isFinite(total) || total < interval) {
    throw new Error('totalDistanceM must be at least one split interval');
  }
  const brg = Number(courseBearingDeg);
  if (!Number.isFinite(brg)) throw new Error('courseBearingDeg is required');

  const lines = [];
  lines.push({
    name: 'Start',
    lineType: 'start',
    distanceM: 0,
    lat1: startLat1,
    lon1: startLon1,
    lat2: startLat2,
    lon2: startLon2,
    sortOrder: 0,
    courseGroup,
    courseBearingDeg: brg,
  });

  let order = 1;
  for (let d = interval; d < total; d += interval) {
    const pts = parallelLineAtDistance(startLat1, startLon1, startLat2, startLon2, brg, d);
    lines.push({
      name: `${Math.round(d)} m`,
      lineType: 'split',
      distanceM: d,
      ...pts,
      sortOrder: order++,
      courseGroup,
      courseBearingDeg: brg,
    });
  }

  const finishPts = parallelLineAtDistance(
    startLat1,
    startLon1,
    startLat2,
    startLon2,
    brg,
    total,
  );
  lines.push({
    name: 'Finish',
    lineType: 'finish',
    distanceM: total,
    ...finishPts,
    sortOrder: order,
    courseGroup,
    courseBearingDeg: brg,
  });
  return lines;
}

function ccw(a, b, c) {
  return (c.lat - a.lat) * (b.lon - a.lon) > (b.lat - a.lat) * (c.lon - a.lon);
}

/** True if track segment ab crosses line segment cd. */
function segmentsCross(a, b, c, d) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

module.exports = {
  destinationLatLon,
  validateEndpoints,
  normalizeLineType,
  normalizeTimingLine,
  bearingDeg,
  courseBearingFromLine,
  lineMidpoint,
  parallelLineAtDistance,
  generateSplitLines,
  segmentsCross,
  distanceM,
};
