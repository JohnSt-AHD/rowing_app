'use strict';

/** Valid rowing stroke rate range (strokes per minute). */
const MIN_SPM = 15;
const MAX_SPM = 50;

const DEFAULTS = {
  bufferMs: 8000,
  gravityAlpha: 0.04,
  /** Min samples in calibrateWindowMs while still (works at ~1 Hz when screen off). */
  calibrateMinSamples: 5,
  /** Upright calibration window — time-based so GPS-poll motion still calibrates. */
  calibrateWindowMs: 2500,
  stillVarianceMax: 0.35,
  /** Dot product with upright gravity below this = capsize (~99° when -0.15). */
  capsizeDotThreshold: -0.15,
  capsizeHoldMs: 2500,
  capsizeClearDot: 0.55,
  capsizeClearHoldMs: 1000,
  /**
   * High-pass window for surge. Slightly longer than a typical catch→finish
   * micro-dip so drive double-peaks are smoothed without erasing the catch check.
   */
  hpWindowMs: 550,
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function mag3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function norm3(x, y, z) {
  const m = mag3(x, y, z);
  if (m < 1e-6) return { x: 0, y: 0, z: 1 };
  return { x: x / m, y: y / m, z: z / m };
}

function dot3(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const varSum = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return Math.sqrt(varSum / values.length);
}

function movingAverage(values, centerIdx, radius) {
  let sum = 0;
  let n = 0;
  for (let i = centerIdx - radius; i <= centerIdx + radius; i++) {
    if (i >= 0 && i < values.length) {
      sum += values[i];
      n++;
    }
  }
  return n ? sum / n : values[centerIdx];
}

/**
 * Collect extrema of one polarity with refractory merging.
 * @param {number[]} hp high-pass surge samples
 * @param {number[]} times sample times (ms)
 * @param {number} minProminence
 * @param {number} minIntervalMs
 * @param {'peak'|'valley'} kind
 * @returns {{ t: number, v: number }[]}
 */
function collectExtrema(hp, times, minProminence, minIntervalMs, kind) {
  /** @type {{ t: number, v: number }[]} */
  const out = [];
  for (let i = 2; i < hp.length - 2; i++) {
    const v = hp[i];
    const isExt =
      kind === 'peak'
        ? v >= hp[i - 1] && v >= hp[i + 1] && v >= hp[i - 2] && v >= hp[i + 2]
        : v <= hp[i - 1] && v <= hp[i + 1] && v <= hp[i - 2] && v <= hp[i + 2];
    if (!isExt) continue;
    if (kind === 'peak' ? v < minProminence : v > -minProminence) continue;

    const last = out[out.length - 1];
    if (last && times[i] - last.t < minIntervalMs) {
      const stronger = kind === 'peak' ? v > last.v : v < last.v;
      if (stronger) out[out.length - 1] = { t: times[i], v };
      continue;
    }
    out.push({ t: times[i], v });
  }
  return out;
}

/**
 * SPM of one full stroke cycle from the autocorrelation of high-pass surge.
 *
 * A rowing stroke has two acceleration bumps (catch and finish, or the drive
 * double-peak). The gap between every other bump is ~2× the neighbor gap for
 * any steady rhythm, so a half-stroke test cannot tell one bump per stroke
 * from two. Keeping both bumps reports about 2× SPM; deleting every other
 * bump reports about half.
 *
 * The repeat period of the waveform is one stroke. If a peak at about twice
 * that period is only slightly stronger, it is two strokes — use the half lag.
 * A weak half-lag sidelobe (the extra bump inside one stroke) is ignored, so
 * a 20 spm rhythm is not reported as 40.
 *
 * @param {number[]} hp
 * @param {number[]} times
 * @param {number} minSpm
 * @param {number} maxSpm
 * @returns {number|null}
 */
function estimateStrokeSpm(hp, times, minSpm, maxSpm) {
  const n = hp.length;
  if (n < 30) return null;
  const dt = (times[n - 1] - times[0]) / (n - 1);
  if (!(dt > 0)) return null;
  // Need about two strokes at 20 spm before a half-cycle can outvote the real one.
  if (times[n - 1] - times[0] < 5500) return null;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += hp[i];
  mean /= n;

  const x = new Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = hp[i] - mean;
    energy += x[i] * x[i];
  }
  if (energy < 1e-3) return null;

  const minLag = Math.max(2, Math.round(60000 / maxSpm / dt));
  const maxLag = Math.min(n - 4, Math.round(60000 / minSpm / dt));
  if (maxLag <= minLag + 2) return null;

  const corr = new Float64Array(maxLag + 1);
  let gMax = -Infinity;
  let gLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) c += x[i] * x[i + lag];
    c /= m;
    corr[lag] = c;
    if (c > gMax) {
      gMax = c;
      gLag = lag;
    }
  }

  const denom = energy / n;
  const gNorm = gMax / denom;
  if (gNorm < 0.22) return null;

  let chosen = gLag;
  const halfLo = gLag * 0.42;
  const halfHi = gLag * 0.58;
  let bestHalf = -1;
  let bestHalfN = -1;
  for (let lag = minLag + 1; lag <= maxLag - 1; lag++) {
    if (lag < halfLo || lag > halfHi) continue;
    if (corr[lag] < corr[lag - 1] || corr[lag] < corr[lag + 1]) continue;
    const nn = corr[lag] / denom;
    if (nn > bestHalfN) {
      bestHalfN = nn;
      bestHalf = lag;
    }
  }
  let usedHalf = false;
  if (bestHalf > 0 && bestHalfN >= 0.35 && bestHalfN >= gNorm - 0.13) {
    chosen = bestHalf;
    usedHalf = true;
  }
  // Two lags can tie when one is a single stroke and one is a stretched repeat
  // that is not exactly double. Prefer the shorter real cycle.
  if (!usedHalf) {
    for (let lag = minLag + 1; lag < gLag; lag++) {
      if (corr[lag] < corr[lag - 1] || corr[lag] < corr[lag + 1]) continue;
      const nn = corr[lag] / denom;
      if (nn < 0.3 || nn < gNorm - 0.05) continue;
      chosen = lag;
      break;
    }
  }

  let lagF = chosen;
  if (chosen > minLag && chosen < maxLag) {
    const y0 = corr[chosen - 1];
    const y1 = corr[chosen];
    const y2 = corr[chosen + 1];
    const denomLag = y0 - 2 * y1 + y2;
    if (denomLag !== 0) {
      const delta = (0.5 * (y0 - y2)) / denomLag;
      if (delta > -1 && delta < 1) lagF = chosen + delta;
    }
  }

  const spm = Math.round((60000 / (lagF * dt)) * 10) / 10;
  if (spm < minSpm || spm > maxSpm) return null;
  return spm;
}

