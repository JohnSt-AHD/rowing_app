const db = require('./db');
const { analyzeMotionWindow } = require('./motion-analysis');

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

/**
 * @typedef {{ t: number, gps?: object, motion?: object, hr?: object, derived?: object }} Sample
 * @typedef {{
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
    speedMps: fix.spd,
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
      speedMps: fix.spd ?? prev.speedMps,
      courseDeg: resolveMapHeading(fix) ?? prev.courseDeg,
    });
    return true;
  }

  const jumpM = distanceMeters(fix.lat, fix.lon, prev.lat, prev.lon);
  if (jumpM / dtSec > maxTrackSpeedMps) {
    gpsTracks.set(key, resetGpsSmoothState(fix));
    return true;
  }

  let speedMps = jumpM / dtSec;
  let courseDeg = bearingDeg(prev.lat, prev.lon, fix.lat, fix.lon);
  if (fix.spd != null && Number.isFinite(fix.spd)) {
    speedMps = prev.speedMps != null ? 0.35 * speedMps + 0.65 * fix.spd : fix.spd;
  }
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

/** Replay recent GPS samples so map polls warm the filter (serverless-safe). */
function warmGpsTracksFromSamplesByDevice(byDevice, opts = {}) {
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
    for (const s of entry.samples || []) {
      if (!s?.gps) continue;
      const fix = gpsFromSample(s, { forTrack: true });
      if (fix) updateGpsTrack(deviceId, fix, trackOpts);
    }
  }
}

/**
 * Attach smoothed coords; primary lat/lon stay raw for map colour markers.
 * Overlay uses last fix + bounded velocity extrapolation to now (when moving).
 * @param {object[]} rawPositions
 * @param {'rowing' | 'car'} [predictMode]
 */
