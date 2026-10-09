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
  capsizeHoldMs: 1200,
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

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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
 * Drop finish-dip / secondary markers that sit at ~half a stroke.
 * When consecutive intervals look like catch→finish→catch, keep the deeper of each pair.
 * @param {{ t: number, v: number }[]} events
 * @param {'peak'|'valley'} kind
 */
function thinHalfStrokeMarkers(events, kind) {
  if (events.length < 4) return events;
  /** @type {number[]} */
  const dts = [];
  for (let i = 1; i < events.length; i++) dts.push(events[i].t - events[i - 1].t);
  const med = median(dts);
  if (med == null || med <= 0) return events;

  /** @type {number[]} */
  const paired = [];
  for (let i = 2; i < events.length; i++) paired.push(events[i].t - events[i - 2].t);
  const medPair = median(paired);
  if (medPair == null) return events;

  // Half-stroke pattern: pair gap ≈ 2× consecutive gap.
  if (!(medPair > med * 1.55 && medPair < med * 2.6)) return events;

  /** @type {{ t: number, v: number }[]} */
  const out = [];
  for (let i = 0; i < events.length; ) {
    if (i + 1 >= events.length) {
      out.push(events[i]);
      break;
    }
    const a = events[i];
    const b = events[i + 1];
    const gap = b.t - a.t;
    // Only collapse pairs that look like intra-stroke (near the short median).
    if (gap < med * 1.35) {
      const deeper = kind === 'valley' ? (a.v <= b.v ? a : b) : a.v >= b.v ? a : b;
      out.push(deeper);
      i += 2;
    } else {
      out.push(a);
      i += 1;
    }
  }
  return out.length >= 3 ? out : events;
}

/**
 * Keep only deep extrema (catch-scale), dropping shallow finish dips.
 * @param {{ t: number, v: number }[]} events
 * @param {'peak'|'valley'} kind
 */
function filterByRelativeDepth(events, kind) {
  if (events.length < 3) return events;
  const depths = events.map((e) => Math.abs(e.v));
  const maxDepth = Math.max(...depths);
  if (maxDepth < 1e-6) return events;
  // Finish dips are typically < ~45% of catch depth on hull surge.
  const minDepth = maxDepth * 0.5;
  const kept = events.filter((e) => Math.abs(e.v) >= minDepth);
  return kept.length >= 3 ? kept : events;
}

/**
 * Score a candidate stroke-marker series: prefer valid SPM intervals with low spread.
 * Do not reward raw event count — that preferred drive double-peaks / finish dips.
 * @param {{ t: number, v: number }[]} events
 * @param {number} minIntervalMs
 * @param {number} maxIntervalMs
 * @param {number} minSpm
 * @param {number} maxSpm
 * @returns {{ score: number, spm: number|null, intervals: number[] }}
 */
function scoreStrokeEvents(events, minIntervalMs, maxIntervalMs, minSpm, maxSpm) {
  if (events.length < 3) return { score: -1, spm: null, intervals: [] };
  /** @type {number[]} */
  const intervals = [];
  for (let i = 1; i < events.length; i++) {
    const dtMs = events[i].t - events[i - 1].t;
    if (dtMs >= minIntervalMs && dtMs <= maxIntervalMs) intervals.push(dtMs);
  }
  if (intervals.length < 2) return { score: -1, spm: null, intervals };

  const medianMs = median(intervals);
  if (medianMs == null) return { score: -1, spm: null, intervals };
  const spm = Math.round((60000 / medianMs) * 10) / 10;
  if (spm < minSpm || spm > maxSpm) return { score: -1, spm: null, intervals };

  const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const spread =
    intervals.reduce((s, v) => s + Math.abs(v - mean), 0) / intervals.length / mean;
  const meanDepth =
    events.reduce((s, e) => s + Math.abs(e.v), 0) / Math.max(1, events.length);
  // Depth + consistency; small bonus for having enough intervals (capped).
  const score = meanDepth * 5 - spread * 12 + Math.min(intervals.length, 5) * 0.4;
  return { score, spm, intervals };
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
    this.tiltDeg = null;
    this.capsize = false;
    this._capsizeSince = null;
    this._capsizeClearSince = null;
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
    this.tiltDeg = null;
    this.capsize = false;
    this._capsizeSince = null;
    this._capsizeClearSince = null;
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

  _prepareMarkers(hp, times, minProminence, kind) {
    const raw = collectExtrema(
      hp,
      times,
      minProminence,
      this.minPeakIntervalMs,
      kind,
    );
    const deep = filterByRelativeDepth(raw, kind);
    return thinHalfStrokeMarkers(deep, kind);
  }

  _updateStrokeRate() {
    if (this.buffer.length < 30) {
      this.strokeRate = null;
      return;
    }

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

    const raw = linear.map((s) => s[axis]);
    const times = linear.map((s) => s.t);
    const dt =
      (times[times.length - 1] - times[0]) / Math.max(1, times.length - 1);
    const radius = Math.max(2, Math.round(this.opts.hpWindowMs / Math.max(1, dt)));
    const hp = raw.map((v, i) => v - movingAverage(raw, i, radius));

    const rms = Math.sqrt(hp.reduce((s, v) => s + v * v, 0) / hp.length);
    // Stronger prominence so shallow finish dips are ignored.
    const minProminence = Math.max(0.2, rms * 0.55);

    /*
     * Rowing hull longitudinal accel has ~one catch check per stroke (strong negative
     * surge at front reversal) plus a drive double-peak and often a finish dip
     * (Kleshnev 2010; Holt et al. 2021; Accrow). Counting peaks or catch+finish
     * roughly doubles SPM. Prefer deep catch valleys; peaks only if valleys fail
     * (flipped phone axis).
     */
    const valleys = this._prepareMarkers(hp, times, minProminence, 'valley');
    const peaks = this._prepareMarkers(hp, times, minProminence, 'peak');

    const valleyScore = scoreStrokeEvents(
      valleys,
      this.minPeakIntervalMs,
      this.maxPeakIntervalMs,
      this.minSpm,
      this.maxSpm,
    );
    const peakScore = scoreStrokeEvents(
      peaks,
      this.minPeakIntervalMs,
      this.maxPeakIntervalMs,
      this.minSpm,
      this.maxSpm,
    );

    let chosen = valleyScore;
    let chosenEvents = valleys;
    // Peaks only as flipped-axis fallback when valleys cannot form a rate,
    // or when peaks are clearly better and not ~2× the valley rate.
    if (valleyScore.spm == null && peakScore.spm != null) {
      chosen = peakScore;
      chosenEvents = peaks;
    } else if (
      valleyScore.spm != null &&
      peakScore.spm != null &&
      peakScore.score > valleyScore.score + 3 &&
      peakScore.spm < valleyScore.spm * 1.35
    ) {
      chosen = peakScore;
      chosenEvents = peaks;
    }

    this.peaks = chosenEvents;
    this.strokeRate = chosen.spm;
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

module.exports = {
  MotionAnalyzer,
  analyzeMotionWindow,
  MIN_SPM,
  MAX_SPM,
};
