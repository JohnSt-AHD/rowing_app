const db = require('./db');

const CAPSIZE_ALERT_MAX_AGE_MS = db.CAPSIZE_ALERT_MAX_AGE_MS ?? 12 * 60 * 60 * 1000;
const CAPSIZE_GPS_BACKFILL_MAX_AGE_MS = 60 * 1000;
const { analyzeMotionWindow, MIN_SPM, MAX_SPM } = require('./motion-analysis');
const { resolveOrg: resolveOrgFromRequest } = require('./org-auth');
const { findSuppressRecordingAt } = require('./geofence');

/** Last known GPS per org:device — used to suppress motion/HR while parked. */
const lastGpsByDevice = globalThis.__rnzLastGpsByDevice ?? new Map();
globalThis.__rnzLastGpsByDevice = lastGpsByDevice;

function orgSessionKey(orgId, sessionId) {
  return `${orgId}:${sessionId}`;
}

function orgDeviceKey(orgId, deviceId) {
  return `${orgId}:${deviceId}`;
}

const MAX_SAMPLES_PER_REQUEST = 500;
const MAX_SESSIONS = 200;
const MAX_SAMPLES_PER_SESSION = 50000;
const RING_TRIM_TO = 3000;
const MAX_GPS_ACCURACY_M = 150;
const MAX_TRACK_SPEED_MPS = 25;
/** Max seconds to project track forward from last fix timestamp to now. */
const MAX_PREDICT_SEC = 2.5;
/** Keep smoothed marker within this distance of the latest raw fix. */
const MAX_SMOOTH_OFFSET_M = 10;
/** Min speed before predict-to-now (m/s). */
const MIN_PREDICT_SPEED_MPS = 0.25;
/** Cap speed used for map prediction (rowing shell). */
const MAX_ROWING_PREDICT_MPS = 12;
/** Cap speed used for map prediction (car test, 120 km/h). */
const MAX_CAR_PREDICT_KMH = 120;
const MAX_CAR_PREDICT_MPS = MAX_CAR_PREDICT_KMH / 3.6;
/** Max offset from raw when predicting at car speeds (~2.5 s at 120 km/h). */
const MAX_CAR_SMOOTH_OFFSET_M = Math.ceil(MAX_CAR_PREDICT_MPS * MAX_PREDICT_SEC);
/** Outlier jump threshold while warming track in car mode (m/s). */
const MAX_CAR_TRACK_SPEED_MPS = 38;
/** Only predict when GPS fix is fresher than this (seconds). */
const MAX_PREDICT_FIX_AGE_SEC = 30;
/** Rolling window for coach-facing pace (path distance / time). */
const PATH_PACE_WINDOW_MS = 15_000;
/** Ignore GPS segments shorter than this when computing path pace. */
const PATH_PACE_MIN_SEGMENT_M = 1;
/** Ignore GPS segment speeds above this when computing path pace (rowing). */
const PATH_PACE_MAX_SEGMENT_MPS = 6.5;
/** Keep segment speeds within this band of the window median (rejects GPS spikes). */
const PATH_PACE_SEGMENT_BAND_LO = 0.72;
const PATH_PACE_SEGMENT_BAND_HI = 1.28;
/** Max single-step change in displayed path pace vs previous EMA (ratio). */
const PATH_PACE_MAX_STEP_RATIO = 1.22;
/** Minimum moving time/distance before reporting path pace. */
const PATH_PACE_MIN_TIME_SEC = 4;
const PATH_PACE_MIN_DIST_M = 8;
/** Max fixes per device when loading path pace window (~1 Hz for 15s). */
const PATH_PACE_FIX_LIMIT = 20;
/** Keep showing last path pace when a fresh window cannot be computed. */
const PATH_PACE_HOLD_MS = 12_000;
/** EMA weight for new raw path pace (lower = smoother display). */
const PATH_PACE_EMA_ALPHA = 0.2;
/** Rolling median window for coach-facing stroke rate. */
const STROKE_MEDIAN_WINDOW_MS = 15_000;
/** Minimum stroke readings before reporting median SPM. */
const STROKE_MEDIAN_MIN_READINGS = 3;
/** Max stroke readings per device in median window (~1 Hz for 15s). */
const STROKE_MEDIAN_READING_LIMIT = 20;

/**
 * @param {string | undefined | null} mode
 * @returns {'rowing' | 'car'}
 */
function parsePredictMode(mode) {
  const m = String(mode || '')
    .trim()
    .toLowerCase();
  return m === 'car' ? 'car' : 'rowing';
}

/**
 * @param {'rowing' | 'car'} predictMode
 */
function predictLimitsForMode(predictMode) {
  if (predictMode === 'car') {
    return {
      maxSpeedMps: MAX_CAR_PREDICT_MPS,
      maxOffsetM: MAX_CAR_SMOOTH_OFFSET_M,
      maxTrackSpeedMps: MAX_CAR_TRACK_SPEED_MPS,
    };
  }
  return {
    maxSpeedMps: MAX_ROWING_PREDICT_MPS,
    maxOffsetM: MAX_SMOOTH_OFFSET_M,
    maxTrackSpeedMps: MAX_TRACK_SPEED_MPS,
  };
}

/** @type {Map<string, SessionRow>} */
const sessions = globalThis.__rnzIngestSessions ?? new Map();
globalThis.__rnzIngestSessions = sessions;

/** Monitor dismissed capsize per device (timestamp); ignores older capsize samples. */
/** @type {Map<string, number>} */
const capsizeClearAt = globalThis.__rnzCapsizeClearAt ?? new Map();
globalThis.__rnzCapsizeClearAt = capsizeClearAt;
/** Sticky monitor capsize alerts for non-DB / same-instance operation. */
/** @type {Map<string, { active: true, atMs: number }>} */
const stickyCapsizeByDevice = globalThis.__rnzStickyCapsizeByDevice ?? new Map();
globalThis.__rnzStickyCapsizeByDevice = stickyCapsizeByDevice;
/** @type {Map<string, GpsSmoothState>} */
const gpsTracks = globalThis.__rnzGpsTracks ?? new Map();
globalThis.__rnzGpsTracks = gpsTracks;
/** @type {Map<string, { t:number, result: object }>} */
const recentIdempotency = globalThis.__rnzRecentIdempotency ?? new Map();
/** @type {Map<string, { t: number }>} */
const lastHeartbeatByDevice = globalThis.__rnzLastHeartbeat ?? new Map();
globalThis.__rnzLastHeartbeat = lastHeartbeatByDevice;
/** @type {Map<string, { t: number, pct: number }>} */
const lastBatteryByDevice = globalThis.__rnzLastBattery ?? new Map();
globalThis.__rnzLastBattery = lastBatteryByDevice;
/** Smoothed coach-facing path pace per org:device (EMA + hold on gaps). */
/** @type {Map<string, { ema: number, raw: number, at: number }>} */
const pathPaceDisplayByDevice = globalThis.__rnzPathPaceDisplayByDevice ?? new Map();
globalThis.__rnzPathPaceDisplayByDevice = pathPaceDisplayByDevice;
globalThis.__rnzRecentIdempotency = recentIdempotency;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const metrics = globalThis.__rnzIngestMetrics ?? {
  startedAt: Date.now(),
  requests: 0,
  duplicates: 0,
  droppedSamples: 0,
  persistedBatches: 0,
  persistFailures: 0,
  lastPersistError: null,
  lastPersistAt: null,
  mapPolls: 0,
};
globalThis.__rnzIngestMetrics = metrics;

/**
 * @typedef {{
 *   t: number,
 *   lat: number,
 *   lon: number,
 *   smoothLat: number,
 *   smoothLon: number,
 *   speedMps: number | null,
 *   courseDeg: number | null,
 * }} GpsSmoothState
 */

function getCapsizeClearAt(deviceId) {
  if (!deviceId) return null;
  return capsizeClearAt.get(String(deviceId)) ?? null;
}

function setCapsizeClear(deviceId) {
  capsizeClearAt.set(String(deviceId), Date.now());
}

function raiseStickyCapsizeAlert(orgId, deviceId, eventMs) {
  const key = orgDeviceKey(orgId, deviceId);
  const prev = stickyCapsizeByDevice.get(key);
  const t = Number.isFinite(Number(eventMs)) ? Number(eventMs) : Date.now();
  const prevAt = prev?.active && Number.isFinite(prev.atMs) ? prev.atMs : null;
  // Bump atMs on each new capsize sample so RowSafe can re-alert after acknowledge.
  stickyCapsizeByDevice.set(key, {
    active: true,
    atMs: prevAt != null ? Math.max(prevAt, t) : t,
  });
}

function clearStickyCapsizeAlert(orgId, deviceId) {
  if (deviceId) {
    stickyCapsizeByDevice.delete(orgDeviceKey(orgId, deviceId));
    return;
  }
  const prefix = `${orgId}:`;
  for (const key of [...stickyCapsizeByDevice.keys()]) {
    if (key.startsWith(prefix)) stickyCapsizeByDevice.delete(key);
  }
}

function getStickyCapsizeAlerts(orgId) {
  const prefix = `${orgId}:`;
  const out = new Map();
  const now = Date.now();
  for (const [key, alert] of stickyCapsizeByDevice) {
    if (!key.startsWith(prefix) || !alert?.active) continue;
    if (alert.atMs != null && now - alert.atMs > CAPSIZE_ALERT_MAX_AGE_MS) {
      stickyCapsizeByDevice.delete(key);
      continue;
    }
    out.set(key.slice(prefix.length), alert);
  }
  return out;
}

function applyCapsizeAlertClears(orgId, clearedIds) {
  for (const id of clearedIds || []) {
    const uid = String(id);
    clearStickyCapsizeAlert(orgId, uid);
    setCapsizeClear(orgDeviceKey(orgId, uid));
  }
}

async function loadDbCapsizeAlerts(orgId) {
  const expired = await db.expireStaleCapsizeAlertsDb(orgId);
  applyCapsizeAlertClears(orgId, expired);
  return db.getCapsizeAlerts(orgId);
}

function nearestGpsFixForSample(sampleT, fixes, maxAgeMs) {
  let best = null;
  let bestDt = Infinity;
  for (const fix of fixes) {
    const dt = Math.abs(fix.t - sampleT);
    if (dt > maxAgeMs || dt >= bestDt) continue;
    best = fix;
    bestDt = dt;
  }
  return best;
}

/** Attach cached/batch GPS to motion-only capsize samples before persist (memory + DB). */
function backfillCapsizeGpsInMemory(scopedDevice, samples) {
  if (!samples.length) return;
  /** @type {Array<{ t: number, lat: number, lon: number, acc: number|null, spd: number|null, hdg: number|null }>} */
  const batchFixes = [];
  for (const s of samples) {
    const fix = gpsFromSample(s);
    if (fix) batchFixes.push(fix);
  }
  const cached = lastGpsByDevice.get(scopedDevice);
  const deviceFix =
    cached && cached.lat != null && cached.lon != null
      ? {
          t: cached.t,
          lat: cached.lat,
          lon: cached.lon,
          acc: cached.acc ?? null,
          spd: cached.spd ?? null,
          hdg: cached.hdg ?? null,
        }
      : null;

  for (const s of samples) {
    if (!sampleHasCapsize(s) || gpsFromSample(s)) continue;
    const t = Number(s.t);
    if (!Number.isFinite(t)) continue;
    const fromBatch = nearestGpsFixForSample(t, batchFixes, CAPSIZE_GPS_BACKFILL_MAX_AGE_MS);
    const fromDevice =
      deviceFix && Math.abs(deviceFix.t - t) <= CAPSIZE_GPS_BACKFILL_MAX_AGE_MS
        ? deviceFix
        : null;
    let fix = fromBatch || fromDevice;
    if (fromBatch && fromDevice) {
      fix =
        Math.abs(fromBatch.t - t) <= Math.abs(fromDevice.t - t) ? fromBatch : fromDevice;
    }
    if (!fix) continue;
    s.gps = {
      lat: fix.lat,
      lon: fix.lon,
      ...(fix.acc != null ? { acc: fix.acc } : {}),
      ...(fix.spd != null ? { spd: fix.spd } : {}),
      ...(fix.hdg != null ? { hdg: fix.hdg } : {}),
    };
  }
}

/**
 * @typedef {{ t: number, gps?: object, motion?: object, hr?: object, derived?: object }} Sample
 * @typedef {{
 *   orgId: number,
 *   deviceId: string,
 *   athleteId?: string,
 *   samples: Sample[],
 *   updatedAt: number,
 *   firstSeenAt: number,
 * }} SessionRow
 */

function trimSessions() {
  if (sessions.size <= MAX_SESSIONS) return;
  const sorted = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const remove = sorted.length - MAX_SESSIONS;
  for (let i = 0; i < remove; i++) sessions.delete(sorted[i][0]);
}