function attachSmoothMapCoords(rawPositions, predictMode = 'rowing') {
  const limits = predictLimitsForMode(parsePredictMode(predictMode));
  const now = Date.now();
  return rawPositions.map((p) => {
    const track = gpsTracks.get(String(p.deviceId));
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
      speed:
        p.speed ??
        (track?.speedMps != null && Number.isFinite(track.speedMps)
          ? Math.max(0, track.speedMps)
          : null),
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
async function recordBatch(sessionId, deviceId, athleteId, samples, idempotencyKey) {
  metrics.requests++;
  const dedupeKey = idempotencyKey ? String(idempotencyKey) : '';
  const now = Date.now();
  pruneIdempotency(now);
  if (dedupeKey && db.hasDb()) {
    try {
      const dbCached = await db.getIdempotency(dedupeKey, IDEMPOTENCY_TTL_MS);
      if (dbCached) {
        metrics.duplicates++;
        recentIdempotency.set(dedupeKey, { t: now, result: dbCached });
        return { ...dbCached, duplicate: true };
      }
    } catch (err) {
      console.error('[ingest-store] DB idempotency read failed:', err);
    }
  }
  if (dedupeKey) {
    const cached = recentIdempotency.get(dedupeKey);
    if (cached && now - cached.t <= IDEMPOTENCY_TTL_MS) {
      metrics.duplicates++;
      return { ...cached.result, duplicate: true };
    }
  }
  if (!samples.length) return { received: 0 };
  const clean = sanitizeAndTrackSamples(deviceId, samples);
  if (!clean.samples.length) {
    metrics.droppedSamples += clean.dropped || 0;
    return { received: 0, dropped: clean.dropped };
  }
  metrics.droppedSamples += clean.dropped || 0;

  const key = String(sessionId);
  let row = sessions.get(key);
  if (!row) {
    row = {
      deviceId: String(deviceId),
      athleteId: athleteId ? String(athleteId) : undefined,
      samples: [],
      updatedAt: now,
      firstSeenAt: now,
    };
    sessions.set(key, row);
  }

  row.deviceId = String(deviceId);
  if (athleteId) row.athleteId = String(athleteId);
  row.samples.push(...clean.samples);
  row.updatedAt = now;
  noteDeviceTelemetry(deviceId, clean.samples);
  trimSampleRing(row);
  trimSessions();

  let persisted = false;
  let persistError = null;
  try {
    if (db.hasDb()) {
      persisted = await db.persistBatch(
        sessionId,
        deviceId,
        athleteId,
        clean.samples,
      );
      if (persisted) {
        metrics.persistedBatches++;
        metrics.lastPersistAt = now;
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
    total: row.samples.length,
    persisted,
    persistError,
  };
  if (dedupeKey) {
    recentIdempotency.set(dedupeKey, { t: now, result });
    if (db.hasDb()) {
      try {
        await db.setIdempotency(dedupeKey, result);
      } catch (err) {
        console.error('[ingest-store] DB idempotency write failed:', err);
      }
    }
  }
  return result;
}

/**
 * @param {string} sessionId
 */
async function getSession(sessionId) {
  if (db.hasDb()) {
    try {
      const fromDb = await db.getSessionFromDb(sessionId);
      if (fromDb) return fromDb;
    } catch (err) {
      console.error('[ingest-store] DB getSession failed:', err);
    }
  }
  const row = sessions.get(String(sessionId));
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
  return {
    ...p,
    ingestAgoSec,
    displayFixAgeSec,
  };
}

function enrichMapPositionsDisplayAge(positions, now, registryTimes) {
  return positions.map((p) =>
    enrichMapPositionDisplayAge(p, now, registryTimes?.get(p.deviceId)),
  );
}

function buildDeviceEntry(entry, windowMs, onlineMs, now, registryTimes) {
  const stats = sensorStats(entry.samples, windowMs, entry.deviceId);
  const sampleLastSeenMs = entry.lastSeenMs ?? entry.updatedAt ?? now;
  const lastIngestMs = registryTimes?.lastSeenMs ?? 0;
  const lastSeenMs = Math.max(sampleLastSeenMs, lastIngestMs);
  const online = now - lastSeenMs <= onlineMs;
  const hbMem = lastHeartbeatByDevice.get(entry.deviceId);
  const batFromSamples = latestBatteryFromSamples(entry.samples || []);
  const batMem = lastBatteryByDevice.get(entry.deviceId);
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

/**
 * @param {{ windowMs?: number, onlineMs?: number }} [opts]
 */
function listDevicesFromMemory(opts = {}) {
  const windowMs = opts.windowMs ?? 60000;
  const onlineMs = opts.onlineMs ?? 30000;
  const now = Date.now();
  const byDevice = new Map();

  for (const [sessionId, row] of sessions) {
    const built = buildDeviceEntry(
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
 * @param {{ windowMs?: number, onlineMs?: number }} [opts]
 */
async function listDevices(opts = {}) {
  const windowMs = opts.windowMs ?? 60000;
  const onlineMs = opts.onlineMs ?? 30000;
  const now = Date.now();
  const hasPostgres = db.hasDb();

  /** @type {Map<string, object>} */
  const byDevice = listDevicesFromMemory(opts);

  let storage = hasPostgres ? 'postgres' : 'memory';
  let warning = hasPostgres
    ? null
    : 'No database configured — monitor only sees data on the same server instance. Add POSTGRES_URL in Vercel and redeploy.';

  if (hasPostgres) {
    try {
      const fetchMs = Math.max(windowMs, 30 * 60 * 1000);
      const [fromDb, registryGps, registryTimes] = await Promise.all([
        db.fetchRecentSamplesByDevice(fetchMs),
        db.getRegistryGpsByDevice(),
        db.getDeviceRegistryTimes(),
      ]);
      for (const entry of fromDb.values()) {
        const built = buildDeviceEntry(
          entry,
          windowMs,
          onlineMs,
          now,
          registryTimes.get(entry.deviceId),
        );
        const prev = byDevice.get(entry.deviceId);
        const patched = applyRegistryGpsToDevice(
          built,
          registryGps.get(entry.deviceId),
          now,
        );
        if (!prev || patched.lastSeenMs > prev.lastSeenMs) {
          byDevice.set(entry.deviceId, patched);
        }
      }
      for (const [deviceId, regFix] of registryGps) {
        if (byDevice.has(deviceId)) continue;
        const patched = applyRegistryGpsToDevice(
          buildDeviceEntry(
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
                  },
                },
              ],
              lastSeenMs: regFix.t,
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
      for (const [deviceId, dev] of byDevice) {
        const regFix = registryGps.get(deviceId);
        if (regFix) {
          byDevice.set(deviceId, applyRegistryGpsToDevice(dev, regFix, now));
        }
      }
      warning = null;
    } catch (err) {
      console.error('[ingest-store] listDevices DB failed:', err);
      storage = 'memory';
      warning = `Database read failed: ${err.message}`;
    }
  }

  const devices = [...byDevice.values()].sort(
    (a, b) => b.lastSeenMs - a.lastSeenMs,
  );
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

function getPositionsSnapshot(onlineMs = 30000) {
  const now = Date.now();
  /** @type {Map<string, object>} */
  const byDevice = new Map();

  for (const [sessionId, row] of sessions) {
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

function getRawMemoryMapPositions(onlineMs, now) {
  const out = [];
  for (const row of sessions.values()) {
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

/** @param {object[][]} positionGroups later groups win on equal fixMs */
function mergeMapPositionsByFixMs(positionGroups) {
  /** @type {Map<string, object>} */
  const byDevice = new Map();
  for (const group of positionGroups) {
    for (const p of group) {
      if (p.latitude == null || p.longitude == null) continue;
      const prev = byDevice.get(p.deviceId);
      if (!prev || (p.fixMs ?? 0) >= (prev.fixMs ?? 0)) {
        byDevice.set(p.deviceId, p);
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

/**
 * @param {object[]} positions
 * @param {Map<string, { samples: Sample[] }>} byDevice
 * @param {number} windowMs
 */
function attachTelemetryToMapPositions(positions, byDevice, windowMs) {
  const now = Date.now();
  for (const p of positions) {
    const entry = byDevice.get(p.deviceId);
    if (!entry) continue;
    const stats = sensorStats(entry.samples || [], windowMs, p.deviceId);
    const hbMem = lastHeartbeatByDevice.get(p.deviceId);
    const batFromSamples = latestBatteryFromSamples(entry.samples || []);
    const batMem = lastBatteryByDevice.get(p.deviceId);
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
function rowingMetricsByDevice(byDevice, windowMs) {
  /** @type {Map<string, object>} */
  const out = new Map();
  for (const [deviceId, entry] of byDevice) {
    const stats = sensorStats(entry.samples || [], windowMs, deviceId);
    out.set(deviceId, stats.rowing);
  }
  return out;
}

/**
 * Dismiss capsize alert on the monitor (per device or all currently alerting).
 * @param {string} [deviceId]
 */
async function clearCapsizeAlert(deviceId) {
  const now = Date.now();
  if (deviceId) {
    setCapsizeClear(deviceId);
    return { cleared: [String(deviceId)], clearedAt: now };
  }
  const snapshot = await listDevices({
    windowMs: 120000,
    onlineMs: 24 * 60 * 60 * 1000,
  });
  const capsized = (snapshot.devices || [])
    .filter((d) => d.rowing?.capsize)
    .map((d) => d.deviceId);
  for (const id of capsized) setCapsizeClear(id);
  return { cleared: capsized, clearedAt: now };
}

/** Recent motion samples per device (in-memory ingest). */
function samplesByDeviceForWindow(windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  /** @type {Map<string, { samples: Sample[] }>} */
  const byDevice = new Map();
  for (const row of sessions.values()) {
    const samples = row.samples.filter((s) => s.t >= cutoff);
    if (!samples.length) continue;
    const prev = byDevice.get(row.deviceId);
    if (!prev || row.updatedAt > prev.lastSeenMs) {
      byDevice.set(row.deviceId, { samples, lastSeenMs: row.updatedAt });
    }
  }
  return byDevice;
}

async function getMapPositions(onlineMs, staleMs, opts = {}) {
  metrics.mapPolls++;
  const predictMode = parsePredictMode(opts.predictMode);
  const limits = predictLimitsForMode(predictMode);
  const trackOpts = { maxTrackSpeedMps: limits.maxTrackSpeedMps };
  const rowingWindowMs = Math.min(staleMs, 120000);
  const telemetryWindowMs = Math.max(rowingWindowMs, 30 * 60 * 1000);
  const now = Date.now();

  if (db.hasDb()) {
    try {
      const registryTimes = await db.getDeviceRegistryTimes();
      const registryPositions = await db.getRegistryMapPositions(onlineMs, staleMs);
      const dbPositions = await db.getMapPositions(onlineMs, staleMs);
      const byDevice = await db.fetchRecentSamplesByDevice(telemetryWindowMs);

      const fromRecentRaw = [];
      for (const entry of byDevice.values()) {
        const lastGps = latestGpsFromSamples(entry.samples || []);
        if (!lastGps) continue;
        fromRecentRaw.push(
          buildRawMapPositionFromFix({
            deviceId: entry.deviceId,
            fix: lastGps,
            lastSeenMs: entry.lastSeenMs,
            online: now - entry.lastSeenMs <= onlineMs,
            now,
            athleteId: entry.athleteId,
          }),
        );
      }

      const rawMerged = mergeMapPositionsByFixMs([
        dbPositions,
        fromRecentRaw,
        getRawMemoryMapPositions(onlineMs, now),
        registryPositions,
      ]);
      warmGpsTracksFromSamplesByDevice(byDevice, trackOpts);
      const positions = attachSmoothMapCoords(rawMerged, predictMode);

      attachRowingToMapPositions(
        positions,
        rowingMetricsByDevice(byDevice, rowingWindowMs),
      );
      attachTelemetryToMapPositions(positions, byDevice, rowingWindowMs);
      return enrichMapPositionsDisplayAge(positions, now, registryTimes);
    } catch (err) {
      console.error('[ingest-store] getMapPositions DB failed:', err);
    }
  }

  const telemetryByDevice = samplesByDeviceForWindow(telemetryWindowMs);
  const rowingByDevice = rowingMetricsByDevice(telemetryByDevice, rowingWindowMs);

  const rawMerged = mergeMapPositionsByFixMs([
    getRawMemoryMapPositions(onlineMs, now),
  ]);
  warmGpsTracksFromSamplesByDevice(telemetryByDevice, trackOpts);
  const mapped = attachSmoothMapCoords(rawMerged, predictMode).map((p) => {
    const rowing = rowingByDevice.get(p.deviceId) || {};
    return {
      ...p,
      strokeRate: rowing.strokeRate ?? null,
      strokeRateValid: Boolean(rowing.strokeRateValid),
      capsize: Boolean(rowing.capsize),
      tiltDeg: rowing.tiltDeg ?? null,
    };
  });
  return enrichMapPositionsDisplayAge(
    attachTelemetryToMapPositions(mapped, telemetryByDevice, rowingWindowMs),
    now,
    null,
  );
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

async function getTraccarSnapshot(onlineMs = 120000) {
  if (db.hasDb()) {
    try {
      return await db.getTraccarSnapshot(onlineMs);
    } catch (err) {
      console.error('[ingest-store] DB snapshot failed:', err);
    }
  }
  const mem = getPositionsSnapshot(onlineMs);
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
  return { devices, positions, geofences: [], groups: [] };
}

async function getRouteHistory(deviceIdParam, uniqueIdParam, fromIso, toIso) {
  if (db.hasDb()) {
    const dev = await db.resolveDevice(deviceIdParam, uniqueIdParam);
    if (!dev) return [];
    return db.getRoutePositions(dev.id, fromIso, toIso);
  }
  return [];
}

async function listSessionsHistory(uniqueId) {
  if (!db.hasDb()) return [];
  try {
    return await db.listSessions(uniqueId, 80);
  } catch (err) {
    console.error('[ingest-store] listSessions failed:', err);
    return [];
  }
}

async function listHistoryDevices() {
  if (!db.hasDb()) return [];
  try {
    return await db.listHistoryDevicesDetailed();
  } catch (err) {
    console.error('[ingest-store] listHistoryDevices failed:', err);
    return [];
  }
}

async function getDashboardHistory(uniqueId, fromIso, toIso) {
  if (!db.hasDb()) return null;
  try {
    return await db.getDashboardHistory(uniqueId, fromIso, toIso);
  } catch (err) {
    console.error('[ingest-store] getDashboardHistory failed:', err);
    return null;
  }
}

async function getDashboardHistoryBySession(sessionId) {
  if (!db.hasDb()) return null;
  try {
    return await db.getDashboardHistoryBySession(sessionId);
  } catch (err) {
    console.error('[ingest-store] getDashboardHistoryBySession failed:', err);
    return null;
  }
}

function purgeMemorySession(sessionId) {
  sessions.delete(String(sessionId));
}

function purgeMemoryDevice(deviceId) {
  const id = String(deviceId);
  for (const [key, row] of sessions.entries()) {
    if (row.deviceId === id) sessions.delete(key);
  }
}

function purgeAllMemory() {
  sessions.clear();
  capsizeClearAt.clear();
}

async function getStorageStats() {
  if (!db.hasDb()) return null;
  try {
    return await db.getStorageStats();
  } catch (err) {
    console.error('[ingest-store] getStorageStats failed:', err);
    return null;
  }
}

async function deleteStoredSession(sessionId) {
  if (!db.hasDb()) return null;
  const result = await db.deleteSession(sessionId);
  purgeMemorySession(sessionId);
  return result;
}

async function deleteStoredDevice(uniqueId) {
  if (!db.hasDb()) return null;
  const result = await db.deleteDeviceData(uniqueId);
  purgeMemoryDevice(uniqueId);
  capsizeClearAt.delete(String(uniqueId));
  return result;
}

async function deleteStoredRange(uniqueId, fromIso, toIso) {
  if (!db.hasDb()) return null;
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error('Invalid from/to dates');
  }
  return db.deleteSamplesInRange(uniqueId, fromMs, toMs);
}

async function deleteAllStoredData() {
  if (!db.hasDb()) return null;
  const result = await db.deleteAllStoredData();
  purgeAllMemory();
  return result;
}

function getDataSecurityInfo() {
  const tokenRequired = Boolean(process.env.INGEST_TOKEN);
  return {
    provider: 'Vercel Postgres (Neon)',
    transport: 'HTTPS (TLS) between phones, dashboard, and API',
    atRest:
      'Encrypted at rest by the cloud provider (Neon/Vercel managed Postgres)',
    accessControl: tokenRequired
      ? 'Writes and deletes require INGEST_TOKEN (Bearer) — same token as phones and this dashboard'
      : 'WARNING: INGEST_TOKEN is not set on Vercel — anyone who knows the API URL can upload or delete data',
    dashboardAccess:
      'This page stores your token in browser localStorage on this computer only',
    retention:
      'No automatic expiry — data stays until you delete it here or in the Neon SQL editor',
    irreversible: 'Deletes are permanent and cannot be undone',
    liveCache:
      'The monitor also keeps short-lived in-memory samples for live maps; deletes clear matching live cache',
    recommendations: [
      'Set a long random INGEST_TOKEN in Vercel project settings',
      'Only share the token with trusted coaches and admins',
      'Use device-specific deletes when possible instead of delete all',
      'Review Neon/Vercel project access (who can open the database console)',
    ],
    tokenRequired,
  };
}

function checkAuth(req) {
  const expected = process.env.INGEST_TOKEN || '';
  if (!expected) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const q = req.query?.token;
  return token === expected || q === expected;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = {
  MAX_SAMPLES_PER_REQUEST,
  recordBatch,
  getSession,
  listDevices,
  getPositionsSnapshot,
  getTraccarSnapshot,
  getMapPositions,
  parsePredictMode,
  getRouteHistory,
  listSessionsHistory,
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
  cors,
  hasDb: db.hasDb,
  listGeofences: () => db.listGeofences(),
  createGeofence: (body) => db.createGeofence(body),
  deleteGeofence: (id) => db.deleteGeofence(id),
  getActiveRegattaMessage: (deviceId) => db.getActiveRegattaMessage(deviceId),
  listActiveRegattaMessages: () => db.listActiveRegattaMessages(),
  setRegattaMessage: (deviceId, text) => db.setRegattaMessage(deviceId, text),
  broadcastRegattaMessage: (text, deviceIds) => db.broadcastRegattaMessage(text, deviceIds),
  clearRegattaMessage: (deviceId) => db.clearRegattaMessage(deviceId),
};
