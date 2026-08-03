/**
 * Reject GPS teleports / impossible jumps before map display and device registry updates.
 */

/** Max implied speed between fixes for rowing shells (m/s). */
const GPS_OUTLIER_MAX_ROWING_MPS = 7.5;
/** Absolute jump (m) within GPS_OUTLIER_MAX_DT_SEC. */
const GPS_OUTLIER_MAX_JUMP_M = 40;
/** Apply jump/speed rules when fixes are this close in time (seconds). */
const GPS_OUTLIER_MAX_DT_SEC = 8;
/** Accuracy above this (m) makes moderate jumps easier to reject. */
const GPS_OUTLIER_BAD_ACC_M = 30;

/** Native re-upload paths — keep device online but do not move live map position. */
const GPS_CACHE_SAMPLE_SOURCES = new Set([
  'scheduled_cache',
  'heartbeat_cache',
  'stale_piggyback',
]);

/** @param {string|null|undefined} sampleSource */
function isGpsFixForMapPosition(sampleSource) {
  if (sampleSource == null || sampleSource === '') return true;
  return !GPS_CACHE_SAMPLE_SOURCES.has(String(sampleSource).trim());
}

function metersPerDegLat() {
  return 111320;
}

function metersPerDegLon(lat) {
  return Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180));
}

function distanceMeters(aLat, aLon, bLat, bLon) {
  const dLatM = (aLat - bLat) * metersPerDegLat();
  const dLonM = (aLon - bLon) * metersPerDegLon((aLat + bLat) / 2);
  return Math.hypot(dLatM, dLonM);
}

/**
 * @param {{ t: number, lat: number, lon: number, acc?: number|null }} prev
 * @param {{ t: number, lat: number, lon: number, acc?: number|null }} fix
 * @param {{ maxMps?: number, maxJumpM?: number, maxDtSec?: number, badAccM?: number }} [opts]
 */
function isGpsFixOutlier(prev, fix, opts = {}) {
  if (!prev || !fix) return false;
  if (
    !Number.isFinite(prev.lat) ||
    !Number.isFinite(prev.lon) ||
    !Number.isFinite(fix.lat) ||
    !Number.isFinite(fix.lon) ||
    !Number.isFinite(prev.t) ||
    !Number.isFinite(fix.t)
  ) {
    return false;
  }

  const maxMps = opts.maxMps ?? GPS_OUTLIER_MAX_ROWING_MPS;
  const maxJumpM = opts.maxJumpM ?? GPS_OUTLIER_MAX_JUMP_M;
  const maxDtSec = opts.maxDtSec ?? GPS_OUTLIER_MAX_DT_SEC;
  const badAccM = opts.badAccM ?? GPS_OUTLIER_BAD_ACC_M;

  const dtSec = (fix.t - prev.t) / 1000;
  if (!Number.isFinite(dtSec) || dtSec <= 0) return false;
  if (dtSec > 120) return false;

  const jumpM = distanceMeters(prev.lat, prev.lon, fix.lat, fix.lon);
  if (jumpM < 0.5) return false;

  const badAcc =
    (fix.acc != null && Number.isFinite(fix.acc) && fix.acc > badAccM) ||
    (prev.acc != null && Number.isFinite(prev.acc) && prev.acc > badAccM);

  if (dtSec <= maxDtSec) {
    if (jumpM >= maxJumpM) return true;
    if (jumpM / dtSec > maxMps) return true;
    if (badAcc && jumpM >= 15 && jumpM / dtSec > maxMps * 0.65) return true;
    return false;
  }

  if (dtSec <= 30) {
    if (jumpM >= maxJumpM * 2) return true;
    if (jumpM / dtSec > maxMps * 1.4) return true;
  }

  return false;
}

/** @param {{ t: number, lat: number, lon: number, acc?: number|null }[]} fixes */
function filterOutlierGpsFixes(fixes) {
  if (!fixes?.length) return [];
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  /** @type {typeof fixes} */
  const out = [];
  for (const fix of sorted) {
    const prev = out[out.length - 1];
    if (prev && isGpsFixOutlier(prev, fix)) continue;
    out.push(fix);
  }
  return out;
}

module.exports = {
  GPS_OUTLIER_MAX_ROWING_MPS,
  GPS_OUTLIER_MAX_JUMP_M,
  GPS_OUTLIER_MAX_DT_SEC,
  GPS_OUTLIER_BAD_ACC_M,
  GPS_CACHE_SAMPLE_SOURCES,
  distanceMeters,
  isGpsFixOutlier,
  isGpsFixForMapPosition,
  filterOutlierGpsFixes,
};
