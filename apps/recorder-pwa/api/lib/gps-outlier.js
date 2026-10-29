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
/** Car-test implied speed (m/s). Matches ingest-store MAX_CAR_TRACK_SPEED_MPS (~137 km/h). */
const GPS_OUTLIER_MAX_CAR_MPS = 38;
/** Car-test jump (m) within GPS_OUTLIER_MAX_DT_SEC (38 m/s × 8 s). */
const GPS_OUTLIER_MAX_CAR_JUMP_M = 304;

/** Native re-upload paths — keep device online but do not move live map position. */
const GPS_CACHE_SAMPLE_SOURCES = new Set([
  'scheduled_cache',
  'heartbeat_cache',
  'stale_piggyback',
  'last_known',
]);
/** Prefer the other clock when this far from server receive time. */
const SAMPLE_CLOCK_SKEW_MS = 20_000;
const SAMPLE_CLOCK_FUTURE_SLACK_MS = 5_000;
/** Sitting / last-known lock — same threshold as native RAW_GPS_MOVING_SPEED_MS. */
const LAST_KNOWN_MAX_SPEED_MPS = 0.75;
/**
 * Sitting-lock hysteresis leftover. Live pin no longer waits on this — last_known
 * draws like Manager (Maps-style last fix). Kept for tests / native comments.
 */
const LAST_KNOWN_MAP_MOVE_M = 8;
/** Same order as native LIVE_FIX_MAX_AGE_MS / fused-stall fallback. */
const FUSED_GPS_CLOCK_STALE_MS = 8_000;

/**
 * Live GPS sources always move the pin.
 * last_known is map-eligible even when coords did not move 8 m (Manager way:
 * draw the last GPS/network/last_known; badge age from fixMs). Other cache
 * sources (scheduled/heartbeat clones) still do not move the pin.
 *
 * @param {string|null|undefined} sampleSource
 * @param {{ prev?: { lat?: number, lon?: number }|null, next?: { lat?: number, lon?: number }|null }} [opts]
 */
function isGpsFixForMapPosition(sampleSource, _opts = {}) {
  if (sampleSource == null || sampleSource === '') return true;
  const src = String(sampleSource).trim();
  if (!GPS_CACHE_SAMPLE_SOURCES.has(src)) return true;
  return src === 'last_known';
}

/**
 * Live pin: keep GPS+network (manager_watch) when fused/window_avg is still
 * ticking with an old GPS clock (fixMs). 1.0.62 Karapiro drive: window_avg
 * every ~6s with 40–100s-old fixMs moved the pin; Manager stayed on GPS.
 *
 * @param {{ sampleSource?: string|null, fixMs?: number|null, t?: number }|null|undefined} prev
 * @param {{ sampleSource?: string|null, fixMs?: number|null, t?: number }|null|undefined} next
 * @param {number} [now]
 */
function shouldKeepManagerWatchLivePin(prev, next, now = Date.now()) {
  if (!prev || !next) return false;
  const prevSrc = prev.sampleSource != null ? String(prev.sampleSource).trim() : '';
  const nextSrc = next.sampleSource != null ? String(next.sampleSource).trim() : '';
  if (prevSrc !== 'manager_watch') return false;
  if (nextSrc === 'manager_watch' || nextSrc === 'last_known') return false;
  const prevFix = Number(prev.fixMs != null ? prev.fixMs : prev.t);
  const nextFix = Number(next.fixMs != null ? next.fixMs : next.t);
  if (!Number.isFinite(prevFix) || !Number.isFinite(nextFix)) return false;
  return Number(now) - nextFix > FUSED_GPS_CLOCK_STALE_MS && nextFix < prevFix;
}

function lastKnownMovedFromMapPin(prev, next) {
  if (!prev || !next) return false;
  const plat = Number(prev.lat);
  const plon = Number(prev.lon);
  const nlat = Number(next.lat);
  const nlon = Number(next.lon);
  if (
    !Number.isFinite(plat) ||
    !Number.isFinite(plon) ||
    !Number.isFinite(nlat) ||
    !Number.isFinite(nlon)
  ) {
    return false;
  }
  return distanceMeters(plat, plon, nlat, nlon) >= LAST_KNOWN_MAP_MOVE_M;
}