function trimSampleRing(row) {
  if (row.samples.length > MAX_SAMPLES_PER_SESSION) {
    row.samples = row.samples.slice(-MAX_SAMPLES_PER_SESSION);
  } else if (row.samples.length > RING_TRIM_TO) {
    row.samples = row.samples.slice(-RING_TRIM_TO);
  }
}

function pruneIdempotency(now = Date.now()) {
  for (const [key, entry] of recentIdempotency.entries()) {
    if (now - entry.t > IDEMPOTENCY_TTL_MS) recentIdempotency.delete(key);
  }
}

function isValidGpsCoords(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return true;
}

function gpsFromSample(sample, { forTrack = false } = {}) {
  if (!sample || typeof sample !== 'object' || !sample.gps) return null;
  const lat = Number(sample.gps.lat);
  const lon = Number(sample.gps.lon);
  if (!isValidGpsCoords(lat, lon)) return null;
  const acc =
    sample.gps.acc != null && Number.isFinite(Number(sample.gps.acc))
      ? Number(sample.gps.acc)
      : null;
  if (forTrack && acc != null && acc > MAX_GPS_ACCURACY_M) return null;
  const t = Number(sample.t);
  if (!Number.isFinite(t)) return null;
  const spd =
    sample.gps.spd != null && Number.isFinite(Number(sample.gps.spd))
      ? Math.max(0, Number(sample.gps.spd))
      : null;
  const hdg =
    sample.gps.hdg != null && Number.isFinite(Number(sample.gps.hdg))
      ? Number(sample.gps.hdg)
      : null;
  const compass =
    sample.gps.compass != null && Number.isFinite(Number(sample.gps.compass))
      ? Number(sample.gps.compass)
      : null;
  return { t, lat, lon, acc, spd, hdg, compass };
}

function sampleHasCapsize(sample) {
  const d = sample?.derived || {};
  return d.capsize === true || sample?.capsize === true;
}

/** Prefer compass bow heading; fall back to GPS course when moving. */
function resolveMapHeading(fix) {
  if (!fix) return null;
  if (fix.compass != null && Number.isFinite(fix.compass)) return fix.compass;
  const spd = fix.spd != null && Number.isFinite(fix.spd) ? fix.spd : 0;
  if (spd >= 1.2 && fix.hdg != null && Number.isFinite(fix.hdg)) return fix.hdg;
  return fix.hdg != null && Number.isFinite(fix.hdg) ? fix.hdg : null;
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

function emaAlphaForAccuracy(acc) {
  // Lower alpha = heavier smoothing (v1.0.34 uploads raw ~1 Hz fixes).
  if (acc != null && Number.isFinite(acc) && acc <= 3) return 0.48;
  if (acc != null && Number.isFinite(acc) && acc <= 8) return 0.38;
  return 0.28;
}

/** Cap fix age used for prediction when uploads are fresh but sample t lags (clock/batch). */
function effectiveFixAgeSec(fixAgeSec, lastSeenAgoSec, online) {
  if (fixAgeSec == null || !Number.isFinite(fixAgeSec)) return fixAgeSec;
  if (online === false || lastSeenAgoSec == null || lastSeenAgoSec > 15) {
    return fixAgeSec;
  }
  const pipelineLag = fixAgeSec - lastSeenAgoSec;
  if (pipelineLag > 10) {
    return Math.min(fixAgeSec, lastSeenAgoSec + 4);
  }
  return fixAgeSec;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed metres from point 1 → 2 along bearingDeg (positive = forward). */
function distanceAlongBearing(lat1, lon1, lat2, lon2, brg) {
  const dist = distanceMeters(lat1, lon1, lat2, lon2);
  if (dist < 0.01) return 0;
  const segBrg = bearingDeg(lat1, lon1, lat2, lon2);
  const toRad = (d) => (d * Math.PI) / 180;
  const delta = toRad(((segBrg - brg) + 540) % 360 - 180);
  return dist * Math.cos(delta);
}

/** Drop duplicate fixes from merged DB + memory batches. */
function dedupePathFixes(fixes) {
  if (!fixes?.length) return [];
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  /** @type {typeof fixes} */
  const out = [];
  for (const f of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      f.t - prev.t < 1500 &&
      distanceMeters(prev.lat, prev.lon, f.lat, f.lon) < 3
    ) {
      continue;
    }
    out.push(f);
  }
  return out;
}

/** Keep only the latest contiguous run in one direction (ignores lap turn / return mixing). */
function trimFixesToCurrentMotionRun(fixes) {
  if (fixes.length < 2) return fixes;
  const brg = dominantMotionBearingDeg(fixes);
  if (brg == null) return fixes;

  let runStart = 0;
  let prevSign = null;
  for (let i = fixes.length - 1; i > 0; i--) {
    const along = distanceAlongBearing(
      fixes[i - 1].lat,
      fixes[i - 1].lon,
      fixes[i].lat,
      fixes[i].lon,
      brg,
    );
    if (Math.abs(along) < 0.75) continue;
    const sign = along > 0 ? 1 : -1;
    if (prevSign == null) prevSign = sign;
    else if (sign !== prevSign) {
      runStart = i;
      break;
    }
  }
  const trimmed = fixes.slice(runStart);
  return trimmed.length >= 2 ? trimmed : fixes;
}

function dominantMotionBearingDeg(fixes) {
  if (fixes.length < 2) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const start = Math.max(1, fixes.length - 6);
  let sumX = 0;
  let sumY = 0;
  for (let i = start; i < fixes.length; i++) {
    const b = bearingDeg(
      fixes[i - 1].lat,
      fixes[i - 1].lon,
      fixes[i].lat,
      fixes[i].lon,
    );
    sumX += Math.cos(toRad(b));
    sumY += Math.sin(toRad(b));
  }
  if (sumX === 0 && sumY === 0) return null;
  return (toDeg(Math.atan2(sumY, sumX)) + 360) % 360;
}

function destinationLatLon(lat, lon, courseDeg, distanceM) {
  if (distanceM <= 0) return [lat, lon];
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const δ = distanceM / R;
  const θ = toRad(courseDeg);
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
  return [toDeg(φ2), ((toDeg(λ2) + 540) % 360) - 180];
}

function clampOffsetFromRaw(rawLat, rawLon, lat, lon, maxM) {
  const offsetM = distanceMeters(rawLat, rawLon, lat, lon);
  if (offsetM <= maxM || offsetM <= 0) return { lat, lon, offsetM };
  const scale = maxM / offsetM;
  return {
    lat: rawLat + (lat - rawLat) * scale,
    lon: rawLon + (lon - rawLon) * scale,
    offsetM: maxM,
  };
}

function resetGpsSmoothState(fix) {
  return {
    t: fix.t,
    lat: fix.lat,
    lon: fix.lon,
    smoothLat: fix.lat,
    smoothLon: fix.lon,
    speedMps: null,
    courseDeg: resolveMapHeading(fix),
  };
}

/**
 * Track last fix + velocity for bounded predict-to-now on the map overlay.
 * @param {string} deviceId
 * @param {{ t:number, lat:number, lon:number, acc:number|null, spd:number|null, hdg:number|null }} fix
 * @param {{ maxTrackSpeedMps?: number }} [opts]
 */
function updateGpsTrack(deviceId, fix, opts = {}) {
  const maxTrackSpeedMps = opts.maxTrackSpeedMps ?? MAX_TRACK_SPEED_MPS;
  const key = String(deviceId);
  const prev = gpsTracks.get(key);
  if (!prev) {
    gpsTracks.set(key, resetGpsSmoothState(fix));
    return true;
  }

  const dtSec = (fix.t - prev.t) / 1000;
  if (!Number.isFinite(dtSec) || dtSec < 0) return false;
  if (dtSec > 30) {
    gpsTracks.set(key, resetGpsSmoothState(fix));
    return true;
  }

  if (dtSec === 0) {
    gpsTracks.set(key, {
      ...prev,
      t: fix.t,
      lat: fix.lat,
      lon: fix.lon,
      smoothLat: fix.lat,
      smoothLon: fix.lon,
      speedMps: prev.speedMps,
      courseDeg: resolveMapHeading(fix) ?? prev.courseDeg,
    });
    return true;
  }

  const jumpM = distanceMeters(fix.lat, fix.lon, prev.lat, prev.lon);
  if (jumpM / dtSec > maxTrackSpeedMps) {
    gpsTracks.set(key, resetGpsSmoothState(fix));
    return true;
  }

  const speedMps = jumpM / dtSec;
  let courseDeg = bearingDeg(prev.lat, prev.lon, fix.lat, fix.lon);
  const resolved = resolveMapHeading(fix);
  if (resolved != null && Number.isFinite(resolved)) {
    courseDeg = resolved;
  } else if (fix.hdg != null && Number.isFinite(fix.hdg)) {
    courseDeg = fix.hdg;
  }
  if (prev.courseDeg != null && courseDeg != null && Number.isFinite(prev.courseDeg)) {
    const diff = ((courseDeg - prev.courseDeg + 540) % 360) - 180;
    courseDeg = (prev.courseDeg + 0.35 * diff + 360) % 360;
  }

  const alpha = emaAlphaForAccuracy(fix.acc);
  const smoothLat = alpha * fix.lat + (1 - alpha) * prev.smoothLat;
  const smoothLon = alpha * fix.lon + (1 - alpha) * prev.smoothLon;

  gpsTracks.set(key, {
    t: fix.t,
    lat: fix.lat,
    lon: fix.lon,
    smoothLat,
    smoothLon,
    speedMps,
    courseDeg,
  });
  return true;
}

/** Position-derived track speed; ignore phone gps.spd when track is available. */
function displayMapSpeedMps(_registrySpeed, trackSpeed) {
  const track =
    trackSpeed != null && Number.isFinite(trackSpeed) && trackSpeed >= 0.25
      ? trackSpeed
      : null;
  if (track != null) return track;
  const registry =
    _registrySpeed != null && Number.isFinite(_registrySpeed) && _registrySpeed >= 0.25
      ? _registrySpeed
      : null;
  return registry;
}

/**
 * Path speed from recent fixes: total distance / time (rejects GPS spikes).
 * @param {{ t:number, lat:number, lon:number }[]|null|undefined} fixes
 * @param {number} [windowMs]
 * @returns {number|null}
 */
function pathSpeedMpsFromFixes(fixes, windowMs = PATH_PACE_WINDOW_MS) {
  if (!fixes?.length) return null;
  const sorted = [...fixes].sort((a, b) => a.t - b.t);
  const endT = sorted[sorted.length - 1].t;
  const cutoff = endT - windowMs;
  const pts = trimFixesToCurrentMotionRun(
    sorted.filter(
      (f) => f.t >= cutoff && Number.isFinite(f.lat) && Number.isFinite(f.lon),
    ),
  );
  if (pts.length < 2) return null;

  /** @type {{ d: number, dt: number, seg: number }[]} */
  const segments = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0 || dt > 15) continue;
    const acc = pts[i].acc ?? pts[i - 1].acc;
    if (acc != null && Number.isFinite(acc) && acc > 25) continue;
    const d = distanceMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    if (d < PATH_PACE_MIN_SEGMENT_M) continue;
    const seg = d / dt;
    if (seg > PATH_PACE_MAX_SEGMENT_MPS) continue;
    segments.push({ d, dt, seg });
  }
  if (segments.length < 2) return null;

  const medianSeg = medianOf(segments.map((s) => s.seg));
  if (medianSeg == null || medianSeg < 0.25) return null;

  const lo = medianSeg * PATH_PACE_SEGMENT_BAND_LO;
  const hi = medianSeg * PATH_PACE_SEGMENT_BAND_HI;
  let distM = 0;
  let timeSec = 0;
  /** @type {number[]} */
  const inBandSegs = [];
  for (const s of segments) {
    if (s.seg < lo || s.seg > hi) continue;
    distM += s.d;
    timeSec += s.dt;
    inBandSegs.push(s.seg);
  }
  if (timeSec >= PATH_PACE_MIN_TIME_SEC && distM >= PATH_PACE_MIN_DIST_M) {
    return distM / timeSec;
  }
  if (inBandSegs.length >= 2) {
    return medianOf(inBandSegs);
  }
  return medianSeg;
}

/** Preserve fix spacing but anchor the latest fix to now (clock-lagged device timestamps). */
function rebaseFixTimestamps(fixes, anchorMs) {
  if (!fixes.length) return [];
  if (fixes.length === 1) return [{ ...fixes[0], t: anchorMs }];
  const rebased = [];
  let t = anchorMs;
  rebased.unshift({ ...fixes[fixes.length - 1], t });
  for (let i = fixes.length - 2; i >= 0; i--) {
    const dt = Math.max(500, Math.min(15000, fixes[i + 1].t - fixes[i].t));
    t -= dt;
    rebased.unshift({ ...fixes[i], t });
  }
  return rebased;
}