/**
 * Collapse bumps that belong to the same stroke so a debug plot shows one
 * marker per cycle.
 * @param {{ t: number, v: number }[]} events
 * @param {number} periodMs
 */
function keepOneMarkerPerCycle(events, periodMs) {
  if (!periodMs || events.length < 2) return events;
  const minGap = periodMs * 0.65;
  /** @type {{ t: number, v: number }[]} */
  const out = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (!last || e.t - last.t >= minGap) {
      out.push(e);
      continue;
    }
    if (Math.abs(e.v) > Math.abs(last.v)) out[out.length - 1] = e;
  }
  return out;
}

/**
 * Streaming motion analyzer for rowing surge (stroke rate) and capsize detection.
 * Expects DeviceMotion accelerationIncludingGravity in m/s².
 */
class MotionAnalyzer {
  /**
   * @param {Partial<typeof DEFAULTS> & { minSpm?: number, maxSpm?: number }} [opts]
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.minSpm = opts.minSpm ?? MIN_SPM;
    this.maxSpm = opts.maxSpm ?? MAX_SPM;
    this.minPeakIntervalMs = 60000 / this.maxSpm;
    this.maxPeakIntervalMs = 60000 / this.minSpm;

    /** @type {{ t: number, ax: number, ay: number, az: number }[]} */
    this.buffer = [];
    this.gx = 0;
    this.gy = 0;
    this.gz = 9.81;
    this.sampleCount = 0;
    this.calibrated = false;
    /** @type {{ x: number, y: number, z: number }} */
    this.upright = { x: 0, y: 0, z: 1 };
    /** @type {{ t: number, ax: number, ay: number, az: number } | null} */
    this.lastSample = null;
    this.peaks = [];