function isUsableSampleClockMs(value, nowMs) {
  const t = Number(value);
  return Number.isFinite(t) && t > 0 && t <= nowMs + SAMPLE_CLOCK_FUTURE_SLACK_MS;
}

/**
 * Pick sample t vs GPS fixMs — whichever is closer to `now`.
 * Does not snap to now (safe for history / in-memory reads).
 *
 * @param {number|null|undefined} sampleT
 * @param {number|null|undefined} gpsFixMs
 * @param {number} [now]
 */
function pickCloserClockMs(sampleT, gpsFixMs, now = Date.now()) {
  const nowMs = Number(now);
  const receiveMs = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const tOk = isUsableSampleClockMs(sampleT, receiveMs);
  const fixOk = isUsableSampleClockMs(gpsFixMs, receiveMs);
  if (tOk && fixOk) {
    return Math.abs(Number(gpsFixMs) - receiveMs) < Math.abs(Number(sampleT) - receiveMs)
      ? Number(gpsFixMs)
      : Number(sampleT);
  }
  if (tOk) return Number(sampleT);
  if (fixOk) return Number(gpsFixMs);
  if (Number.isFinite(Number(sampleT)) && Number(sampleT) > 0) return Number(sampleT);
  if (Number.isFinite(Number(gpsFixMs)) && Number(gpsFixMs) > 0) return Number(gpsFixMs);
  return null;
}

/**
 * Sitting last-known: speed ~0 (or tagged). Missing speed + a stale clock is
 * also treated as last-known so we do not restamp an office lock to "now".
 *
 * @param {{ spd?: number|null, lastKnown?: boolean, sampleSource?: string|null }} [opts]
 */
function isSittingLastKnownFix(opts = {}) {
  if (opts?.lastKnown === true) return true;
  const src = opts?.sampleSource != null ? String(opts.sampleSource).trim() : '';
  if (src === 'last_known' || GPS_CACHE_SAMPLE_SOURCES.has(src)) return true;
  const speed = Number(opts?.spd);
  if (Number.isFinite(speed)) return speed <= LAST_KNOWN_MAX_SPEED_MPS;
  return true;
}

/**
 * Ingest-time clock: closer of sample t vs GPS fixMs, or server receive time
 * when a *moving* live fix is 20s+ behind (so the map pin can still move).
 * Do not restamp a non-moving last-known — Manager would stay "GPS live".
 *
 * @param {number|null|undefined} sampleT
 * @param {number|null|undefined} gpsFixMs
 * @param {number} [now]
 * @param {string|null|undefined} [sampleSource]
 * @param {{ spd?: number|null, lastKnown?: boolean }} [opts]
 */
function pickEffectiveSampleTimeMs(sampleT, gpsFixMs, now = Date.now(), sampleSource, opts = {}) {
  const nowMs = Number(now);
  const receiveMs = Number.isFinite(nowMs) && nowMs > 0 ? nowMs : Date.now();
  const src = sampleSource != null ? String(sampleSource).trim() : '';
  // last_known / cache clones keep satellite fixMs even when the client sent t=now.
  // Do not restamp sitting last-known to ingest time (1.0.57 5-min-live bug).
  if (
    (src === 'last_known' || GPS_CACHE_SAMPLE_SOURCES.has(src) || opts?.lastKnown === true) &&
    isUsableSampleClockMs(gpsFixMs, receiveMs)
  ) {
    return Number(gpsFixMs);
  }
  const chosen = pickCloserClockMs(sampleT, gpsFixMs, receiveMs);
  if (chosen == null) return receiveMs;
  if (isGpsFixForMapPosition(sampleSource) && receiveMs - chosen > SAMPLE_CLOCK_SKEW_MS) {
    if (isSittingLastKnownFix({ ...opts, sampleSource })) return chosen;
    return receiveMs;
  }
  return chosen;
}

/** @param {{ t?: number, gps?: { fixMs?: number, sampleSource?: string, spd?: number } }} sample */
function reconcileSampleTime(sample, now = Date.now()) {
  if (!sample || typeof sample !== 'object') return sample;
  const next = pickEffectiveSampleTimeMs(
    sample.t,
    sample.gps?.fixMs,
    now,
    sample.gps?.sampleSource,
    { spd: sample.gps?.spd, lastKnown: sample.gps?.lastKnown },
  );
  if (Number.isFinite(next) && next !== Number(sample.t)) {
    sample.t = next;
  }
  return sample;
}