/** @param {Sample[]} samples @param {number} windowMs @param {number} [lastSeenMs] */
function gpsFixesFromSamples(samples, windowMs, lastSeenMs) {
  if (!samples?.length) return [];
  const now = Date.now();
  const cutoff = now - windowMs;
  /** @type {{ t:number, lat:number, lon:number, acc:number|null, spd:number|null }[]} */
  const fixes = [];
  for (const s of samples) {
    if (!s?.gps) continue;
    const lat = s.gps.lat;
    const lon = s.gps.lon;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = Number(s.t);
    if (!Number.isFinite(t)) continue;
    fixes.push({
      t,
      lat,
      lon,
      acc: s.gps.acc ?? null,
      spd: s.gps.spd ?? null,
    });
  }
  if (!fixes.length) return [];
  fixes.sort((a, b) => a.t - b.t);

  const recentTail = fixes.slice(-PATH_PACE_FIX_LIMIT);
  const inWindow = recentTail.filter((f) => f.t >= cutoff);
  if (inWindow.length >= 2) return inWindow;

  const activelyIngesting =
    lastSeenMs != null && Number.isFinite(lastSeenMs) && now - lastSeenMs <= 120000;
  const latest = recentTail[recentTail.length - 1];
  const fixClockLagSec = latest ? (now - latest.t) / 1000 : 0;
  if (activelyIngesting && fixClockLagSec > 20 && recentTail.length >= 2) {
    return rebaseFixTimestamps(recentTail, now);
  }
  return inWindow;
}

/**
 * @param {number} orgId
 * @param {number} windowMs
 * @param {Map<string, { samples?: Sample[] }>} telemetryByDevice
 */
async function loadPathPaceFixesByDevice(orgId, windowMs, telemetryByDevice) {
  /** @type {Map<string, { t:number, lat:number, lon:number, acc:number|null, spd:number|null }[]>} */
  const fixesByDevice = new Map();
  if (db.hasDb()) {
    try {
      const dbFixes = await db.getRecentGpsFixesByDevice(
        orgId,
        windowMs + 5000,
        PATH_PACE_FIX_LIMIT,
      );
      for (const [deviceId, fixes] of dbFixes) {
        if (fixes.length >= 2) {
          const latest = fixes[fixes.length - 1];
          const lagSec = (Date.now() - latest.t) / 1000;
          if (lagSec > 20) {
            fixesByDevice.set(deviceId, rebaseFixTimestamps(fixes, Date.now()));
            continue;
          }
        }
        fixesByDevice.set(deviceId, fixes);
      }
    } catch (err) {
      console.error('[ingest-store] loadPathPaceFixesByDevice DB failed:', err);
    }
  }
  if (telemetryByDevice?.size) {
    for (const [deviceId, entry] of telemetryByDevice) {
      const fromSamples = gpsFixesFromSamples(
        entry?.samples || [],
        windowMs + 5000,
        entry?.lastSeenMs,
      );
      if (!fromSamples.length) continue;
      const merged = dedupePathFixes(
        [...(fixesByDevice.get(deviceId) || []), ...fromSamples].sort(
          (a, b) => a.t - b.t,
        ),
      );
      fixesByDevice.set(deviceId, merged);
    }
  }
  return fixesByDevice;
}

/**
 * EMA-smoothed path pace for display; holds last good value through brief GPS gaps.
 * @param {number} orgId
 * @param {string} deviceId
 * @param {number|null|undefined} rawPath
 * @param {boolean} [live]
 */
function resolveDisplayPathSpeedMps(orgId, deviceId, rawPath, live = true) {
  const key = orgDeviceKey(orgId, deviceId);
  const prev = pathPaceDisplayByDevice.get(key);
  const now = Date.now();
  if (rawPath != null && Number.isFinite(rawPath) && rawPath >= 0.25) {
    let accepted = rawPath;
    if (prev?.ema != null && Number.isFinite(prev.ema) && prev.ema >= 0.25) {
      const ratio = rawPath / prev.ema;
      if (ratio > PATH_PACE_MAX_STEP_RATIO || ratio < 1 / PATH_PACE_MAX_STEP_RATIO) {
        accepted = prev.ema;
      }
    }
    const ema =
      prev?.ema != null && Number.isFinite(prev.ema)
        ? PATH_PACE_EMA_ALPHA * accepted + (1 - PATH_PACE_EMA_ALPHA) * prev.ema
        : accepted;
    pathPaceDisplayByDevice.set(key, { ema, raw: rawPath, at: now });
    return ema;
  }
  if (live && prev?.ema != null && now - prev.at <= PATH_PACE_HOLD_MS) {
    return prev.ema;
  }
  return null;
}

/** @param {object[]} positions @param {Map<string, { t:number, lat:number, lon:number }[]>} fixesByDevice @param {number} orgId */
function attachPathPaceToMapPositions(positions, fixesByDevice, orgId) {
  for (const p of positions) {
    const fixes = fixesByDevice.get(p.deviceId);
    const pathSpeed = pathSpeedMpsFromFixes(fixes);
    p.pathSpeedMps = pathSpeed;
    p.pathPaceWindowSec = PATH_PACE_WINDOW_MS / 1000;
    const live = p.online !== false && p.telemetryStale !== true;
    p.displaySpeedMps = resolveDisplayPathSpeedMps(orgId, p.deviceId, pathSpeed, live);
    const coachSpeed = p.displaySpeedMps ?? p.pathSpeedMps;
    if (coachSpeed != null && Number.isFinite(coachSpeed) && coachSpeed >= 0.25) {
      p.speed = coachSpeed;
    }
  }
  return positions;
}

/** @param {object[]} devices @param {Map<string, { t:number, lat:number, lon:number }[]>} fixesByDevice @param {number} orgId */
function attachPathPaceToDevices(devices, fixesByDevice, orgId) {
  for (const dev of devices) {
    const fixes = fixesByDevice.get(dev.deviceId);
    const pathSpeed = pathSpeedMpsFromFixes(fixes);
    dev.pathSpeedMps = pathSpeed;
    dev.pathPaceWindowSec = PATH_PACE_WINDOW_MS / 1000;
    dev.displaySpeedMps = resolveDisplayPathSpeedMps(
      orgId,
      dev.deviceId,
      pathSpeed,
      dev.online !== false,
    );
  }
  return devices;
}

/** @param {number[]} values */
function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** @param {Sample} s */
function strokeRateFromSample(s) {
  const rate = s.derived?.strokeRate;
  if (rate == null || !Number.isFinite(rate)) return null;
  if (rate < MIN_SPM || rate > MAX_SPM) return null;
  return rate;
}

/** @param {Sample[]} samples @param {number} windowMs */
function strokeRateReadingsFromSamples(samples, windowMs) {
  if (!samples?.length) return [];
  const cutoff = Date.now() - windowMs;
  /** @type {{ t:number, strokeRate:number }[]} */
  const readings = [];
  for (const s of samples) {
    if (s.t < cutoff) continue;
    const strokeRate = strokeRateFromSample(s);
    if (strokeRate == null) continue;
    readings.push({ t: s.t, strokeRate });
  }
  return readings;
}

/**
 * @param {{ t:number, strokeRate:number }[]|null|undefined} readings
 * @param {number} [windowMs]
 */
function medianStrokeRateFromReadings(readings, windowMs = STROKE_MEDIAN_WINDOW_MS) {
  if (!readings?.length) return null;
  const endT = readings[readings.length - 1].t;
  const cutoff = endT - windowMs;
  const rates = readings
    .filter((r) => r.t >= cutoff)
    .map((r) => r.strokeRate);
  if (rates.length < STROKE_MEDIAN_MIN_READINGS) return null;
  const median = medianOf(rates);
  if (median == null || !Number.isFinite(median)) return null;
  return Math.round(median * 10) / 10;
}

/**
 * @param {number} orgId
 * @param {number} windowMs
 * @param {Map<string, { samples?: Sample[] }>} telemetryByDevice
 */
async function loadStrokeRateReadingsByDevice(orgId, windowMs, telemetryByDevice) {
  /** @type {Map<string, { t:number, strokeRate:number }[]>} */
  const readingsByDevice = new Map();
  if (db.hasDb()) {
    try {
      const dbReadings = await db.getRecentStrokeRatesByDevice(
        orgId,
        windowMs + 2000,
        STROKE_MEDIAN_READING_LIMIT,
      );
      for (const [deviceId, readings] of dbReadings) {
        readingsByDevice.set(deviceId, readings);
      }
    } catch (err) {
      console.error('[ingest-store] loadStrokeRateReadingsByDevice DB failed:', err);
    }
  }
  if (telemetryByDevice?.size) {
    for (const [deviceId, entry] of telemetryByDevice) {
      const fromSamples = strokeRateReadingsFromSamples(
        entry?.samples || [],
        windowMs + 2000,
      );
      if (!fromSamples.length) continue;
      const merged = [...(readingsByDevice.get(deviceId) || []), ...fromSamples].sort(
        (a, b) => a.t - b.t,
      );
      readingsByDevice.set(deviceId, merged);
    }
  }
  return readingsByDevice;
}

/** @param {object[]} positions @param {Map<string, { t:number, strokeRate:number }[]>} readingsByDevice */
function attachStrokeMedianToMapPositions(positions, readingsByDevice) {
  for (const p of positions) {
    const readings = readingsByDevice.get(p.deviceId);
    const median = medianStrokeRateFromReadings(readings);
    p.strokeRateMedian = median;
    p.strokeMedianWindowSec = STROKE_MEDIAN_WINDOW_MS / 1000;
    if (
      median != null &&
      p.online !== false &&
      p.telemetryStale !== true
    ) {
      p.displayStrokeRate = median;
    } else {
      p.displayStrokeRate = p.strokeRate ?? null;
    }
  }
  return positions;
}

/** @param {object[]} devices @param {Map<string, { t:number, strokeRate:number }[]>} readingsByDevice */
function attachStrokeMedianToDevices(devices, readingsByDevice) {
  for (const dev of devices) {
    const readings = readingsByDevice.get(dev.deviceId);
    const median = medianStrokeRateFromReadings(readings);
    dev.strokeRateMedian = median;
    dev.strokeMedianWindowSec = STROKE_MEDIAN_WINDOW_MS / 1000;
    dev.displayStrokeRate =
      median != null && dev.online !== false ? median : dev.rowing?.strokeRate ?? null;
  }
  return devices;
}

/** Replay recent GPS fixes from DB/memory so map speed uses distance/time not Android spd alone. */
function warmGpsTracksFromFixesByDevice(orgId, fixesByDevice, opts = {}) {
  if (!fixesByDevice?.size) return;
  const trackOpts = {
    maxTrackSpeedMps: opts.maxTrackSpeedMps ?? MAX_TRACK_SPEED_MPS,
  };
  for (const [deviceId, fixes] of fixesByDevice) {
    if (!deviceId || !fixes?.length) continue;
    const trackKey = orgDeviceKey(orgId, deviceId);
    for (const fix of fixes) {
      updateGpsTrack(
        trackKey,
        {
          t: fix.t,
          lat: fix.lat,
          lon: fix.lon,
          acc: fix.acc ?? null,
          spd: fix.spd ?? null,
          hdg: fix.hdg ?? null,
        },
        trackOpts,
      );
    }
  }
}

async function warmGpsTracksFromRecentDbFixes(orgId, windowMs, opts = {}) {
  if (!db.hasDb()) return;
  try {
    const fixesByDevice = await db.getRecentGpsFixesByDevice(orgId, windowMs, 8);
    warmGpsTracksFromFixesByDevice(orgId, fixesByDevice, opts);
  } catch (err) {
    console.error('[ingest-store] warmGpsTracksFromRecentDbFixes failed:', err);
  }
}

/** Replay recent GPS samples so map polls warm the filter (serverless-safe). */
function warmGpsTracksFromSamplesByDevice(orgId, byDevice, opts = {}) {
  if (!byDevice) return;
  const trackOpts = {
    maxTrackSpeedMps: opts.maxTrackSpeedMps ?? MAX_TRACK_SPEED_MPS,
  };
  const entries =
    byDevice instanceof Map
      ? [...byDevice.entries()].map(([deviceId, entry]) => [deviceId, entry])
      : [...byDevice.values()].map((entry) => [entry.deviceId, entry]);
  for (const [deviceId, entry] of entries) {
    if (!deviceId || !entry) continue;
    const trackKey = orgDeviceKey(orgId, deviceId);
    for (const s of entry.samples || []) {
      if (!s?.gps) continue;
      const fix = gpsFromSample(s, { forTrack: true });
      if (fix) updateGpsTrack(trackKey, fix, trackOpts);
    }
  }
}

/**
 * Attach smoothed coords; primary lat/lon stay raw for map colour markers.
 * Overlay uses last fix + bounded velocity extrapolation to now (when moving).
 * @param {object[]} rawPositions
 * @param {'rowing' | 'car'} [predictMode]
 * @param {number} [orgId]
 */