    this.strokeRate = null;
    /** @type {number|null} */
    this._strokeComputedAt = null;
    this.tiltDeg = null;
    this.capsize = false;
    this._capsizeSince = null;
    this._capsizeClearSince = null;
    /** @type {{ axis: string, markerMode: string, strokeRate: number|null, markers: { t: number, v: number }[], surge: { t: number, v: number }[] } | null} */
    this._lastStrokeDebug = null;
  }

  reset() {
    this.buffer = [];
    this.gx = 0;
    this.gy = 0;
    this.gz = 9.81;
    this.sampleCount = 0;
    this.calibrated = false;
    this.upright = { x: 0, y: 0, z: 1 };
    this.peaks = [];
    this.lastSample = null;
    this.strokeRate = null;
    this._strokeComputedAt = null;
    this.tiltDeg = null;
    this.capsize = false;
    this._capsizeSince = null;
    this._capsizeClearSince = null;
    this._lastStrokeDebug = null;
  }

  /**
   * @param {number} t epoch ms
   * @param {number} ax
   * @param {number} ay
   * @param {number} az
   */
  process(t, ax, ay, az) {
    const a = this.opts.gravityAlpha;
    this.gx = a * ax + (1 - a) * this.gx;
    this.gy = a * ay + (1 - a) * this.gy;
    this.gz = a * az + (1 - a) * this.gz;
    this.sampleCount++;

    this.buffer.push({ t, ax, ay, az });
    this.lastSample = { t, ax, ay, az };
    const cutoff = t - this.opts.bufferMs;
    while (this.buffer.length && this.buffer[0].t < cutoff) {
      this.buffer.shift();
    }

    this._calibrateUpright();
    this._updateCapsize(t);
    this._updateStrokeRate();
  }

  _calibrateUpright() {
    if (this.calibrated || !this.lastSample) return;
    const newest = this.lastSample.t;
    const recent = this.buffer.filter(
      (s) => s.t >= newest - this.opts.calibrateWindowMs,
    );
    if (recent.length < this.opts.calibrateMinSamples) return;
    const vx = stdDev(recent.map((s) => s.ax));
    const vy = stdDev(recent.map((s) => s.ay));
    const vz = stdDev(recent.map((s) => s.az));
    if (vx + vy + vz > this.opts.stillVarianceMax) return;

    this.upright = norm3(this.gx, this.gy, this.gz);
    this.calibrated = true;
  }

  _updateCapsize(t) {
    if (!this.calibrated || !this.lastSample) {
      this.capsize = false;
      this._capsizeSince = null;
      this._capsizeClearSince = null;
      this.tiltDeg = null;
      return;
    }

    const mag = mag3(this.gx, this.gy, this.gz);
    if (mag < 7 || mag > 12) {
      return;
    }

    const g = norm3(this.gx, this.gy, this.gz);
    const tiltDot = dot3(g, this.upright);
    this.tiltDeg = Math.round(Math.acos(clamp(tiltDot, -1, 1)) * (180 / Math.PI));

    if (tiltDot < this.opts.capsizeDotThreshold) {
      this._capsizeClearSince = null;
      if (!this._capsizeSince) this._capsizeSince = t;
      if (t - this._capsizeSince >= this.opts.capsizeHoldMs) {
        this.capsize = true;
      }
    } else if (tiltDot > this.opts.capsizeClearDot) {
      this._capsizeSince = null;
      if (!this._capsizeClearSince) this._capsizeClearSince = t;
      if (t - this._capsizeClearSince >= this.opts.capsizeClearHoldMs) {
        this.capsize = false;
      }
    } else {
      this._capsizeSince = null;
      this._capsizeClearSince = null;
    }
  }

  _updateStrokeRate() {
    if (this.buffer.length < 30) {
      this.strokeRate = null;
      this._strokeComputedAt = null;
      return;
    }

    const now = this.buffer[this.buffer.length - 1].t;
    if (this._strokeComputedAt != null && now - this._strokeComputedAt < 500) {
      return;
    }
    this._strokeComputedAt = now;

    const linear = this.buffer.map((s) => ({
      t: s.t,
      lx: s.ax - this.gx,
      ly: s.ay - this.gy,
      lz: s.az - this.gz,
    }));

    const sx = stdDev(linear.map((s) => s.lx));
    const sy = stdDev(linear.map((s) => s.ly));
    const sz = stdDev(linear.map((s) => s.lz));
    let axis = 'lx';
    if (sy >= sx && sy >= sz) axis = 'ly';
    else if (sz >= sx && sz >= sy) axis = 'lz';

    const raw = linear.map((s) => /** @type {number} */ (s[axis]));
    const times = linear.map((s) => s.t);
    const dt =
      (times[times.length - 1] - times[0]) / Math.max(1, times.length - 1);
    const radius = Math.max(2, Math.round(this.opts.hpWindowMs / Math.max(1, dt)));
    const hp = raw.map((v, i) => v - movingAverage(raw, i, radius));

    // Rate uses the last 8s even when the debug buffer is the whole session.
    /** @type {number[]} */
    const rateHp = [];
    /** @type {number[]} */
    const rateTimes = [];
    const newest = times[times.length - 1];
    for (let i = 0; i < times.length; i++) {
      if (times[i] >= newest - 8000) {
        rateHp.push(hp[i]);
        rateTimes.push(times[i]);
      }
    }
    const spm = estimateStrokeSpm(
      rateHp.length >= 30 ? rateHp : hp,
      rateTimes.length >= 30 ? rateTimes : times,
      this.minSpm,
      this.maxSpm,
    );

    const rms = Math.sqrt(hp.reduce((s, v) => s + v * v, 0) / hp.length);
    const minProminence = Math.max(0.2, rms * 0.55);
    let markers = collectExtrema(
      hp,
      times,
      minProminence,
      this.minPeakIntervalMs,
      'valley',
    );
    if (spm != null) markers = keepOneMarkerPerCycle(markers, 60000 / spm);

    this.peaks = markers;
    this.strokeRate = spm;
    this._lastStrokeDebug = {
      axis,
      markerMode: 'cycle',
      strokeRate: spm,
      markers: markers.map((e) => ({ t: e.t, v: e.v })),
      surge: times.map((t, i) => ({ t, v: hp[i] })),
    };
  }

  /** @returns {{ strokeRate: number|null, capsize: boolean, tiltDeg: number|null, calibrated: boolean }} */
  getMetrics() {
    return {
      strokeRate: this.strokeRate,
      capsize: this.capsize,
      tiltDeg: this.tiltDeg,
      calibrated: this.calibrated,
    };
  }

  /**
   * Last computed surge waveform + stroke markers (for debug export / plots).
   * @returns {{
   *   strokeRate: number|null,
   *   calibrated: boolean,
   *   axis: string|null,
   *   markerMode: string|null,
   *   markers: { t: number, v: number }[],
   *   surge: { t: number, v: number }[],
   *   samples: { t: number, ax: number, ay: number, az: number }[],
   * }}
   */
  getStrokeDebug() {
    const d = this._lastStrokeDebug;
    return {
      strokeRate: this.strokeRate,
      calibrated: this.calibrated,
      axis: d?.axis ?? null,
      markerMode: d?.markerMode ?? null,
      markers: d?.markers ? d.markers.map((m) => ({ ...m })) : [],
      surge: d?.surge ? d.surge.map((s) => ({ ...s })) : [],
      samples: this.buffer.map((s) => ({ t: s.t, ax: s.ax, ay: s.ay, az: s.az })),
    };
  }
}

