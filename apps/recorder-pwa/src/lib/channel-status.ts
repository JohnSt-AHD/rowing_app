/**
 * Traffic / flow-pattern status from lane geofences + GPS course.
 *
 * Status id → athlete HUD colour (see `.session-channel-badge` in styles.css):
 * - correct → green (right lane + heading)
 * - nogo → amber (in no-go channel)
 * - wrong → red (wrong lane for heading)
 * - turnaround → amber (caution / turn zone)
 * - unknown, no_lanes → neutral grey
 */

import {
  type GeofenceConfig,
  normalizeGeofenceKind,
  pointInZoneGeometry,
} from './geofence';

export type ChannelStatusId =
  | 'correct'
  | 'wrong'
  | 'nogo'
  | 'turnaround'
  | 'unknown'
  | 'no_lanes';

export type ChannelStatus = {
  id: ChannelStatusId;
  label: string;
  sub: string;
  /** Expected lane when heading is known. */
  expected: 'up' | 'down' | null;
  /** Lane the boat is currently in. */
  actual: 'up' | 'down' | 'nogo' | 'turnaround' | 'other' | null;
};

const EARTH_R = 6371000;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

function toDeg(r: number): number {
  return (r * 180) / Math.PI;
}

/** Initial bearing from A → B (degrees 0–360). */
export function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function laneGeofences(list: GeofenceConfig[]) {
  const up: GeofenceConfig[] = [];
  const down: GeofenceConfig[] = [];
  const nogo: GeofenceConfig[] = [];
  const turn: GeofenceConfig[] = [];
  for (const g of list) {
    if (!g || g.enabled === false) continue;
    const kind = normalizeGeofenceKind(g.kind);
    const name = String(g.name || '').toLowerCase();
    if (kind === 'lane_up' || name.includes('up lane')) up.push(g);
    else if (kind === 'lane_down' || name.includes('down lane')) down.push(g);
    else if (
      kind === 'lane_nogo' ||
      (kind === 'hazard' && (name.includes('no-go') || name.includes('nogo') || name.includes('channel no')))
    ) {
      nogo.push(g);
    } else if (
      kind === 'turnaround' ||
      name.includes('weather buoy') ||
      name.includes('turnaround')
    ) {
      turn.push(g);
    }
  }
  return { up, down, nogo, turn };
}

function inAny(lat: number, lon: number, zones: GeofenceConfig[]): boolean {
  return zones.some((g) => pointInZoneGeometry(g, lat, lon));
}

/**
 * Infer "up" lake bearing from up-lane polygon centroid vs down-lane, or fallback.
 */
export function inferUpBearingDeg(list: GeofenceConfig[], fallback = 133): number {
  const { up, down } = laneGeofences(list);
  if (up[0] && down[0]) {
    // Up lane is "right when going up" — axis ≈ perpendicular to line between lane centroids is weak.
    // Prefer turnaround → southernmost up-lane point as up direction when available.
    const t = list.find((g) => normalizeGeofenceKind(g.kind) === 'turnaround');
    if (t && up[0].polygonCoords?.length) {
      let best = up[0].polygonCoords[0];
      for (const p of up[0].polygonCoords) {
        if (p[0] < best[0]) best = p; // southernmost lat
      }
      return bearingDeg(t.centerLat, t.centerLon, best[0], best[1]);
    }
  }
  return fallback;
}

/**
 * Evaluate whether the boat is in the correct flow pattern for its heading.
 * @param courseDeg GPS course over ground, or null if unknown
 */
export function evaluateChannelStatus(
  lat: number,
  lon: number,
  courseDeg: number | null | undefined,
  geofences: GeofenceConfig[],
  upBearingDeg?: number,
): ChannelStatus {
  const lanes = laneGeofences(geofences);
  if (
    lanes.up.length + lanes.down.length + lanes.nogo.length + lanes.turn.length ===
    0
  ) {
    return {
      id: 'no_lanes',
      label: 'No flow pattern data',
      sub: '',
      expected: null,
      actual: null,
    };
  }

  const inTurn = inAny(lat, lon, lanes.turn);
  const inNogo = inAny(lat, lon, lanes.nogo);
  const inUp = inAny(lat, lon, lanes.up);
  const inDown = inAny(lat, lon, lanes.down);

  let actual: ChannelStatus['actual'] = 'other';
  if (inTurn) actual = 'turnaround';
  else if (inNogo) actual = 'nogo';
  else if (inUp) actual = 'up';
  else if (inDown) actual = 'down';

  if (actual === 'turnaround') {
    return {
      id: 'turnaround',
      label: 'Turnaround',
      sub: 'Weather buoy',
      expected: null,
      actual,
    };
  }
  if (actual === 'nogo') {
    return {
      id: 'nogo',
      label: 'No-go channel',
      sub: 'Move to your lane',
      expected: null,
      actual,
    };
  }

  const upBrg = upBearingDeg ?? inferUpBearingDeg(geofences);
  const downBrg = (upBrg + 180) % 360;
  let expected: 'up' | 'down' | null = null;
  if (courseDeg != null && Number.isFinite(courseDeg)) {
    expected =
      angleDiffDeg(courseDeg, upBrg) <= angleDiffDeg(courseDeg, downBrg)
        ? 'up'
        : 'down';
  }

  if (!expected) {
    if (actual === 'up' || actual === 'down') {
      return {
        id: 'unknown',
        label: actual === 'up' ? 'Up lane' : 'Down lane',
        sub: 'Need course for check',
        expected: null,
        actual,
      };
    }
    return {
      id: 'unknown',
      label: 'Off flow pattern',
      sub: 'Outside marked lanes',
      expected: null,
      actual,
    };
  }

  if (actual === expected) {
    return {
      id: 'correct',
      label: 'Correct flow pattern',
      sub: expected === 'up' ? 'Up lane' : 'Down lane',
      expected,
      actual,
    };
  }
  if (actual === 'up' || actual === 'down') {
    return {
      id: 'wrong',
      label: 'Wrong flow pattern',
      sub:
        expected === 'up'
          ? 'Heading up — use up lane'
          : 'Heading down — use down lane',
      expected,
      actual,
    };
  }
  return {
    id: 'unknown',
    label: 'Off flow pattern',
    sub:
      expected === 'up'
        ? 'Should be in up lane'
        : 'Should be in down lane',
    expected,
    actual,
  };
}

export function courseFromTrack(
  prev: { lat: number; lon: number } | null,
  next: { lat: number; lon: number },
  minMoveM = 4,
): number | null {
  if (!prev) return null;
  const dLat = toRad(next.lat - prev.lat);
  const dLon = toRad(next.lon - prev.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(prev.lat)) *
      Math.cos(toRad(next.lat)) *
      Math.sin(dLon / 2) ** 2;
  const dist = 2 * EARTH_R * Math.asin(Math.sqrt(a));
  if (dist < minMoveM) return null;
  return bearingDeg(prev.lat, prev.lon, next.lat, next.lon);
}