function attachSmoothMapCoords(rawPositions, predictMode = 'rowing', orgId = null) {
  const limits = predictLimitsForMode(parsePredictMode(predictMode));
  const now = Date.now();
  return rawPositions.map((p) => {
    const trackKey =
      orgId != null ? orgDeviceKey(orgId, p.deviceId) : String(p.deviceId);
    const track = gpsTracks.get(trackKey);
    const rawLat = p.latitude;
    const rawLon = p.longitude;
    if (rawLat == null || rawLon == null) {
      return {
        ...p,
        smoothLatitude: rawLat,
        smoothLongitude: rawLon,
        smoothFixAgeSec: p.fixAgeSec,
        smoothed: false,
      };
    }

    const fixMs = Number(p.fixMs);
    const fixAgeSec =
      Number.isFinite(fixMs) && fixMs > 0
        ? Math.max(0, (now - fixMs) / 1000)
        : Number(p.fixAgeSec);
    const predictFixAgeSec = effectiveFixAgeSec(
      fixAgeSec,
      p.lastSeenAgoSec,
      p.online,
    );

    let smoothLat = rawLat;
    let smoothLon = rawLon;

    if (track && Number.isFinite(track.t)) {
      const speedMps = Math.min(
        track.speedMps != null && Number.isFinite(track.speedMps)
          ? Math.max(0, track.speedMps)
          : 0,
        limits.maxSpeedMps,
      );
      const courseDeg = track.courseDeg;
      const canPredict =
        p.online !== false &&
        predictFixAgeSec != null &&
        predictFixAgeSec <= MAX_PREDICT_FIX_AGE_SEC &&
        speedMps >= MIN_PREDICT_SPEED_MPS &&
        courseDeg != null &&
        Number.isFinite(courseDeg);

      if (canPredict && predictFixAgeSec > 0) {
        const predictSec = Math.min(predictFixAgeSec, MAX_PREDICT_SEC);
        const anchorLat =
          track.smoothLat != null && Number.isFinite(track.smoothLat)
            ? track.smoothLat
            : rawLat;
        const anchorLon =
          track.smoothLon != null && Number.isFinite(track.smoothLon)
            ? track.smoothLon
            : rawLon;
        [smoothLat, smoothLon] = destinationLatLon(
          anchorLat,
          anchorLon,
          courseDeg,
          speedMps * predictSec,
        );
      } else if (
        track.smoothLat != null &&
        track.smoothLon != null &&
        Number.isFinite(track.smoothLat) &&
        Number.isFinite(track.smoothLon)
      ) {
        smoothLat = track.smoothLat;
        smoothLon = track.smoothLon;
      }
    }

    const clamped = clampOffsetFromRaw(
      rawLat,
      rawLon,
      smoothLat,
      smoothLon,
      limits.maxOffsetM,
    );

    const smoothAgeSec =
      fixAgeSec != null && Number.isFinite(fixAgeSec)
        ? Math.round(fixAgeSec)
        : p.fixAgeSec;

    return {
      ...p,
      speed: displayMapSpeedMps(p.speed, track?.speedMps),
      course:
        p.course ??
        (track?.courseDeg != null && Number.isFinite(track.courseDeg)
          ? track.courseDeg
          : null),
      smoothLatitude: clamped.lat,
      smoothLongitude: clamped.lon,
      smoothFixAgeSec: smoothAgeSec,
      smoothed: clamped.offsetM > 1.5,
    };
  });
}

/**
 * @param {Sample[]} samples
 * @returns {{ t: number, pct: number } | null}
 */
function latestBatteryFromSamples(samples) {
  for (let i = samples.length - 1; i >= 0; i--) {
    const d = samples[i]?.derived;
    if (d && d.batteryPct != null && Number.isFinite(Number(d.batteryPct))) {
      return {
        t: samples[i].t,
        pct: Math.max(0, Math.min(100, Math.round(Number(d.batteryPct)))),
      };
    }
  }
  return null;
}

/**
 * @param {string} deviceId
 * @param {Sample[]} samples
 */
function noteDeviceTelemetry(deviceId, samples) {
  const id = String(deviceId);
  for (const s of samples) {
    if (s?.derived?.heartbeat === true) {
      lastHeartbeatByDevice.set(id, { t: s.t });
    }
    const pct = s?.derived?.batteryPct;
    if (pct != null && Number.isFinite(Number(pct))) {
      lastBatteryByDevice.set(id, {
        t: s.t,
        pct: Math.max(0, Math.min(100, Math.round(Number(pct)))),
      });
    }
  }
}

function sanitizeAndTrackSamples(deviceId, samples) {
  const out = [];
  let dropped = 0;
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') {
      dropped++;
      continue;
    }
    let next = sample;
    if (sample.gps) {
      const fix = gpsFromSample(sample);
      if (!fix) {
        const { gps, ...rest } = sample;
        const hasPayload =
          rest.motion != null || rest.hr != null || rest.derived != null;
        if (!hasPayload) {
          dropped++;
          continue;
        }
        next = rest;
      } else {
        const trackFix = gpsFromSample(sample, { forTrack: true });
        if (trackFix) updateGpsTrack(deviceId, trackFix);
      }
    }
    out.push(next);
  }
  return { samples: out, dropped };
}

/** Rate over active sample span — avoids understating Hz when the window predates session start. */
function activeSpanSec(timestamps, windowSec) {
  if (!timestamps.length) return windowSec;
  let minT = timestamps[0];
  let maxT = timestamps[0];
  for (const t of timestamps) {
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
  }
  const burstSec = Math.max((maxT - minT) / 1000, 0);
  return Math.min(windowSec, Math.max(burstSec >= 0.5 ? burstSec : 1, 1));
}

function activeRateHz(count, timestamps, windowSec) {
  if (count <= 0 || windowSec <= 0) return 0;
  return Math.round((count / activeSpanSec(timestamps, windowSec)) * 10) / 10;
}

/**
 * @param {Sample[]} samples
 * @param {number} windowMs
 * @param {string} [deviceId]
 */
function sensorStats(samples, windowMs, deviceId) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = samples.filter((s) => s.t >= cutoff);
  const clearAt = getCapsizeClearAt(deviceId);
  const afterClear = (t) => !clearAt || t > clearAt;

  let gpsCount = 0;
  let motionCount = 0;
  let hrCount = 0;
  let lastGps = null;
  let lastMotion = null;
  let lastHr = null;
  let lastDerived = null;
  let capsizeInWindow = false;
  let heartbeatCount = 0;
  let lastHeartbeatT = null;
  /** @type {number[]} */
  const gpsTimes = [];
  /** @type {number[]} */
  const motionTimes = [];
  /** @type {number[]} */
  const hrTimes = [];
  /** @type {number[]} */
  const heartbeatTimes = [];

  for (const s of recent) {
    if (s.gps && s.gps.lat != null && s.gps.lon != null) {
      gpsCount++;
      gpsTimes.push(s.t);
      lastGps = { t: s.t, lat: s.gps.lat, lon: s.gps.lon, acc: s.gps.acc };
    }
    if (s.motion && s.motion.ax != null) {
      motionCount++;
      motionTimes.push(s.t);
      lastMotion = { t: s.t, ...s.motion };
    }
    if (s.hr && s.hr.bpm != null) {
      hrCount++;
      hrTimes.push(s.t);
      lastHr = { t: s.t, bpm: s.hr.bpm };
    }
    if (s.derived) {
      lastDerived = { t: s.t, ...s.derived };
      if (s.derived.capsize === true && afterClear(s.t)) capsizeInWindow = true;
      if (s.derived.heartbeat === true) {
        heartbeatCount++;
        heartbeatTimes.push(s.t);
        lastHeartbeatT = s.t;
      }
    }
  }

  const motionSamples = recent.filter(
    (s) => s.motion && s.motion.ax != null && afterClear(s.t),
  );
  const analyzed = motionSamples.length ? analyzeMotionWindow(motionSamples) : null;
  const strokeRate =
    analyzed?.strokeRate ??
    (lastDerived?.strokeRate != null ? lastDerived.strokeRate : null);
  const derivedCapsize =
    lastDerived?.capsize === true && afterClear(lastDerived.t);
  const capsize =
    capsizeInWindow || Boolean(analyzed?.capsize) || Boolean(derivedCapsize);
  const tiltDeg = analyzed?.tiltDeg ?? lastDerived?.tiltDeg ?? null;

  const windowSec = windowMs / 1000;
  const sampleTimes = recent.map((s) => s.t);

  // Rates/counts use the stats window; last fix/age match the map (any recent sample).
  const latestGpsFix = latestGpsFromSamples(samples);
  const gpsLast = latestGpsFix ?? lastGps;
  const gpsAgeSec = gpsLast ? Math.round((now - gpsLast.t) / 1000) : null;

  return {
    gps: {
      present: gpsCount > 0 || latestGpsFix != null,
      rateHz: activeRateHz(gpsCount, gpsTimes, windowSec),
      count: gpsCount,
      last: gpsLast,
      ageSec: gpsAgeSec,
    },
    motion: {
      present: motionCount > 0,
      rateHz: activeRateHz(motionCount, motionTimes, windowSec),
      count: motionCount,
      last: lastMotion,
      ageSec: lastMotion ? Math.round((now - lastMotion.t) / 1000) : null,
    },
    hr: {
      present: hrCount > 0,
      rateHz: activeRateHz(hrCount, hrTimes, windowSec),
      count: hrCount,
      last: lastHr,
      ageSec: lastHr ? Math.round((now - lastHr.t) / 1000) : null,
    },
    rowing: {
      strokeRate,
      strokeRateValid: strokeRate != null,
      capsize,
      tiltDeg,
      calibrated: analyzed?.calibrated ?? false,
      ageSec: lastMotion ? Math.round((now - lastMotion.t) / 1000) : null,
    },
    heartbeat: {
      present: heartbeatCount > 0,
      rateHz: activeRateHz(heartbeatCount, heartbeatTimes, windowSec),
      count: heartbeatCount,
      lastT: lastHeartbeatT,
      ageSec: lastHeartbeatT ? Math.round((now - lastHeartbeatT) / 1000) : null,
    },
    totalInWindow: recent.length,
    ingestRateHz: activeRateHz(recent.length, sampleTimes, windowSec),
  };
}

/**
 * @param {string} sessionId
 * @param {string} deviceId
 * @param {string} [athleteId]
 * @param {Sample[]} samples
 * @param {string} [idempotencyKey]
 */
async function recordBatch(orgId, sessionId, deviceId, athleteId, samples, idempotencyKey) {
  metrics.requests++;
  const dedupeKey = idempotencyKey ? String(idempotencyKey) : '';
  const now = Date.now();
  pruneIdempotency(now);
  if (dedupeKey && db.hasDb()) {
    try {
      const dbCached = await db.getIdempotency(orgId, dedupeKey, IDEMPOTENCY_TTL_MS);
      if (dbCached) {
        metrics.duplicates++;
        recentIdempotency.set(`${orgId}:${dedupeKey}`, { t: now, result: dbCached });
        return { ...dbCached, duplicate: true };
      }
    } catch (err) {
      console.error('[ingest-store] DB idempotency read failed:', err);
    }
  }
  if (dedupeKey) {
    const memKey = `${orgId}:${dedupeKey}`;
    const cached = recentIdempotency.get(memKey);
    if (cached && now - cached.t <= IDEMPOTENCY_TTL_MS) {
      metrics.duplicates++;
      return { ...cached.result, duplicate: true };
    }
  }
  if (!samples.length) return { received: 0 };
  const scopedDevice = orgDeviceKey(orgId, deviceId);
  const clean = sanitizeAndTrackSamples(scopedDevice, samples);
  if (!clean.samples.length) {
    metrics.droppedSamples += clean.dropped || 0;
    return { received: 0, dropped: clean.dropped };
  }
  metrics.droppedSamples += clean.dropped || 0;

  const geofenceFilter = await filterSamplesInsideSuppressZones(
    orgId,
    scopedDevice,
    clean.samples,
  );
  clean.samples = geofenceFilter.samples;
  const geofenceDropped = geofenceFilter.dropped || 0;
  if (geofenceDropped) metrics.droppedSamples += geofenceDropped;
  if (!clean.samples.length) {
    return {
      received: 0,
      dropped: (clean.dropped || 0) + geofenceDropped,
      suppressedInGeofence: geofenceDropped,
    };
  }
  let maxCapsizeT = null;
  for (const sample of clean.samples) {
    if (!sampleHasCapsize(sample)) continue;
    const t = Number(sample.t);
    const clearAt = getCapsizeClearAt(scopedDevice);
    const orgClearAt = getCapsizeClearAt(orgDeviceKey(orgId, '*'));
    const latestClear = Math.max(clearAt || 0, orgClearAt || 0);
    if (latestClear && Number.isFinite(t) && t <= latestClear) continue;
    if (Number.isFinite(t) && (maxCapsizeT == null || t > maxCapsizeT)) maxCapsizeT = t;
  }
  if (maxCapsizeT != null) raiseStickyCapsizeAlert(orgId, deviceId, maxCapsizeT);

  backfillCapsizeGpsInMemory(scopedDevice, clean.samples);

  const key = orgSessionKey(orgId, sessionId);
  let row = sessions.get(key);
  if (!row) {
    row = {
      orgId,
      deviceId: String(deviceId),
      athleteId: athleteId ? String(athleteId) : undefined,
      samples: [],
      updatedAt: now,
      firstSeenAt: now,
    };
    sessions.set(key, row);
  }

  row.orgId = orgId;
  row.deviceId = String(deviceId);
  if (athleteId) row.athleteId = String(athleteId);
  row.samples.push(...clean.samples);
  row.updatedAt = now;
  noteDeviceTelemetry(scopedDevice, clean.samples);
  trimSampleRing(row);
  trimSessions();

  let persisted = false;
  let persistError = null;
  /** @type {string[]} */
  let capsizeCleared = [];
  try {
    if (db.hasDb()) {
      const persistResult = await db.persistBatch(
        orgId,
        sessionId,
        deviceId,
        athleteId,
        clean.samples,
      );
      persisted = persistResult?.ok === true;
      capsizeCleared = persistResult?.cleared || [];
      if (persisted) {
        metrics.persistedBatches++;
        metrics.lastPersistAt = now;
        applyCapsizeAlertClears(orgId, capsizeCleared);
      }
    }
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    console.error('[ingest-store] DB persist failed:', err);
    metrics.persistFailures++;
    metrics.lastPersistError = String(persistError).slice(0, 300);
  }

  const result = {
    received: clean.samples.length,
    dropped: clean.dropped || undefined,
    suppressedInGeofence: geofenceDropped || undefined,
    total: row.samples.length,
    persisted,
    persistError,
  };
  if (dedupeKey) {
    const memKey = `${orgId}:${dedupeKey}`;
    recentIdempotency.set(memKey, { t: now, result });
    if (db.hasDb()) {
      try {
        await db.setIdempotency(orgId, dedupeKey, result);
      } catch (err) {
        console.error('[ingest-store] DB idempotency write failed:', err);
      }
    }
  }
  return result;
}