/**
 * Analyze a batch of telemetry samples (server-side window replay).
 * @param {{ t: number, motion?: { ax: number, ay: number, az: number } }[]} samples
 */
function analyzeMotionWindow(samples) {
  const analyzer = new MotionAnalyzer();
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  for (const s of sorted) {
    if (s.motion && s.motion.ax != null && s.motion.ay != null && s.motion.az != null) {
      analyzer.process(s.t, s.motion.ax, s.motion.ay, s.motion.az);
    }
  }
  return analyzer.getMetrics();
}

/**
 * Offline replay of a full capture for stroke-debug plots.
 * Uses a long buffer so the exported surge covers the whole session.
 * @param {{ t: number, ax?: number, ay?: number, az?: number, motion?: { ax: number, ay: number, az: number } }[]} samples
 * @param {{ bufferMs?: number }} [opts]
 */
function analyzeMotionDebug(samples, opts = {}) {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const spanMs =
    sorted.length >= 2 ? sorted[sorted.length - 1].t - sorted[0].t : 0;
  const bufferMs = Math.max(opts.bufferMs ?? 120_000, spanMs + 1000, 8000);
  const analyzer = new MotionAnalyzer({ bufferMs });
  /** @type {{ t: number, spm: number|null }[]} */
  const liveStrokeRate = [];
  for (const s of sorted) {
    const ax = s.ax ?? s.motion?.ax;
    const ay = s.ay ?? s.motion?.ay;
    const az = s.az ?? s.motion?.az;
    if (ax == null || ay == null || az == null) continue;
    analyzer.process(s.t, ax, ay, az);
    const m = analyzer.getMetrics();
    liveStrokeRate.push({ t: s.t, spm: m.strokeRate });
  }
  return {
    ...analyzer.getStrokeDebug(),
    liveStrokeRate,
  };
}

export {
  MotionAnalyzer,
  analyzeMotionWindow,
  analyzeMotionDebug,
  MIN_SPM,
  MAX_SPM,
};