/** @param {object[]} samples */
function reconcileSampleTimes(samples, now = Date.now()) {
  if (!Array.isArray(samples)) return samples;
  for (const sample of samples) reconcileSampleTime(sample, now);
  return samples;
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
 * @param {string | undefined | null} mode
 * @returns {'rowing' | 'car'}
 */
function parseGpsOutlierMode(mode) {
  const m = String(mode || '')
    .trim()
    .toLowerCase();
  return m === 'car' ? 'car' : 'rowing';
}

/**
 * @param {string | undefined | null} mode
 * @returns {{ maxMps: number, maxJumpM: number }}
 */
function gpsOutlierLimitsForMode(mode) {
  if (parseGpsOutlierMode(mode) === 'car') {
    return {
      maxMps: GPS_OUTLIER_MAX_CAR_MPS,
      maxJumpM: GPS_OUTLIER_MAX_CAR_JUMP_M,
    };
  }
  return {
    maxMps: GPS_OUTLIER_MAX_ROWING_MPS,
    maxJumpM: GPS_OUTLIER_MAX_JUMP_M,
  };
}

/**
 * @param {{ t: number, lat: number, lon: number, acc?: number|null }} prev
 * @param {{ t: number, lat: number, lon: number, acc?: number|null }} fix
 * @param {{ mode?: 'rowing' | 'car', maxMps?: number, maxJumpM?: number, maxDtSec?: number, badAccM?: number }} [opts]
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

  const modeLimits = gpsOutlierLimitsForMode(opts.mode);
  const maxMps = opts.maxMps ?? modeLimits.maxMps;
  const maxJumpM = opts.maxJumpM ?? modeLimits.maxJumpM;
  const maxDtSec = opts.maxDtSec ?? GPS_OUTLIER_MAX_DT_SEC;
  const badAccM = opts.badAccM ?? GPS_OUTLIER_BAD_ACC_M;

  const dtSec = (fix.t - prev.t) / 1000;
  if (!Number.isFinite(dtSec) || dtSec <= 0) return false;

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

  // A 30s+ hole must not bypass the speed cap. Highway / batched dumps
  // (e.g. 4.6 km in 30s) used to return false here and leap the pin.
  // Always reject implied speed above maxMps × dt (rowing 7.5, car 38).
  if (jumpM / dtSec > maxMps) return true;
  return false;
}

/**
 * @param {{ t: number, lat: number, lon: number, acc?: number|null }[]} fixes
 * @param {{ mode?: 'rowing' | 'car', maxMps?: number, maxJumpM?: number, maxDtSec?: number, badAccM?: number }} [opts]
 */
function filterOutlierGpsFixes(fixes, opts = {}) {
  if (!fixes?.length) return [];
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  /** @type {typeof fixes} */
  const out = [];
  for (const fix of sorted) {
    const prev = out[out.length - 1];
    if (prev && isGpsFixOutlier(prev, fix, opts)) continue;
    out.push(fix);
  }
  return out;
}

module.exports = {
  GPS_OUTLIER_MAX_ROWING_MPS,
  GPS_OUTLIER_MAX_JUMP_M,
  GPS_OUTLIER_MAX_CAR_MPS,
  GPS_OUTLIER_MAX_CAR_JUMP_M,
  GPS_OUTLIER_MAX_DT_SEC,
  GPS_OUTLIER_BAD_ACC_M,
  GPS_CACHE_SAMPLE_SOURCES,
  SAMPLE_CLOCK_SKEW_MS,
  LAST_KNOWN_MAX_SPEED_MPS,
  LAST_KNOWN_MAP_MOVE_M,
  FUSED_GPS_CLOCK_STALE_MS,
  parseGpsOutlierMode,
  gpsOutlierLimitsForMode,
  distanceMeters,
  isGpsFixOutlier,
  isGpsFixForMapPosition,
  isSittingLastKnownFix,
  shouldKeepManagerWatchLivePin,
  pickCloserClockMs,
  pickEffectiveSampleTimeMs,
  reconcileSampleTime,
  reconcileSampleTimes,
  filterOutlierGpsFixes,
};