/**
 * @param {number} orgId
 * @param {string} sessionId
 * @param {string} deviceId
 * @param {number} [endedAtMs]
 * @param {string} [athleteId]
 */
async function endSession(orgId, sessionId, deviceId, endedAtMs, athleteId) {
  const endedAt =
    endedAtMs != null && Number.isFinite(Number(endedAtMs)) ? Number(endedAtMs) : Date.now();
  let persisted = false;
  if (db.hasDb()) {
    try {
      persisted = await db.endSession(orgId, sessionId, endedAt);
    } catch (err) {
      console.error('[ingest-store] DB endSession failed:', err);
    }
  }
  const key = orgSessionKey(orgId, sessionId);
  const row = sessions.get(key);
  if (row) {
    row.deviceId = String(deviceId);
    if (athleteId) row.athleteId = String(athleteId);
    row.endedAt = endedAt;
    row.updatedAt = endedAt;
  }
  return { ended: true, persisted, endedAt };
}

/**
 * Drop samples while the device is inside a suppress-recording boat-park zone.
 * GPS samples update last-known position; motion/HR without GPS use that position.
 */
async function filterSamplesInsideSuppressZones(orgId, scopedDevice, samples) {
  if (!Array.isArray(samples) || !samples.length) {
    return { samples: [], dropped: 0 };
  }
  let geofences = [];
  try {
    if (db.hasDb()) geofences = await db.listGeofences(orgId);
  } catch (err) {
    console.error('[ingest-store] geofence list failed:', err);
    return { samples, dropped: 0 };
  }
  if (!geofences.length) return { samples, dropped: 0 };

  const suppressZones = geofences.filter((g) => g && g.suppressRecording === true);
  if (!suppressZones.length) return { samples, dropped: 0 };

  let last = lastGpsByDevice.get(scopedDevice) || null;
  const kept = [];
  let dropped = 0;

  for (const sample of samples) {
    const fix = gpsFromSample(sample);
    if (fix) {
      last = { lat: fix.lat, lon: fix.lon, t: fix.t };
      lastGpsByDevice.set(scopedDevice, last);
    }
    const lat = fix?.lat ?? last?.lat;
    const lon = fix?.lon ?? last?.lon;
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      findSuppressRecordingAt(lat, lon, suppressZones)
    ) {
      if (!sampleHasCapsize(sample)) {
        dropped++;
        continue;
      }
    }
    kept.push(sample);
  }

  return { samples: kept, dropped };
}

async function getSession(orgId, sessionId) {
  if (db.hasDb()) {
    try {
      const fromDb = await db.getSessionFromDb(orgId, sessionId);
      if (fromDb) return fromDb;
    } catch (err) {
      console.error('[ingest-store] DB getSession failed:', err);
    }
  }
  const row = sessions.get(orgSessionKey(orgId, String(sessionId)));
  if (!row) return undefined;
  return { sessionId, ...row };
}

/** Card/monitor age when fix timestamp lags behind upload (batch or clock skew). */
function displayGpsAgeSec(fixAgeSec, ingestAgoSec) {
  if (fixAgeSec == null) return null;
  if (ingestAgoSec == null) return fixAgeSec;
  if (fixAgeSec - ingestAgoSec > 20) return ingestAgoSec;
  return fixAgeSec;
}

/** Age for delayed-GPS health — prefers upload time when fix clock lags. */
function gpsHealthAgeSec(gps) {
  if (!gps) return null;
  if (gps.displayAgeSec != null && Number.isFinite(gps.displayAgeSec)) {
    return gps.displayAgeSec;
  }
  return gps.ageSec ?? null;
}

function enrichMapPositionDisplayAge(p, now, registryRow) {
  const ingestAgoSec =
    registryRow?.lastGpsIngestMs != null
      ? Math.max(0, Math.round((now - registryRow.lastGpsIngestMs) / 1000))
      : p.lastSeenAgoSec ?? null;
  const displayFixAgeSec = displayGpsAgeSec(p.fixAgeSec, ingestAgoSec);
  const receiveAgoSec =
    p.lastSeenAgoSec != null && Number.isFinite(p.lastSeenAgoSec)
      ? p.lastSeenAgoSec
      : ingestAgoSec;
  const telemetryStale =
    receiveAgoSec != null && Number.isFinite(receiveAgoSec) && receiveAgoSec > 30;
  return {
    ...p,
    ingestAgoSec,
    displayFixAgeSec,
    telemetryStale,
  };
}

function enrichMapPositionsDisplayAge(positions, now, registryTimes) {
  return positions.map((p) =>
    enrichMapPositionDisplayAge(p, now, registryTimes?.get(p.deviceId)),
  );
}

function buildDeviceEntry(orgId, entry, windowMs, onlineMs, now, registryTimes) {
  const stats = sensorStats(entry.samples, windowMs, orgDeviceKey(orgId, entry.deviceId));
  const sampleLastSeenMs = entry.lastSeenMs ?? entry.updatedAt ?? now;
  const lastIngestMs = registryTimes?.lastSeenMs ?? 0;
  const lastSeenMs = Math.max(sampleLastSeenMs, lastIngestMs);
  const online = now - lastSeenMs <= onlineMs;
  const hbMem = lastHeartbeatByDevice.get(orgDeviceKey(orgId, entry.deviceId));
  const batFromSamples = latestBatteryFromSamples(entry.samples || []);
  const batMem = lastBatteryByDevice.get(orgDeviceKey(orgId, entry.deviceId));
  const bat =
    batFromSamples && batMem
      ? batFromSamples.t >= batMem.t
        ? batFromSamples
        : batMem
      : batFromSamples || batMem || null;
  const lastHbT = Math.max(hbMem?.t ?? 0, stats.heartbeat?.lastT ?? 0);
  const heartbeat = {
    present: (stats.heartbeat?.count ?? 0) > 0 || lastHbT > 0,
    rateHz: stats.heartbeat?.rateHz ?? 0,
    count: stats.heartbeat?.count ?? 0,
    ageSec: lastHbT ? Math.round((now - lastHbT) / 1000) : null,
  };
  const battery = bat
    ? {
        pct: bat.pct,
        ageSec: Math.round((now - bat.t) / 1000),
      }
    : { pct: null, ageSec: null };
  const fixAgeSec = stats.gps?.ageSec ?? null;
  const gpsIngestAgoSec = registryTimes?.lastGpsIngestMs
    ? Math.max(0, Math.round((now - registryTimes.lastGpsIngestMs) / 1000))
    : null;
  const gpsDisplayAgeSec = displayGpsAgeSec(fixAgeSec, gpsIngestAgoSec);
  const fixClockLagSec =
    fixAgeSec != null && gpsIngestAgoSec != null ? fixAgeSec - gpsIngestAgoSec : null;
  return {
    deviceId: entry.deviceId,
    athleteId: entry.athleteId || null,
    sessionId: entry.sessionId,
    online,
    lastSeenMs,
    lastSeenAgoSec: Math.max(0, Math.round((now - lastSeenMs) / 1000)),
    firstSeenMs: entry.firstSeenMs ?? entry.firstSeenAt ?? lastSeenMs,
    totalSamples: entry.samples.length,
    ...stats,
    gps: {
      ...stats.gps,
      ingestAgoSec: gpsIngestAgoSec,
      displayAgeSec: gpsDisplayAgeSec,
      fixClockLagSec,
    },
    heartbeat,
    battery,
  };
}

function forceCapsizeAlertsOnDevices(byDevice, alerts, orgId, windowMs, onlineMs, now) {
  if (!alerts?.size) return;
  for (const [deviceId, alert] of alerts) {
    if (alert?.atMs != null && now - alert.atMs > CAPSIZE_ALERT_MAX_AGE_MS) continue;
    const id = String(deviceId);
    let dev = byDevice.get(id);
    if (!dev) {
      const seenAt = alert?.atMs && Number.isFinite(alert.atMs) ? alert.atMs : now;
      dev = buildDeviceEntry(
        orgId,
        {
          deviceId: id,
          athleteId: null,
          sessionId: '',
          samples: [],
          lastSeenMs: seenAt,
          firstSeenMs: seenAt,
        },
        windowMs,
        onlineMs,
        now,
      );
      byDevice.set(id, dev);
    }
    dev.rowing = {
      ...(dev.rowing || {}),
      capsize: true,
    };
    dev.capsizeAlertAtMs = alert?.atMs ?? null;
  }
}

/**
 * @param {{ orgId: number, windowMs?: number, onlineMs?: number }} [opts]
 */
function listDevicesFromMemory(opts = {}) {
  const orgId = opts.orgId;
  const windowMs = opts.windowMs ?? 60000;
  const onlineMs = opts.onlineMs ?? 30000;
  const now = Date.now();
  const byDevice = new Map();

  for (const [sessionId, row] of sessions) {
    if (row.orgId !== orgId) continue;
    const built = buildDeviceEntry(
      orgId,
      {
        deviceId: row.deviceId,
        athleteId: row.athleteId,
        sessionId,
        samples: row.samples,
        lastSeenMs: row.updatedAt,
        firstSeenMs: row.firstSeenAt,
      },
      windowMs,
      onlineMs,
      now,
    );
    const prev = byDevice.get(row.deviceId);
    if (!prev || built.lastSeenMs > prev.lastSeenMs) {
      byDevice.set(row.deviceId, built);
    }
  }

  return byDevice;
}

/**
 * @param {number} orgId
 * @param {{ windowMs?: number, onlineMs?: number }} [opts]
 */
