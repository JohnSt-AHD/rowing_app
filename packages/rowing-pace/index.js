/**
 * Rowing pace (/500m) and prognostic (% of class 2 km world-best pace).
 * Prognostic = (reference 2 km time / projected 2 km time) × 100 at current speed.
 */

export const MIN_SPEED_MPS = 0.25;

/** 2000 m reference times (seconds) — open, U23 (B), lightweight (L). */
const WR_2K_SEC = {
  M1x: 383.6,
  W1x: 422.4,
  'M2-': 361.0,
  'W2-': 393.0,
  M2x: 353.0,
  W2x: 386.0,
  'M2+': 376.0,
  'W2+': 408.0,
  'M4-': 333.0,
  'W4-': 365.0,
  M4x: 330.0,
  W4x: 362.0,
  'M4+': 343.0,
  'W4+': 375.0,
  'M8+': 317.0,
  'W8+': 350.0,
  BM1x: 392.5,
  BW1x: 432.0,
  'BM2-': 371.0,
  'BW2-': 404.0,
  BM2x: 363.0,
  BW2x: 396.0,
  'BM2+': 387.0,
  'BW2+': 419.0,
  'BM4-': 343.0,
  'BW4-': 376.0,
  BM4x: 340.0,
  BW4x: 373.0,
  'BM4+': 353.0,
  'BW4+': 385.0,
  'BM8+': 327.0,
  'BW8+': 361.0,
  LM1x: 390.0,
  LW1x: 425.0,
  'LM2-': 370.0,
  'LW2-': 402.0,
  LM2x: 362.0,
  LW2x: 394.0,
  'LM2+': 385.0,
  'LW2+': 417.0,
  'LM4-': 340.0,
  'LW4-': 372.0,
  LM4x: 337.0,
  LW4x: 369.0,
  'LM4+': 350.0,
  'LW4+': 382.0,
  'LM8+': 324.0,
  'LW8+': 356.0,
};

const BOAT_CODE_RE =
  /(?:^|[^A-Z0-9])([BJL]?)([MW])([1248])([X+\-])(?=[^A-Z0-9]|$)/gi;

/**
 * @param {...(string|null|undefined)} parts Device ID, athlete ID, notes, etc.
 * @returns {string|null} Normalised code e.g. M2x, W8+, BM2-
 */
export function parseBoatClass(...parts) {
  for (const raw of parts) {
    if (raw == null || raw === '') continue;
    BOAT_CODE_RE.lastIndex = 0;
    const m = BOAT_CODE_RE.exec(String(raw));
    if (!m) continue;
    const prefix = (m[1] || '').toUpperCase();
    const gender = m[2].toUpperCase();
    const seats = m[3];
    let type = m[4];
    if (type === 'X' || type === 'x') type = 'x';
    else if (type === '+') type = '+';
    else type = '-';
    return `${prefix}${gender}${seats}${type}`;
  }
  return null;
}

/** @param {string|null|undefined} boatClass */
export function reference2kSec(boatClass) {
  if (!boatClass) return null;
  return WR_2K_SEC[boatClass] ?? null;
}

/** @param {number|undefined|null} speedMps */
export function formatSplit500m(speedMps) {
  if (speedMps == null || !Number.isFinite(speedMps) || speedMps < MIN_SPEED_MPS) {
    return '—';
  }
  const sec = 500 / speedMps;
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

/** @param {number|undefined|null} speedMps */
export function splitSecFromMps(speedMps) {
  if (speedMps == null || !Number.isFinite(speedMps) || speedMps < MIN_SPEED_MPS) {
    return undefined;
  }
  return 500 / speedMps;
}

/**
 * @param {number} speedMps
 * @param {string|null} boatClass
 * @returns {number|null}
 */
export function prognosticPercent(speedMps, boatClass) {
  const refSec = reference2kSec(boatClass);
  if (refSec == null || speedMps == null || !Number.isFinite(speedMps) || speedMps < MIN_SPEED_MPS) {
    return null;
  }
  const projected2kSec = 2000 / speedMps;
  return (refSec / projected2kSec) * 100;
}

/**
 * @param {number} speedMps
 * @param {string|null} boatClass
 * @returns {string|null}
 */
export function formatPrognostic(speedMps, boatClass) {
  const pct = prognosticPercent(speedMps, boatClass);
  if (pct == null) return null;
  return `${pct.toFixed(1)}%`;
}

/**
 * @param {number|undefined|null} speedMps
 * @param {...(string|null|undefined|{ suffix?: boolean })} rest
 */
export function formatPaceWithPrognostic(speedMps, ...rest) {
  /** @type {{ suffix?: boolean }} */
  let options = { suffix: false };
  /** @type {(string|null|undefined)[]} */
  const labelParts = [];
  for (const item of rest) {
    if (item != null && typeof item === 'object') {
      options = { ...options, ...item };
    } else {
      labelParts.push(item);
    }
  }

  const split = formatSplit500m(speedMps);
  if (split === '—') return '—';
  const base = options.suffix ? `${split}/500` : split;
  const boat = parseBoatClass(...labelParts);
  if (!boat) return base;
  const prog = formatPrognostic(speedMps, boat);
  return prog ? `${base} · ${prog}` : base;
}