async function listDevices(orgId, opts = {}) {
  const windowMs = opts.windowMs ?? 60000;
  const onlineMs = opts.onlineMs ?? 30000;
  const now = Date.now();
  const hasPostgres = db.hasDb();

  /** @type {Map<string, object>} */
  const byDevice = listDevicesFromMemory({ orgId, windowMs, onlineMs });

  let storage = hasPostgres ? 'postgres' : 'memory';
  let warning = hasPostgres
    ? null
    : 'No database configured — monitor only sees data on the same server instance. Add POSTGRES_URL in Vercel and redeploy.';

  if (hasPostgres) {
    try {
      // Registry-only for live polls. Do NOT scan rnz_samples here; those
      // queries can outlive request handling and trigger Vercel 504s.
      const [registryGps, registryTimes, rowingTel, dbCapsizeAlerts, batteryByDevice, strokeByDevice, motionByDevice] =
        await Promise.all([
        db.getRegistryGpsByDevice(orgId),
        db.getDeviceRegistryTimes(orgId),
        db.getLatestRowingTelemetry(orgId, Math.max(windowMs, 120000)),
        loadDbCapsizeAlerts(orgId),
        db.getLatestBatteryByDevice(orgId),
        db.getLatestStrokeByDevice(orgId, Math.max(windowMs, 120000)),
        db.getRecentMotionByDevice(orgId, Math.max(windowMs, 90000)),
      ]);

      for (const [deviceId, regFix] of registryGps) {
        const patched = applyRegistryGpsToDevice(
          buildDeviceEntry(
            orgId,
            {
              deviceId,
              athleteId: null,
              sessionId: '',
              samples: [
                {
                  t: regFix.t,
                  gps: {
                    lat: regFix.lat,
                    lon: regFix.lon,
                    acc: regFix.acc,
                    ...(regFix.spd != null ? { spd: regFix.spd } : {}),
                  },
                },
              ],
              lastSeenMs: Math.max(
                regFix.t,
                registryTimes.get(deviceId)?.lastSeenMs ?? 0,
              ),
              firstSeenMs: regFix.t,
            },
            windowMs,
            onlineMs,
            now,
            registryTimes.get(deviceId),
          ),
          regFix,
          now,
        );
        byDevice.set(deviceId, patched);
      }

      for (const [deviceId, times] of registryTimes) {
        if (byDevice.has(deviceId)) continue;
        const lastSeenMs = times.lastSeenMs || 0;
        if (!lastSeenMs) continue;
        byDevice.set(
          deviceId,
          buildDeviceEntry(
            orgId,
            {
              deviceId,
              athleteId: null,
              sessionId: '',
              samples: [],
              lastSeenMs,
              firstSeenMs: lastSeenMs,
            },
            windowMs,
            onlineMs,
            now,
            times,
          ),
        );
      }

      for (const dev of byDevice.values()) {
        mergeListDeviceDbTelemetry(
          dev,
          rowingTel.get(dev.deviceId),
          batteryByDevice.get(dev.deviceId),
          strokeByDevice.get(dev.deviceId),
          motionByDevice.get(dev.deviceId),
          now,
        );
      }
      forceCapsizeAlertsOnDevices(
        byDevice,
        dbCapsizeAlerts,
        orgId,
        windowMs,
        onlineMs,
        now,
      );

      warning = null;
    } catch (err) {
      console.error('[ingest-store] listDevices DB failed:', err);
      storage = 'memory';
      warning = `Database read failed: ${err.message}`;
    }
  }
  for (const dev of byDevice.values()) {
    if (dev.rowing) dev.rowing.capsize = false;
  }
  forceCapsizeAlertsOnDevices(
    byDevice,
    getStickyCapsizeAlerts(orgId),
    orgId,
    windowMs,
    onlineMs,
    now,
  );

  const devices = [...byDevice.values()].sort(
    (a, b) => b.lastSeenMs - a.lastSeenMs,
  );
  const pathTelemetry = samplesByDeviceForWindow(
    orgId,
    Math.max(windowMs, PATH_PACE_WINDOW_MS),
  );
  const pathFixesByDevice = await loadPathPaceFixesByDevice(
    orgId,
    PATH_PACE_WINDOW_MS,
    pathTelemetry,
  );
  attachPathPaceToDevices(devices, pathFixesByDevice, orgId);
  const strokeReadingsByDevice = await loadStrokeRateReadingsByDevice(
    orgId,
    STROKE_MEDIAN_WINDOW_MS,
    pathTelemetry,
  );
  attachStrokeMedianToDevices(devices, strokeReadingsByDevice);
  const onlineDevices = devices.filter((d) => d.online);
  const gpsAges = onlineDevices
    .map((d) => gpsHealthAgeSec(d.gps))
    .filter((v) => Number.isFinite(v));
  const ingestRates = onlineDevices
    .map((d) => d.ingestRateHz)
    .filter((v) => Number.isFinite(v));
  const gpsRates = onlineDevices
    .map((d) => d.gps?.rateHz)
    .filter((v) => Number.isFinite(v) && v > 0);
  const strokeRates = onlineDevices
    .map((d) => d.rowing?.strokeRate)
    .filter((v) => Number.isFinite(v) && v > 0);
  const heartbeatRates = onlineDevices
    .map((d) => d.heartbeat?.rateHz)
    .filter((v) => Number.isFinite(v) && v > 0);
  const heartbeatAges = onlineDevices
    .map((d) => d.heartbeat?.ageSec)
    .filter((v) => Number.isFinite(v));
  const batteryPcts = onlineDevices
    .map((d) => d.battery?.pct)
    .filter((v) => Number.isFinite(v));
  const maxLastSeenMs = devices.length
    ? Math.max(...devices.map((d) => d.lastSeenMs || 0))
    : null;
  const health = {
    status:
      warning != null
        ? 'degraded'
        : onlineDevices.length === 0
          ? 'idle'
          : 'ok',
    onlineDevices: onlineDevices.length,
    delayedGpsDevices: onlineDevices.filter(
      (d) => (gpsHealthAgeSec(d.gps) ?? 1e9) > 30,
    ).length,
    capsizeDevices: onlineDevices.filter((d) => d.rowing?.capsize).length,
    avgGpsAgeSec: gpsAges.length
      ? Math.round((gpsAges.reduce((a, b) => a + b, 0) / gpsAges.length) * 10) / 10
      : null,
    avgIngestHz: ingestRates.length
      ? Math.round((ingestRates.reduce((a, b) => a + b, 0) / ingestRates.length) * 10) / 10
      : null,
    avgGpsHz: gpsRates.length
      ? Math.round((gpsRates.reduce((a, b) => a + b, 0) / gpsRates.length) * 10) / 10
      : null,
    avgStrokeSpm: strokeRates.length
      ? Math.round(strokeRates.reduce((a, b) => a + b, 0) / strokeRates.length)
      : null,
    avgHeartbeatHz: heartbeatRates.length
      ? Math.round((heartbeatRates.reduce((a, b) => a + b, 0) / heartbeatRates.length) * 10) /
        10
      : null,
    avgHeartbeatAgeSec: heartbeatAges.length
      ? Math.round((heartbeatAges.reduce((a, b) => a + b, 0) / heartbeatAges.length) * 10) / 10
      : null,
    avgBatteryPct: batteryPcts.length
      ? Math.round(batteryPcts.reduce((a, b) => a + b, 0) / batteryPcts.length)
      : null,
    minBatteryPct: batteryPcts.length ? Math.min(...batteryPcts) : null,
    serverDataLagSec:
      maxLastSeenMs != null ? Math.max(0, Math.round((now - maxLastSeenMs) / 1000)) : null,
  };

  return {
    polledAt: now,
    windowSec: windowMs / 1000,
    onlineThresholdSec: onlineMs / 1000,
    activeCount: devices.filter((d) => d.online).length,
    deviceCount: devices.length,
    devices,
    persisted: hasPostgres,
    storage,
    warning,
    health,
  };
}

function getPositionsSnapshot(orgId, onlineMs = 30000) {
  const now = Date.now();
  /** @type {Map<string, object>} */
  const byDevice = new Map();

  for (const [sessionId, row] of sessions) {
    if (row.orgId !== orgId) continue;
    let lastGps = null;
    let lastHr = null;
    let lastMotion = null;
    for (let i = row.samples.length - 1; i >= 0; i--) {
      const s = row.samples[i];
      if (!lastGps && s.gps?.lat != null && s.gps?.lon != null) lastGps = s;
      if (!lastHr && s.hr?.bpm != null) lastHr = s;
      if (!lastMotion && s.motion?.ax != null) lastMotion = s;
      if (lastGps && lastHr && lastMotion) break;
    }
    if (!lastGps) continue;

    const fixMs = lastGps.t;
    const pos = {
      uniqueId: row.deviceId,
      deviceId: row.deviceId,
      sessionId,
      athleteId: row.athleteId || null,
      latitude: lastGps.gps.lat,
      longitude: lastGps.gps.lon,
      accuracy: lastGps.gps.acc ?? null,
      speed: lastGps.gps.spd ?? null,
      course: resolveMapHeading(gpsFromSample(lastGps)) ?? lastGps.gps.hdg ?? null,
      altitude: lastGps.gps.alt ?? null,
      fixTime: new Date(fixMs).toISOString(),
      deviceTime: new Date(fixMs).toISOString(),
      lastUpdate: row.updatedAt,
      online: now - row.updatedAt <= onlineMs,
      attributes: {
        ...(lastHr ? { hr: lastHr.hr.bpm, heartRate: lastHr.hr.bpm } : {}),
        ...(lastMotion
          ? {
              ax: lastMotion.motion.ax,
              ay: lastMotion.motion.ay,
              az: lastMotion.motion.az,
            }
          : {}),
        ...(lastGps.gps.compass != null && Number.isFinite(Number(lastGps.gps.compass))
          ? { compass: Number(lastGps.gps.compass) }
          : {}),
      },
    };

    const prev = byDevice.get(row.deviceId);
    if (!prev || row.updatedAt > prev.lastUpdate) {
      byDevice.set(row.deviceId, pos);
    }
  }

  return {
    polledAt: now,
    onlineThresholdSec: onlineMs / 1000,
    positions: [...byDevice.values()].sort((a, b) => b.lastUpdate - a.lastUpdate),
  };
}

/**
 * Latest GPS fix from a sample list (same scan as sensorStats).
 * @param {Sample[]} samples
 */
function latestGpsFromSamples(samples) {
  let lastGps = null;
  for (const s of samples) {
    const fix = gpsFromSample(s);
    if (!fix) continue;
    if (!lastGps || fix.t >= lastGps.t) {
      lastGps = fix;
    }
  }
  return lastGps;
}

/**
 * @param {object} opts
 * @param {string} opts.deviceId
 * @param {{ t: number, lat: number, lon: number, acc?: number|null, spd?: number|null, hdg?: number|null }} opts.fix
 * @param {number} [opts.lastSeenMs]
 * @param {boolean} [opts.online]
 * @param {number} opts.now
 * @param {string|null} [opts.athleteId]
 * @param {number|null} [opts.hr]
 */
function buildRawMapPositionFromFix({
  deviceId,
  fix,
  lastSeenMs,
  online,
  now,
  athleteId,
  hr,
}) {
  const fixMs = fix.t;
  const lastSeen = Math.max(fixMs, lastSeenMs || 0);
  return {
    deviceId: String(deviceId),
    athleteId: athleteId || null,
    latitude: fix.lat,
    longitude: fix.lon,
    accuracy: fix.acc ?? null,
    speed: fix.spd != null && Number.isFinite(fix.spd) ? fix.spd : null,
    course: fix.hdg != null && Number.isFinite(fix.hdg) ? fix.hdg : null,
    fixMs,
    fixAgeSec: Math.round((now - fixMs) / 1000),
    lastSeenAgoSec: Math.round((now - lastSeen) / 1000),
    online: Boolean(online),
    hr: hr ?? null,
  };
}

/** @deprecated alias */
function buildMapPositionFromFix(opts) {
  return buildRawMapPositionFromFix(opts);
}

function getRawMemoryMapPositions(orgId, onlineMs, now) {
  const out = [];
  for (const row of sessions.values()) {
    if (row.orgId !== orgId) continue;
    let lastGps = null;
    for (let i = row.samples.length - 1; i >= 0; i--) {
      const s = row.samples[i];
      if (s.gps?.lat != null && s.gps?.lon != null) {
        lastGps = s;
        break;
      }
    }
    if (!lastGps) continue;
    const fix = gpsFromSample(lastGps);
    if (!fix) continue;
    out.push(
      buildRawMapPositionFromFix({
        deviceId: row.deviceId,
        fix,
        lastSeenMs: row.updatedAt,
        online: now - row.updatedAt <= onlineMs,
        now,
        athleteId: row.athleteId || null,
      }),
    );
  }
  return out;
}

/** Prefer Postgres registry when ingest is fresh — avoids serverless memory drift. */
function mergeMapPositionsPreferRegistry(
  memoryPositions,
  registryPositions,
  registryTimes,
  now,
  onlineMs,
) {
  /** @type {Map<string, object>} */
  const byDevice = new Map();
  for (const p of registryPositions) {
    if (p.latitude == null || p.longitude == null) continue;
    byDevice.set(p.deviceId, p);
  }
  for (const p of memoryPositions) {
    if (p.latitude == null || p.longitude == null) continue;
    const reg = byDevice.get(p.deviceId);
    const times = registryTimes?.get(p.deviceId);
    const registryFresh =
      times?.lastGpsIngestMs != null &&
      now - times.lastGpsIngestMs <= onlineMs;
    if (registryFresh && reg) continue;
    if (!reg || (p.fixMs ?? 0) >= (reg.fixMs ?? 0)) {
      byDevice.set(p.deviceId, { ...reg, ...p });
    }
  }
  return [...byDevice.values()];
}

/** @param {object[][]} positionGroups later groups win on equal fixMs */
function mergeMapPositionsByFixMs(positionGroups) {
  /** @type {Map<string, object>} */
  const byDevice = new Map();
  for (const group of positionGroups) {
    for (const p of group) {
      if (p.latitude == null || p.longitude == null) continue;
      const prev = byDevice.get(p.deviceId);
      if (!prev || (p.fixMs ?? 0) >= (prev.fixMs ?? 0)) {
        const merged = { ...prev, ...p };
        if (
          (merged.speed == null || !Number.isFinite(merged.speed)) &&
          prev?.speed != null &&
          Number.isFinite(prev.speed)
        ) {
          merged.speed = prev.speed;
        }
        byDevice.set(p.deviceId, merged);
      }
    }
  }
  return [...byDevice.values()];
}

function snapshotPositionsToMapFormat(memPositions, now, onlineMs) {
  return memPositions.map((p) => {
    const fixMs = new Date(p.fixTime).getTime();
    const lastSeenMs = p.lastUpdate || fixMs;
    return {
      deviceId: String(p.uniqueId),
      athleteId: p.athleteId || null,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracy: p.accuracy,
      fixMs,
      fixAgeSec: Math.round((now - fixMs) / 1000),
      lastSeenAgoSec: Math.round((now - lastSeenMs) / 1000),
      online: now - lastSeenMs <= onlineMs,
      hr: p.attributes?.hr ?? p.attributes?.heartRate ?? null,
    };
  });
}

function mergeListDeviceDbTelemetry(dev, tel, batteryTel, strokeTel, motionSamples, now) {
  const rowing = dev.rowing || {};
  let strokeRate =
    strokeTel?.strokeRate ?? tel?.strokeRate ?? rowing.strokeRate ?? null;
  let strokeRateValid = strokeRate != null;
  let calibrated = rowing.calibrated ?? false;

  if (motionSamples?.length) {
    const analyzed = analyzeMotionWindow(motionSamples);
    if (analyzed?.strokeRate != null) {
      strokeRate = analyzed.strokeRate;
      strokeRateValid = true;
      calibrated = analyzed.calibrated ?? calibrated;
    }
  }

  dev.rowing = {
    ...rowing,
    capsize: false,
    tiltDeg: tel?.tiltDeg ?? rowing.tiltDeg ?? null,
    strokeRate,
    strokeRateValid,
    calibrated,
  };

  if (batteryTel) {
    dev.battery = {
      pct: batteryTel.pct,
      ageSec: Math.round((now - batteryTel.t) / 1000),
    };
  }
}

function applyRegistryGpsToDevice(device, registryFix, now) {
  if (!registryFix) return device;
  const gps = device.gps || {};
  const currentT = gps.last?.t ?? 0;
  if (registryFix.t <= currentT) return device;
  const ageSec = Math.round((now - registryFix.t) / 1000);
  return {
    ...device,
    gps: {
      ...gps,
      present: true,
      last: {
        t: registryFix.t,
        lat: registryFix.lat,
        lon: registryFix.lon,
        acc: registryFix.acc,
        ...(registryFix.spd != null ? { spd: registryFix.spd } : {}),
      },
      ageSec,
    },
  };
}

function attachRowingToMapPositions(positions, rowingByDevice) {
  for (const p of positions) {
    const rowing = rowingByDevice.get(p.deviceId);
    if (!rowing) continue;
    p.strokeRate = rowing.strokeRate;
    p.strokeRateValid = rowing.strokeRateValid;
    p.capsize = rowing.capsize;
    p.tiltDeg = rowing.tiltDeg;
  }
  return positions;
}

function forceCapsizeAlertsOnPositions(positions, alerts) {
  if (!alerts?.size) return positions;
  for (const p of positions) {
    if (alerts.has(p.deviceId)) p.capsize = true;
  }
  return positions;
}

/**
 * @param {object[]} positions
 * @param {Map<string, { samples: Sample[] }>} byDevice
 * @param {number} windowMs
 */
function attachTelemetryToMapPositions(orgId, positions, byDevice, windowMs) {
  const now = Date.now();
  for (const p of positions) {
    const entry = byDevice.get(p.deviceId);
    if (!entry) continue;
    const stats = sensorStats(entry.samples || [], windowMs, orgDeviceKey(orgId, p.deviceId));
    const hbMem = lastHeartbeatByDevice.get(orgDeviceKey(orgId, p.deviceId));
    const batFromSamples = latestBatteryFromSamples(entry.samples || []);
    const batMem = lastBatteryByDevice.get(orgDeviceKey(orgId, p.deviceId));
    const bat =
      batFromSamples && batMem
        ? batFromSamples.t >= batMem.t
          ? batFromSamples
          : batMem
        : batFromSamples || batMem || null;
    const lastHbT = Math.max(hbMem?.t ?? 0, stats.heartbeat?.lastT ?? 0);
    p.heartbeatRateHz = stats.heartbeat?.rateHz ?? 0;
    p.heartbeatAgeSec = lastHbT ? Math.round((now - lastHbT) / 1000) : null;
    if (bat) {
      p.batteryPct = bat.pct;
      p.batteryAgeSec = Math.round((now - bat.t) / 1000);
    }
  }
  return positions;
}

/**
 * @param {Map<string, { samples: Sample[] }>} byDevice
 * @param {number} windowMs
 */
function rowingMetricsByDevice(orgId, byDevice, windowMs) {
  /** @type {Map<string, object>} */
  const out = new Map();
  for (const [deviceId, entry] of byDevice) {
    const stats = sensorStats(entry.samples || [], windowMs, orgDeviceKey(orgId, deviceId));
    out.set(deviceId, stats.rowing);
  }
  return out;
}

/**
 * Dismiss capsize alert on the monitor (per device or all currently alerting).
 * @param {string} [deviceId]
 */
async function clearCapsizeAlert(orgId, deviceId) {
  const now = Date.now();
  if (deviceId) {
    const id = String(deviceId);
    setCapsizeClear(orgDeviceKey(orgId, id));
    clearStickyCapsizeAlert(orgId, id);
    if (db.hasDb()) await db.clearCapsizeAlertDb(orgId, id);
    return { cleared: [id], clearedAt: now };
  }

  // Fast path: do not call listDevices here (can 504 and leave alerts uncleared).
  const cleared = new Set();
  if (db.hasDb()) {
    try {
      const dbAlerts = await loadDbCapsizeAlerts(orgId);
      for (const id of dbAlerts.keys()) cleared.add(String(id));
    } catch (err) {
      console.error('[ingest-store] DB capsize alert list failed:', err);
    }
  }
  for (const id of getStickyCapsizeAlerts(orgId).keys()) cleared.add(String(id));
  for (const id of cleared) setCapsizeClear(orgDeviceKey(orgId, id));
  // Also mark a global org clear time for any device that might still stream tip samples.
  setCapsizeClear(orgDeviceKey(orgId, '*'));
  clearStickyCapsizeAlert(orgId);
  if (db.hasDb()) await db.clearCapsizeAlertDb(orgId);
  return { cleared: [...cleared], clearedAt: now };
}

/** Recent motion samples per device (in-memory ingest). */
function samplesByDeviceForWindow(orgId, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  /** @type {Map<string, { deviceId: string, athleteId: string|null, samples: Sample[], lastSeenMs: number }>} */
  const byDevice = new Map();
  for (const row of sessions.values()) {
    if (row.orgId !== orgId) continue;
    const sessionActive = row.updatedAt >= cutoff;
    let samples = row.samples.filter((s) => s.t >= cutoff);
    if (!samples.length && sessionActive) {
      samples = row.samples.slice(-PATH_PACE_FIX_LIMIT);
    }
    if (!samples.length) continue;
    const prev = byDevice.get(row.deviceId);
    if (!prev || row.updatedAt > prev.lastSeenMs) {
      byDevice.set(row.deviceId, {
        deviceId: row.deviceId,
        athleteId: row.athleteId || null,
        samples,
        lastSeenMs: row.updatedAt,
      });
    }
  }
  return byDevice;
}

async function getMapPositions(orgId, onlineMs, staleMs, opts = {}) {
  metrics.mapPolls++;
  const predictMode = parsePredictMode(opts.predictMode);
  const limits = predictLimitsForMode(predictMode);
  const trackOpts = { maxTrackSpeedMps: limits.maxTrackSpeedMps };
  const rowingWindowMs = Math.min(staleMs, 120000);
  // Keep map polls light - 30min x all devices was timing out on Vercel (Failed to fetch).
  const telemetryWindowMs = Math.min(rowingWindowMs, 3 * 60 * 1000);
  const now = Date.now();
  const telemetryByDevice = samplesByDeviceForWindow(orgId, telemetryWindowMs);
  const rowingByDevice = rowingMetricsByDevice(orgId, telemetryByDevice, rowingWindowMs);

  if (db.hasDb()) {
    try {
      const [registryTimes, registryPositions, rowingTel, dbCapsizeAlerts] = await Promise.all([
        db.getDeviceRegistryTimes(orgId),
        db.getRegistryMapPositions(orgId, onlineMs, staleMs),
        db.getLatestRowingTelemetry(orgId, Math.min(staleMs, 120000)),
        loadDbCapsizeAlerts(orgId),
      ]);

      const rawMerged = mergeMapPositionsPreferRegistry(
        getRawMemoryMapPositions(orgId, onlineMs, now),
        registryPositions,
        registryTimes,
        now,
        onlineMs,
      );
      await warmGpsTracksFromRecentDbFixes(orgId, telemetryWindowMs, trackOpts);
      warmGpsTracksFromSamplesByDevice(orgId, telemetryByDevice, trackOpts);
      const positions = attachSmoothMapCoords(rawMerged, predictMode, orgId);

      attachRowingToMapPositions(positions, rowingByDevice);
      for (const p of positions) {
        const tel = rowingTel.get(p.deviceId);
        // Monitor/map capsize is sticky-only.
        p.capsize = false;
        if (tel) {
          p.strokeRate = tel.strokeRate ?? p.strokeRate ?? null;
          p.tiltDeg = tel.tiltDeg ?? p.tiltDeg ?? null;
        }
      }
      forceCapsizeAlertsOnPositions(positions, dbCapsizeAlerts);
      forceCapsizeAlertsOnPositions(positions, getStickyCapsizeAlerts(orgId));
      attachTelemetryToMapPositions(orgId, positions, telemetryByDevice, rowingWindowMs);
      const [pathFixesByDevice, strokeReadingsByDevice] = await Promise.all([
        loadPathPaceFixesByDevice(orgId, PATH_PACE_WINDOW_MS, telemetryByDevice),
        loadStrokeRateReadingsByDevice(orgId, STROKE_MEDIAN_WINDOW_MS, telemetryByDevice),
      ]);
      attachPathPaceToMapPositions(positions, pathFixesByDevice, orgId);
      attachStrokeMedianToMapPositions(positions, strokeReadingsByDevice);
      return enrichMapPositionsDisplayAge(positions, now, registryTimes);
    } catch (err) {
      console.error('[ingest-store] getMapPositions DB failed:', err);
    }
  }

  const rawMerged = mergeMapPositionsByFixMs([
    getRawMemoryMapPositions(orgId, onlineMs, now),
  ]);
  await warmGpsTracksFromRecentDbFixes(orgId, telemetryWindowMs, trackOpts);
  warmGpsTracksFromSamplesByDevice(orgId, telemetryByDevice, trackOpts);
  const mapped = attachSmoothMapCoords(rawMerged, predictMode, orgId).map((p) => {
    const rowing = rowingByDevice.get(p.deviceId) || {};
    return {
      ...p,
      strokeRate: rowing.strokeRate ?? null,
      strokeRateValid: Boolean(rowing.strokeRateValid),
      capsize: Boolean(rowing.capsize),
      tiltDeg: rowing.tiltDeg ?? null,
    };
  });
  forceCapsizeAlertsOnPositions(mapped, getStickyCapsizeAlerts(orgId));
  attachTelemetryToMapPositions(orgId, mapped, telemetryByDevice, rowingWindowMs);
  const [pathFixesByDevice, strokeReadingsByDevice] = await Promise.all([
    loadPathPaceFixesByDevice(orgId, PATH_PACE_WINDOW_MS, telemetryByDevice),
    loadStrokeRateReadingsByDevice(orgId, STROKE_MEDIAN_WINDOW_MS, telemetryByDevice),
  ]);
  attachPathPaceToMapPositions(mapped, pathFixesByDevice, orgId);
  attachStrokeMedianToMapPositions(mapped, strokeReadingsByDevice);
  return enrichMapPositionsDisplayAge(mapped, now, null);
}

function getMetrics() {
  const uptimeSec = Math.max(1, Math.round((Date.now() - metrics.startedAt) / 1000));
  return {
    startedAt: metrics.startedAt,
    uptimeSec,
    requests: metrics.requests,
    duplicates: metrics.duplicates,
    droppedSamples: metrics.droppedSamples,
    persistedBatches: metrics.persistedBatches,
    persistFailures: metrics.persistFailures,
    lastPersistError: metrics.lastPersistError,
    lastPersistAt: metrics.lastPersistAt,
    mapPolls: metrics.mapPolls,
    requestRateHz: Math.round((metrics.requests / uptimeSec) * 100) / 100,
  };
}

/** Attach sticky capsize state to Traccar-shaped snapshot positions (RowSafe / overlay). */
async function enrichTraccarSnapshotCapsize(orgId, snapshot, _onlineMs) {
  if (!snapshot?.positions?.length) return snapshot;
  const capsizeAlerts = getStickyCapsizeAlerts(orgId);
  if (db.hasDb()) {
    try {
      const dbAlerts = await loadDbCapsizeAlerts(orgId);
      for (const [id, alert] of dbAlerts) capsizeAlerts.set(id, alert);
    } catch (err) {
      console.error('[ingest-store] snapshot capsize alert list failed:', err);
    }
  }
  if (!capsizeAlerts.size) return snapshot;
  const now = Date.now();
  const deviceById = new Map((snapshot.devices || []).map((d) => [d.id, d]));
  for (const p of snapshot.positions) {
    const dev = deviceById.get(p.deviceId);
    const uid = String(dev?.uniqueId || dev?.name || p.deviceName || '');
    const alert = capsizeAlerts.get(uid);
    if (!alert) continue;
    if (alert.atMs != null && now - alert.atMs > CAPSIZE_ALERT_MAX_AGE_MS) continue;
    p.attributes = {
      ...(p.attributes || {}),
      capsize: true,
      alarm: 'capsize',
      capsizeAlertAt: alert.atMs ?? null,
    };
  }
  return snapshot;
}

/** Fill snapshot speed/stroke from recent samples when DB row lacks them (RowSafe map). */
/** Fill snapshot speed from position-derived track (RowSafe / overlay). */
async function enrichTraccarSnapshotSpeed(orgId, snapshot, onlineMs) {
  if (!snapshot?.positions?.length) return snapshot;
  const windowMs = Math.min(Math.max(Number(onlineMs) || 120_000, 60_000), 180_000);
  await warmGpsTracksFromRecentDbFixes(orgId, windowMs, {
    maxTrackSpeedMps: MAX_ROWING_PREDICT_MPS,
  });
  const idToUid = new Map(
    (snapshot.devices || []).map((d) => [d.id, d.uniqueId || d.name]),
  );
  for (const p of snapshot.positions) {
    const uid = idToUid.get(p.deviceId) || p.deviceName;
    if (!uid) continue;
    const track = gpsTracks.get(orgDeviceKey(orgId, uid));
    const next = displayMapSpeedMps(p.speed, track?.speedMps);
    if (next != null && Number.isFinite(next)) p.speed = next;
  }
  return snapshot;
}

async function enrichTraccarSnapshotRowing(orgId, snapshot, onlineMs) {
  if (!snapshot?.positions?.length) return snapshot;
  const windowMs = Math.min(Math.max(Number(onlineMs) || 120_000, 60_000), 180_000);
  /** @type {Map<string, { samples: Sample[] }>} */
  let byDevice;
  if (db.hasDb()) {
    try {
      byDevice = await db.fetchRecentSamplesByDevice(orgId, windowMs);
    } catch (err) {
      console.error('[ingest-store] snapshot rowing enrich failed:', err);
      return snapshot;
    }
  } else {
    byDevice = samplesByDeviceForWindow(orgId, windowMs);
  }
  if (!byDevice?.size) return snapshot;

  const rowingByDevice = rowingMetricsByDevice(orgId, byDevice, windowMs);
  const idToUid = new Map(
    (snapshot.devices || []).map((d) => [d.id, d.uniqueId || d.name]),
  );

  for (const p of snapshot.positions) {
    const uid = idToUid.get(p.deviceId) || p.deviceName;
    if (!uid) continue;
    const attrs = p.attributes || (p.attributes = {});

    if (attrs.strokeRate == null) {
      const rowing = rowingByDevice.get(uid);
      if (rowing?.strokeRate != null) attrs.strokeRate = rowing.strokeRate;
    }

  }
  return snapshot;
}

async function getTraccarSnapshot(orgId, onlineMs = 120000) {
  let snapshot;
  if (db.hasDb()) {
    try {
      snapshot = await db.getTraccarSnapshot(orgId, onlineMs);
    } catch (err) {
      console.error('[ingest-store] DB snapshot failed:', err);
    }
  }
  if (!snapshot) {
    const mem = getPositionsSnapshot(orgId, onlineMs);
    const devices = mem.positions.map((p, i) => ({
      id: i + 1,
      name: p.uniqueId,
      uniqueId: p.uniqueId,
      status: p.online ? 'online' : 'offline',
    }));
    const positions = mem.positions.map((p, i) => ({
      id: i + 1,
      deviceId: i + 1,
      latitude: p.latitude,
      longitude: p.longitude,
      altitude: p.altitude || 0,
      speed: p.speed || 0,
      course: p.course || 0,
      accuracy: p.accuracy || 0,
      fixTime: p.fixTime,
      deviceTime: p.deviceTime,
      serverTime: p.fixTime,
      attributes: p.attributes || {},
      deviceName: p.uniqueId,
    }));
    snapshot = { devices, positions, geofences: [], groups: [] };
  }
  snapshot = await enrichTraccarSnapshotSpeed(orgId, snapshot, onlineMs);
  snapshot = await enrichTraccarSnapshotRowing(orgId, snapshot, onlineMs);
  return enrichTraccarSnapshotCapsize(orgId, snapshot, onlineMs);
}

async function getRouteHistory(orgId, deviceIdParam, uniqueIdParam, fromIso, toIso) {
  if (db.hasDb()) {
    const dev = await db.resolveDevice(orgId, deviceIdParam, uniqueIdParam);
    if (!dev) return [];
    return db.getRoutePositions(orgId, dev.id, fromIso, toIso);
  }
  return [];
}

async function listSessionsHistory(orgId, uniqueId) {
  if (!db.hasDb()) return [];
  try {
    return await db.listSessions(orgId, uniqueId, 80);
  } catch (err) {
    console.error('[ingest-store] listSessions failed:', err);
    return [];
  }
}

async function getLogbook(orgId, opts = {}) {
  if (!db.hasDb()) return { timeZone: opts.timeZone || 'Pacific/Auckland', days: [] };
  try {
    return await db.getLogbook(orgId, opts);
  } catch (err) {
    console.error('[ingest-store] getLogbook failed:', err);
    throw err;
  }
}

async function listHistoryDevices(orgId) {
  if (!db.hasDb()) return [];
  try {
    return await db.listHistoryDevicesDetailed(orgId);
  } catch (err) {
    console.error('[ingest-store] listHistoryDevices failed:', err);
    return [];
  }
}

async function getDashboardHistory(orgId, uniqueId, fromIso, toIso) {
  if (!db.hasDb()) return null;
  try {
    return await db.getDashboardHistory(orgId, uniqueId, fromIso, toIso);
  } catch (err) {
    console.error('[ingest-store] getDashboardHistory failed:', err);
    return null;
  }
}

async function getDashboardHistoryBySession(orgId, sessionId) {
  if (!db.hasDb()) return null;
  try {
    return await db.getDashboardHistoryBySession(orgId, sessionId);
  } catch (err) {
    console.error('[ingest-store] getDashboardHistoryBySession failed:', err);
    return null;
  }
}

function purgeMemorySession(orgId, sessionId) {
  sessions.delete(orgSessionKey(orgId, String(sessionId)));
}

function purgeMemoryDevice(orgId, deviceId) {
  const id = String(deviceId);
  for (const [key, row] of sessions.entries()) {
    if (row.orgId === orgId && row.deviceId === id) sessions.delete(key);
  }
}

function purgeOrgMemory(orgId) {
  for (const [key, row] of sessions.entries()) {
    if (row.orgId === orgId) sessions.delete(key);
  }
  const prefix = `${orgId}:`;
  for (const key of [...capsizeClearAt.keys()]) {
    if (key.startsWith(prefix)) capsizeClearAt.delete(key);
  }
  for (const key of [...stickyCapsizeByDevice.keys()]) {
    if (key.startsWith(prefix)) stickyCapsizeByDevice.delete(key);
  }
  for (const key of [...gpsTracks.keys()]) {
    if (key.startsWith(prefix)) gpsTracks.delete(key);
  }
  for (const key of [...lastHeartbeatByDevice.keys()]) {
    if (key.startsWith(prefix)) lastHeartbeatByDevice.delete(key);
  }
  for (const key of [...lastBatteryByDevice.keys()]) {
    if (key.startsWith(prefix)) lastBatteryByDevice.delete(key);
  }
}

async function getStorageStats(orgId) {
  if (!db.hasDb()) return null;
  try {
    return await db.getStorageStats(orgId);
  } catch (err) {
    console.error('[ingest-store] getStorageStats failed:', err);
    return null;
  }
}

async function deleteStoredSession(orgId, sessionId) {
  if (!db.hasDb()) return null;
  const result = await db.deleteSession(orgId, sessionId);
  purgeMemorySession(orgId, sessionId);
  return result;
}

async function deleteStoredDevice(orgId, uniqueId) {
  if (!db.hasDb()) return null;
  const result = await db.deleteDeviceData(orgId, uniqueId);
  purgeMemoryDevice(orgId, uniqueId);
  capsizeClearAt.delete(orgDeviceKey(orgId, uniqueId));
  stickyCapsizeByDevice.delete(orgDeviceKey(orgId, uniqueId));
  return result;
}

async function deleteStoredRange(orgId, uniqueId, fromIso, toIso) {
  if (!db.hasDb()) return null;
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error('Invalid from/to dates');
  }
  return db.deleteSamplesInRange(orgId, uniqueId, fromMs, toMs);
}

async function deleteAllStoredData(orgId) {
  if (!db.hasDb()) return null;
  const result = await db.deleteAllStoredData(orgId);
  purgeOrgMemory(orgId);
  return result;
}

function getDataSecurityInfo() {
  const tokenRequired = Boolean(process.env.INGEST_TOKEN || process.env.ORG_TOKENS);
  return {
    provider: 'Vercel Postgres (Neon)',
    transport: 'HTTPS (TLS) between phones, dashboard, and API',
    atRest:
      'Encrypted at rest by the cloud provider (Neon/Vercel managed Postgres)',
    accessControl: tokenRequired
      ? 'Each rowing club has its own ingest token — fleet data is scoped by org'
      : 'WARNING: No org tokens configured — anyone who knows the API URL can upload or delete data',
    dashboardAccess:
      'This page stores your token in browser localStorage on this computer only',
    retention:
      'No automatic expiry — data stays until you delete it here or in the Neon SQL editor',
    irreversible: 'Deletes are permanent and cannot be undone',
    liveCache:
      'The monitor also keeps short-lived in-memory samples for live maps; deletes clear matching live cache',
    recommendations: [
      'Set ORG_TOKENS or INGEST_TOKEN in Vercel project settings',
      'Give each club its own token — they only see their fleet',
      'Use device-specific deletes when possible instead of delete all',
      'Review Neon/Vercel project access (who can open the database console)',
    ],
    tokenRequired,
    multiTenant: true,
  };
}

async function resolveOrg(req) {
  return resolveOrgFromRequest(req);
}

async function checkAuth(req) {
  const org = await resolveOrg(req);
  return Boolean(org);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = {
  MAX_SAMPLES_PER_REQUEST,
  recordBatch,
  endSession,
  getSession,
  listDevices,
  getPositionsSnapshot,
  getTraccarSnapshot,
  getMapPositions,
  parsePredictMode,
  getRouteHistory,
  listSessionsHistory,
  getLogbook,
  listHistoryDevices,
  getDashboardHistory,
  getDashboardHistoryBySession,
  clearCapsizeAlert,
  getStorageStats,
  deleteStoredSession,
  deleteStoredDevice,
  deleteStoredRange,
  deleteAllStoredData,
  getDataSecurityInfo,
  getMetrics,
  checkAuth,
  resolveOrg,
  cors,
  hasDb: db.hasDb,
  listGeofences: (orgId) => db.listGeofences(orgId),
  createGeofence: (orgId, body) => db.createGeofence(orgId, body),
  updateGeofenceSettings: (orgId, id, body) => db.updateGeofenceSettings(orgId, id, body),
  deleteGeofence: (orgId, id) => db.deleteGeofence(orgId, id),
  listTimingLines: (orgId) => db.listTimingLines(orgId),
  createTimingLine: (orgId, body) => db.createTimingLine(orgId, body),
  generateTimingSplitCourse: (orgId, body) => db.generateTimingSplitCourse(orgId, body),
  updateTimingLine: (orgId, id, body) => db.updateTimingLine(orgId, id, body),
  deleteTimingLine: (orgId, id) => db.deleteTimingLine(orgId, id),
  deleteTimingCourseGroup: (orgId, courseGroup) => db.deleteTimingCourseGroup(orgId, courseGroup),
  getActiveRegattaMessage: (orgId, deviceId) => db.getActiveRegattaMessage(orgId, deviceId),
  listActiveRegattaMessages: (orgId) => db.listActiveRegattaMessages(orgId),
  setRegattaMessage: (orgId, deviceId, text) => db.setRegattaMessage(orgId, deviceId, text),
  broadcastRegattaMessage: (orgId, text, deviceIds) =>
    db.broadcastRegattaMessage(orgId, text, deviceIds),
  clearRegattaMessage: (orgId, deviceId) => db.clearRegattaMessage(orgId, deviceId),
  createOrg: (slug, name, token) => db.createOrg(slug, name, token),
  listOrgs: () => db.listOrgs(),
};
