#!/usr/bin/env node
/**
 * Durable GPS live-reporting smoke.
 *
 * Covers:
 *   - synthetic rowing + car pairs (NEW always speed×dt vs OLD dt>30 / dt>120 bypass)
 *   - 4 Jun 2026 H6 1 Hz drive (overlay JSON, interpolated back to ~1 Hz)
 *   - John production replays: 27bade63, 11b46004, bf03ea2c (token empty)
 *   - recent rnz on-water replay NEW vs OLD (token rnz)
 *   - Manager last-known / live / delayed uses satellite fix age, not HTTP
 *
 * Usage: node scripts/test-gps-live-reporting.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const gps = require('../apps/recorder-pwa/api/lib/gps-outlier.js');
const {
  isGpsFixOutlier,
  filterOutlierGpsFixes,
  distanceMeters,
  pickEffectiveSampleTimeMs,
  isSittingLastKnownFix,
  isGpsFixForMapPosition,
  GPS_OUTLIER_MAX_ROWING_MPS,
  GPS_OUTLIER_MAX_CAR_MPS,
  GPS_OUTLIER_MAX_JUMP_M,
  GPS_OUTLIER_MAX_CAR_JUMP_M,
} = gps;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BASE = 'https://rowing-app-recorder-pwa.vercel.app';
const NZ = 13 * 3600 * 1000;
const ORIGIN = { lat: -37.787, lon: 175.279 };
const KARAPIRO = { lat: -37.9305, lon: 175.5485, r: 8000 };
const JOHN_SIDS = [
  { id: '27bade63-77f5-44be-9ed0-0133a49d3fbb', label: 'afternoon 27bade63', expect: 'drive+teleports' },
  { id: '11b46004-2183-4ea3-abb7-8b08007a6d9f', label: 'morning 11b46004', expect: 'walk' },
  { id: 'bf03ea2c-b7ec-4793-8446-5a7974e2ca26', label: 'morning/mid bf03ea2c', expect: 'walk/short' },
];

const OVERLAY_CANDIDATES = [
  join(ROOT, '..', 'traccar-overlay', 'public', 'data', 'documents-h6-traccar-2026-06-04.json'),
  join(ROOT, '..', 'Drone_CV', 'public', 'data', 'documents-h6-traccar-2026-06-04.json'),
  join(HERE, 'documents-h6-traccar-2026-06-04.json'),
];

function offset(metersNorth, metersEast = 0) {
  const lat = ORIGIN.lat + metersNorth / 111320;
  const lon = ORIGIN.lon + metersEast / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  return { lat, lon };
}

function pair(dtSec, metersNorth, acc = 8) {
  const t0 = 1_700_000_000_000;
  return {
    prev: { t: t0, ...ORIGIN, acc },
    fix: { t: t0 + dtSec * 1000, ...offset(metersNorth), acc },
  };
}

/** Committed HEAD filter: dt>120 keep; dt>30 keep (no speed cap). */
function isGpsFixOutlierOld(prev, fix, opts = {}) {
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
  const mode = String(opts.mode || 'rowing').toLowerCase() === 'car' ? 'car' : 'rowing';
  const maxMps = opts.maxMps ?? (mode === 'car' ? GPS_OUTLIER_MAX_CAR_MPS : GPS_OUTLIER_MAX_ROWING_MPS);
  const maxJumpM = opts.maxJumpM ?? (mode === 'car' ? GPS_OUTLIER_MAX_CAR_JUMP_M : GPS_OUTLIER_MAX_JUMP_M);
  const maxDtSec = opts.maxDtSec ?? 8;
  const badAccM = opts.badAccM ?? 30;
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

function filterOld(fixes, opts = {}) {
  const out = [];
  for (const fix of [...fixes].sort((a, b) => a.t - b.t)) {
    const prev = out[out.length - 1];
    if (prev && isGpsFixOutlierOld(prev, fix, opts)) continue;
    out.push(fix);
  }
  return out;
}

function verdict(reject) {
  return reject ? 'REJECT' : 'KEEP';
}

function expect(name, got, want, extra = {}) {
  const pass = got === want;
  return { name, got: verdict(got), want: verdict(want), pass, ...extra };
}

function expectEq(name, got, want, extra = {}) {
  return { name, got, want, pass: got === want, ...extra };
}

function nzClock(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms + NZ).toISOString().slice(11, 23);
}

function nzIso(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms + NZ).toISOString().replace('T', ' ').replace('Z', ' NZ');
}

function summarizeCadence(pts) {
  const dts = [];
  let jumps100 = 0;
  let jumps400 = 0;
  let maxJump = 0;
  let maxDt = 0;
  let maxMps = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt > 0) {
      dts.push(dt);
      if (dt > maxDt) maxDt = dt;
    }
    const jump = distanceMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    if (jump > maxJump) maxJump = jump;
    if (dt > 0) {
      const mps = jump / dt;
      if (mps > maxMps) maxMps = mps;
    }
    if (jump >= 100) jumps100++;
    if (jump >= 400) jumps400++;
  }
  dts.sort((a, b) => a - b);
  const pct = (p) => (dts.length ? dts[Math.min(dts.length - 1, Math.floor((p / 100) * dts.length))] : null);
  return {
    n: pts.length,
    medianDt: dts.length ? +pct(50).toFixed(2) : null,
    p90Dt: dts.length ? +pct(90).toFixed(2) : null,
    maxDt: +maxDt.toFixed(2),
    gt1_5: dts.filter((d) => d > 1.5).length,
    gt3: dts.filter((d) => d > 3).length,
    gt8: dts.filter((d) => d > 8).length,
    gt30: dts.filter((d) => d > 30).length,
    jumps100,
    jumps400,
    maxJumpM: Math.round(maxJump),
    maxMps: +maxMps.toFixed(1),
    spanMin: pts.length > 1 ? +((pts[pts.length - 1].t - pts[0].t) / 60000).toFixed(1) : 0,
  };
}

function trackDistanceKm(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    m += distanceMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  return +(m / 1000).toFixed(2);
}

function classifyPair(prev, fix) {
  const dt = (fix.t - prev.t) / 1000;
  if (!(dt > 0)) return { kind: 'bad-dt', dt, jumpM: 0, mps: 0 };
  const jumpM = distanceMeters(prev.lat, prev.lon, fix.lat, fix.lon);
  const mps = jumpM / dt;
  if (jumpM >= 400 && mps > 20) return { kind: 'teleport', dt, jumpM, mps };
  if (jumpM < 80 && mps < 3.5) return { kind: 'walk', dt, jumpM, mps };
  if (mps >= 3 && mps < 7.5 && jumpM < 80) return { kind: 'row', dt, jumpM, mps };
  if (mps >= 8 && mps <= 38 && jumpM < 400) return { kind: 'drive', dt, jumpM, mps };
  return { kind: 'other', dt, jumpM, mps };
}

function analyzeTrack(gpsPts, mode) {
  const jumps = [];
  const kinds = { walk: { n: 0, droppedNew: 0 }, teleport: { n: 0, droppedNew: 0 }, row: { n: 0, droppedNew: 0 }, drive: { n: 0, droppedNew: 0 }, other: { n: 0, droppedNew: 0 } };
  for (let i = 1; i < gpsPts.length; i++) {
    const prev = gpsPts[i - 1];
    const fix = gpsPts[i];
    const cls = classifyPair(prev, fix);
    const neu = isGpsFixOutlier(prev, fix, { mode });
    const old = isGpsFixOutlierOld(prev, fix, { mode });
    if (kinds[cls.kind]) {
      kinds[cls.kind].n++;
      if (neu) kinds[cls.kind].droppedNew++;
    }
    if (neu || old || cls.kind === 'teleport' || (cls.jumpM || 0) >= 80) {
      jumps.push({
        i,
        dt: +cls.dt.toFixed(1),
        jumpM: Math.round(cls.jumpM),
        mps: +cls.mps.toFixed(1),
        kind: cls.kind,
        neu: verdict(neu),
        old: verdict(old),
        droppedByNewOnly: neu && !old,
        src: fix.src || null,
      });
    }
  }
  const filteredNew = filterOutlierGpsFixes(gpsPts, { mode });
  const filteredOld = filterOld(gpsPts, { mode });
  return {
    mode,
    in: gpsPts.length,
    keptNew: filteredNew.length,
    keptOld: filteredOld.length,
    droppedNew: gpsPts.length - filteredNew.length,
    droppedOld: gpsPts.length - filteredOld.length,
    keptPctNew: gpsPts.length ? +((filteredNew.length / gpsPts.length) * 100).toFixed(1) : 0,
    kinds,
    walkKept: kinds.walk.n - kinds.walk.droppedNew,
    walkDropped: kinds.walk.droppedNew,
    teleportsDropped: kinds.teleport.droppedNew,
    teleportsKept: kinds.teleport.n - kinds.teleport.droppedNew,
    newOnlyHead: jumps
      .filter((j) => j.droppedByNewOnly)
      .sort((a, b) => b.jumpM - a.jumpM)
      .slice(0, 8),
    cadenceKept: summarizeCadence(filteredNew),
    kmIn: trackDistanceKm(gpsPts),
    kmNew: trackDistanceKm(filteredNew),
    kmOld: trackDistanceKm(filteredOld),
  };
}

function syntheticHzTrail({ mode, mps, seconds, hz = 1, acc = 6 }) {
  const t0 = 1_710_000_000_000;
  const stepM = mps / hz;
  const n = Math.round(seconds * hz) + 1;
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ t: t0 + (i * 1000) / hz, ...offset(i * stepM), acc });
  }
  return { label: `${mode} ${mps} m/s × ${seconds}s @ ${hz} Hz`, pts, mode };
}

/** Same rules as dashboard.js mapDisplayAgeSec (read-check, not imported). */
function mapDisplayAgeSec(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.displayFixAgeSec != null && Number.isFinite(p.displayFixAgeSec)) {
    return p.displayFixAgeSec;
  }
  const ingest = p.ingestAgoSec ?? p.lastSeenAgoSec;
  const trueFix =
    p.gpsFixAgeSec != null && Number.isFinite(p.gpsFixAgeSec) ? p.gpsFixAgeSec : p.fixAgeSec;
  const lag =
    p.uploadLagSec != null && Number.isFinite(p.uploadLagSec)
      ? p.uploadLagSec
      : trueFix != null && ingest != null
        ? trueFix - ingest
        : 0;
  const clockGap = trueFix != null && ingest != null ? trueFix - ingest : 0;
  const effectiveLag = Math.max(lag, clockGap);
  const sitting = p.speed == null || !Number.isFinite(p.speed) || p.speed <= 0.75;
  if (trueFix != null && ingest != null && effectiveLag > 20 && (sitting || effectiveLag > 60)) {
    return trueFix;
  }
  if (
    ingest != null &&
    p.fixAgeSec != null &&
    Number.isFinite(p.fixAgeSec) &&
    p.fixAgeSec > 30 &&
    p.fixAgeSec - ingest > 20
  ) {
    return p.fixAgeSec;
  }
  if (
    p.fixAgeSec != null &&
    ingest != null &&
    Number.isFinite(p.fixAgeSec) &&
    Number.isFinite(ingest) &&
    p.fixAgeSec - ingest > 20
  ) {
    return ingest;
  }
  return p.fixAgeSec ?? null;
}

function gpsFixState(p) {
  const age = Number(mapDisplayAgeSec(typeof p === 'object' ? p : { fixAgeSec: p }));
  if (!Number.isFinite(age)) return 'lost';
  if (age <= 30) return 'live';
  if (age <= 300) return 'amber';
  return 'lost';
}

function lastSeenDisplaySec(d) {
  if (!d || typeof d !== 'object') return null;
  const seen = d.lastSeenAgoSec;
  const gps = d.gps || {};
  const fixAge = gps.gpsFixAgeSec ?? d.gpsFixAgeSec ?? gps.ageSec ?? d.fixAgeSec;
  const ingest = gps.ingestAgoSec ?? d.ingestAgoSec ?? seen;
  const lagVal = gps.uploadLagSec ?? d.uploadLagSec;
  const lag =
    lagVal != null && Number.isFinite(lagVal)
      ? lagVal
      : fixAge != null && ingest != null
        ? fixAge - ingest
        : 0;
  if (fixAge != null && Number.isFinite(fixAge) && lag > 20 && fixAge > (seen ?? 0) + 20) {
    return fixAge;
  }
  return seen ?? null;
}

/** Same rules as ingest-store displayGpsAgeSec. */
function displayGpsAgeSec(fixAgeSec, ingestAgoSec, extra = {}) {
  const gpsFixAgeSec = extra.gpsFixAgeSec;
  const uploadLagSec = extra.uploadLagSec;
  const trueFixAge =
    gpsFixAgeSec != null && Number.isFinite(Number(gpsFixAgeSec)) ? Number(gpsFixAgeSec) : fixAgeSec;
  if (trueFixAge == null || !Number.isFinite(Number(trueFixAge))) return null;
  const ingest = ingestAgoSec != null && Number.isFinite(Number(ingestAgoSec)) ? Number(ingestAgoSec) : null;
  const lag =
    uploadLagSec != null && Number.isFinite(Number(uploadLagSec))
      ? Number(uploadLagSec)
      : ingest != null
        ? Number(trueFixAge) - ingest
        : 0;
  const clockGap = ingest != null ? Number(trueFixAge) - ingest : 0;
  const effectiveLag = Math.max(lag, clockGap);
  const spd = extra.spd;
  const sitting = spd == null || !Number.isFinite(Number(spd)) || Number(spd) <= 0.75;
  if (ingest != null && effectiveLag > 20 && (sitting || effectiveLag > 60)) {
    return Number(trueFixAge);
  }
  if (
    ingest != null &&
    fixAgeSec != null &&
    Number.isFinite(Number(fixAgeSec)) &&
    Number(fixAgeSec) > 30 &&
    Number(fixAgeSec) - ingest > 20
  ) {
    return Number(fixAgeSec);
  }
  if (
    fixAgeSec != null &&
    Number.isFinite(Number(fixAgeSec)) &&
    ingest != null &&
    Number(fixAgeSec) - ingest > 20
  ) {
    return ingest;
  }
  return fixAgeSec != null && Number.isFinite(Number(fixAgeSec)) ? Number(fixAgeSec) : Number(trueFixAge);
}

function loadOverlay() {
  for (const p of OVERLAY_CANDIDATES) {
    if (existsSync(p)) {
      return { path: p, json: JSON.parse(readFileSync(p, 'utf8')) };
    }
  }
  return null;
}

function latlngsToFixes(latlngs, fromMs, toMs) {
  const n = latlngs.length;
  if (n < 2) return [];
  const span = Math.max(1000, toMs - fromMs);
  return latlngs.map((ll, i) => ({
    t: fromMs + Math.round((i * span) / (n - 1)),
    lat: ll[0],
    lon: ll[1],
    acc: 8,
  }));
}

/** Rebuild ~1 Hz along the polyline so implied speed matches the overlay path. */
function interpolate1Hz(latlngs, fromMs, toMs, targetN) {
  if (!latlngs?.length) return [];
  const segs = [];
  let total = 0;
  for (let i = 1; i < latlngs.length; i++) {
    const d = distanceMeters(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);
    segs.push({ a: latlngs[i - 1], b: latlngs[i], d, start: total });
    total += d;
  }
  const n = Math.max(2, targetN);
  const span = Math.max(1000, toMs - fromMs);
  const out = [];
  for (let i = 0; i < n; i++) {
    const dist = (i / (n - 1)) * total;
    let seg = segs[segs.length - 1];
    for (const s of segs) {
      if (dist <= s.start + s.d || s === segs[segs.length - 1]) {
        seg = s;
        break;
      }
    }
    const u = seg.d > 0 ? Math.min(1, Math.max(0, (dist - seg.start) / seg.d)) : 0;
    out.push({
      t: fromMs + Math.round((i * span) / (n - 1)),
      lat: seg.a[0] + (seg.b[0] - seg.a[0]) * u,
      lon: seg.a[1] + (seg.b[1] - seg.a[1]) * u,
      acc: 8,
    });
  }
  return out;
}

function nearKarapiro(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return distanceMeters(lat, lon, KARAPIRO.lat, KARAPIRO.lon) <= KARAPIRO.r;
}

async function getJson(path, token) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(BASE + path, { headers, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text.slice(0, 240) };
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { error: String(err?.message || err) } };
  } finally {
    clearTimeout(timer);
  }
}

function trackFromHistory(json) {
  const arr = Array.isArray(json?.track)
    ? json.track
    : Array.isArray(json)
      ? json
      : json?.points || [];
  return arr
    .filter((p) => (p.lat ?? p.latitude) != null && (p.lon ?? p.longitude) != null)
    .map((p) => ({
      t: p.t ?? (p.fixTime ? Date.parse(p.fixTime) : NaN),
      lat: p.lat ?? p.latitude,
      lon: p.lon ?? p.longitude,
      acc: p.acc ?? p.accuracy ?? null,
      src: p.gpsSampleSource || null,
      spd: p.speed ?? p.spd ?? null,
      stroke: p.strokeRate ?? null,
    }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

// ---------------------------------------------------------------------------
// 1. Synthetic smoke
// ---------------------------------------------------------------------------
const cases = [];

{
  const { prev, fix } = pair(10, 14);
  cases.push(expect('walk 14 m / 10s rowing', isGpsFixOutlier(prev, fix, { mode: 'rowing' }), false));
  cases.push(expect('walk 14 m / 10s car', isGpsFixOutlier(prev, fix, { mode: 'car' }), false));
}
{
  const { prev, fix } = pair(1, 4.5);
  cases.push(expect('row 4.5 m / 1s (1 Hz shell)', isGpsFixOutlier(prev, fix, { mode: 'rowing' }), false));
}
{
  const { prev, fix } = pair(1, 25);
  cases.push(expect('car 25 m / 1s (90 km/h 1 Hz)', isGpsFixOutlier(prev, fix, { mode: 'car' }), false));
  cases.push(expect('car 25 m / 1s in rowing (must reject)', isGpsFixOutlier(prev, fix, { mode: 'rowing' }), true));
}
for (const dt of [30, 31, 34]) {
  const { prev, fix } = pair(dt, 4600);
  for (const mode of ['rowing', 'car']) {
    cases.push(
      expect(`4.6 km / ${dt}s ${mode} NEW`, isGpsFixOutlier(prev, fix, { mode }), true, {
        old: verdict(isGpsFixOutlierOld(prev, fix, { mode })),
      }),
    );
  }
}
{
  const { prev, fix } = pair(3, 90);
  cases.push(expect('90 m / 3s rowing', isGpsFixOutlier(prev, fix, { mode: 'rowing' }), true));
  cases.push(expect('90 m / 3s car', isGpsFixOutlier(prev, fix, { mode: 'car' }), false));
}
{
  const { prev, fix } = pair(3, 2000);
  cases.push(expect('2 km / 3s car', isGpsFixOutlier(prev, fix, { mode: 'car' }), true));
}
{
  const { prev, fix } = pair(40, 500);
  cases.push(expect('500 m / 40s rowing NEW', isGpsFixOutlier(prev, fix, { mode: 'rowing' }), true));
  cases.push(expect('500 m / 40s rowing OLD bypass', isGpsFixOutlierOld(prev, fix, { mode: 'rowing' }), false));
}
{
  const { prev, fix } = pair(130, 10000);
  cases.push(expect('10 km / 130s rowing NEW', isGpsFixOutlier(prev, fix, { mode: 'rowing' }), true));
  cases.push(expect('10 km / 130s rowing OLD 120s bypass', isGpsFixOutlierOld(prev, fix, { mode: 'rowing' }), false));
}

const now = 1_800_000_000_000;
const stale = now - 60_000;
const restampCases = [
  expectEq('sitting spd=0.1 not restamped', pickEffectiveSampleTimeMs(stale, stale, now, 'fused', { spd: 0.1 }), stale),
  expectEq('moving spd=12 restamped to now', pickEffectiveSampleTimeMs(stale, stale, now, 'fused', { spd: 12 }), now),
  {
    name: 'last_known is not a live map fix and not restamped',
    pass: isGpsFixForMapPosition('last_known') === false && pickEffectiveSampleTimeMs(stale, stale, now, 'last_known', { spd: 0 }) === stale,
  },
  expectEq('scheduled_cache not restamped', pickEffectiveSampleTimeMs(stale, stale, now, 'scheduled_cache', {}), stale),
  {
    name: 'missing speed + stale clock is sitting last-known',
    pass: isSittingLastKnownFix({ sampleSource: 'window_avg' }) === true,
  },
];

const synthTrails = [
  syntheticHzTrail({ mode: 'rowing', mps: 5, seconds: 600 }),
  syntheticHzTrail({ mode: 'car', mps: 28, seconds: 600 }),
].map((tr) => {
  const neu = filterOutlierGpsFixes(tr.pts, { mode: tr.mode });
  const old = filterOld(tr.pts, { mode: tr.mode });
  const pass = neu.length === tr.pts.length;
  return {
    label: tr.label,
    in: tr.pts.length,
    keptNew: neu.length,
    keptOld: old.length,
    km: trackDistanceKm(tr.pts),
    pass,
  };
});

// ---------------------------------------------------------------------------
// 2. 4 Jun overlay 1 Hz
// ---------------------------------------------------------------------------
const overlayFile = loadOverlay();
let june = { found: false };
if (overlayFile) {
  const sess = overlayFile.json.session || {};
  const fromMs = Date.parse(sess.from || '2026-06-03T23:30:00.000Z');
  const toMs = Date.parse(sess.to || '2026-06-04T00:15:00.000Z');
  const rec = overlayFile.json.tracks?.recorder;
  const trc = overlayFile.json.tracks?.traccar;
  const recPts = rec?.points || [];
  const hzN = rec?.count || 2686;
  const spaced = latlngsToFixes(recPts, fromMs, toMs);
  const hz = interpolate1Hz(recPts, fromMs, toMs, hzN);
  const recCar = analyzeTrack(hz, 'car');
  const recRow = analyzeTrack(hz, 'rowing');
  const spacedCar = analyzeTrack(spaced, 'car');
  const keep1Hz = recCar.keptPctNew >= 99.5 && recCar.teleportsKept === 0;
  june = {
    found: true,
    path: overlayFile.path,
    label: sess.label,
    overlayRecorderPts: recPts.length,
    overlayRecorderCount: rec?.count ?? null,
    overlayTraccarCount: trc?.count ?? null,
    note: recPts.length < (rec?.count || 0)
      ? `overlay is downsampled ${recPts.length}/${rec.count}; reconstructed ${hz.length} pts @ ~1 Hz along the polyline`
      : 'full overlay points',
    reconstructed1Hz: recCar.cadenceKept,
    km: recCar.kmIn,
    car: recCar,
    rowing: recRow,
    spacedDownsampleCar: spacedCar,
    keep1HzDrive: keep1Hz,
    pass: keep1Hz,
  };
}

// ---------------------------------------------------------------------------
// 3 + 4. Production replays
// ---------------------------------------------------------------------------
async function replaySession(sid, token) {
  const hist = await getJson(`/api/history?format=dashboard&sessionId=${sid}`, token);
  const pts = trackFromHistory(hist.json);
  const strokes = pts.filter((p) => p.stroke != null && p.stroke > 0).length;
  const mid = pts[Math.floor(pts.length / 2)];
  return {
    status: hist.status,
    sessionId: hist.json?.sessionId || sid,
    uniqueId: hist.json?.uniqueId || null,
    endedAt: hist.json?.endedAt || hist.json?.ended_at || null,
    gpsN: pts.length,
    firstNz: pts[0] ? nzClock(pts[0].t) : null,
    lastNz: pts.length ? nzClock(pts[pts.length - 1].t) : null,
    cadence: summarizeCadence(pts),
    km: trackDistanceKm(pts),
    strokeN: strokes,
    nearKarapiro: mid ? nearKarapiro(mid.lat, mid.lon) : false,
    mid: mid ? { lat: +mid.lat.toFixed(5), lon: +mid.lon.toFixed(5) } : null,
    rowing: analyzeTrack(pts, 'rowing'),
    car: analyzeTrack(pts, 'car'),
    fetched: hist.status === 200 && pts.length > 0,
  };
}

const johnReplays = [];
for (const spec of JOHN_SIDS) {
  const r = await replaySession(spec.id, 'empty');
  johnReplays.push({ ...spec, ...r });
}

const rnzList = await getJson('/api/history?list=sessions', 'rnz');
const rnzSessions = (rnzList.json?.sessions || [])
  .slice()
  .sort(
    (a, b) =>
      Date.parse(b.updated_at || b.started_at || 0) - Date.parse(a.updated_at || a.started_at || 0),
  );
const rnzCandidates = rnzSessions
  .filter((s) => (s.sample_count || 0) >= 80)
  .slice(0, 12);

const rnzReplays = [];
for (const s of rnzCandidates) {
  const sid = s.session_id || s.sessionId;
  const r = await replaySession(sid, 'rnz');
  rnzReplays.push({
    listed: {
      sessionId: sid,
      uniqueId: s.unique_id || s.uniqueId,
      sampleCount: s.sample_count,
      startedNz: s.started_at ? nzIso(Date.parse(s.started_at)) : null,
      endedNz: s.ended_at ? nzIso(Date.parse(s.ended_at)) : null,
    },
    ...r,
  });
}

const rnzOnWater = rnzReplays.filter(
  (r) => r.fetched && (r.nearKarapiro || r.strokeN > 20 || (r.rowing?.kinds?.row?.n || 0) > 30),
);
const rnzPick = rnzOnWater[0] || rnzReplays.find((r) => r.fetched && r.gpsN > 100) || null;
const rnzNotGutted = rnzPick
  ? rnzPick.rowing.keptPctNew >= 85 && (rnzPick.rowing.kinds.row?.droppedNew || 0) <= Math.max(2, (rnzPick.rowing.kinds.row?.n || 0) * 0.05)
  : null;

// Try live June H6 again (history may have aged out).
const juneLive = await getJson(
  `/api/history?format=dashboard&uniqueId=H6&from=${encodeURIComponent('2026-06-03T23:30:00.000Z')}&to=${encodeURIComponent('2026-06-04T00:15:00.000Z')}`,
  'rnz',
);

// ---------------------------------------------------------------------------
// 5. Dashboard last-known read-check
// ---------------------------------------------------------------------------
const dashSrc = readFileSync(join(ROOT, 'apps', 'recorder-pwa', 'public', 'dashboard.js'), 'utf8');
const storeSrc = readFileSync(join(ROOT, 'apps', 'recorder-pwa', 'api', 'lib', 'ingest-store.js'), 'utf8');
const outlierSrc = readFileSync(join(ROOT, 'apps', 'recorder-pwa', 'api', 'lib', 'gps-outlier.js'), 'utf8');

const sourceChecks = [
  {
    name: 'dashboard mapDisplayAgeSec prefers displayFixAgeSec',
    pass: /if \(p\.displayFixAgeSec != null && Number\.isFinite\(p\.displayFixAgeSec\)\)/.test(dashSrc),
  },
  {
    name: 'dashboard sitting last-known uses trueFix (not HTTP ingest)',
    pass: /effectiveLag > 20 && \(sitting \|\| effectiveLag > 60\)/.test(dashSrc)
      && /return trueFix;/.test(dashSrc),
  },
  {
    name: 'dashboard gpsFixState uses mapDisplayAgeSec (live/amber/lost)',
    pass: /function gpsFixState\(p\)/.test(dashSrc) && /mapDisplayAgeSec/.test(dashSrc)
      && /GPS live \(≤30s\)/.test(dashSrc) && /Last known \(>5min\)/.test(dashSrc),
  },
  {
    name: 'dashboard lastSeenDisplaySec uses fix age when clocks diverge',
    pass: /function lastSeenDisplaySec/.test(dashSrc) && /return fixAge;/.test(dashSrc),
  },
  {
    name: 'ingest-store displayGpsAgeSec sitting last-known uses trueFixAge',
    pass: /Last-known \/ restamped office lock/.test(storeSrc)
      && /effectiveLag > 20 && \(sitting \|\| effectiveLag > 60\)/.test(storeSrc),
  },
  {
    name: 'outlier always speed×dt after 30s hole',
    pass: /if \(jumpM \/ dtSec > maxMps\) return true;/.test(outlierSrc)
      && /A 30s\+ hole must not bypass the speed cap/.test(outlierSrc),
  },
  {
    name: 'Stop/ended_at ignores further GPS for that session',
    pass: /Sessions that already have ended_at/.test(storeSrc)
      && /function stripGpsFromEndedSessionSamples/.test(storeSrc),
  },
];

const lastKnownCases = [];
{
  const sitting = {
    gpsFixAgeSec: 180,
    fixAgeSec: 4,
    ingestAgoSec: 3,
    lastSeenAgoSec: 3,
    uploadLagSec: 177,
    speed: 0.1,
  };
  lastKnownCases.push({
    name: 'office sit: display age is satellite fix (180s) not HTTP (3s)',
    store: displayGpsAgeSec(sitting.fixAgeSec, sitting.ingestAgoSec, {
      gpsFixAgeSec: sitting.gpsFixAgeSec,
      uploadLagSec: sitting.uploadLagSec,
      spd: sitting.speed,
    }),
    dash: mapDisplayAgeSec(sitting),
    state: gpsFixState(sitting),
    lastSeen: lastSeenDisplaySec(sitting),
    pass:
      displayGpsAgeSec(sitting.fixAgeSec, sitting.ingestAgoSec, {
        gpsFixAgeSec: sitting.gpsFixAgeSec,
        uploadLagSec: sitting.uploadLagSec,
        spd: sitting.speed,
      }) === 180
      && mapDisplayAgeSec(sitting) === 180
      && gpsFixState(sitting) === 'amber'
      && lastSeenDisplaySec(sitting) === 180,
  });
}
{
  const liveMove = {
    gpsFixAgeSec: 25,
    fixAgeSec: 25,
    ingestAgoSec: 3,
    lastSeenAgoSec: 3,
    uploadLagSec: 22,
    speed: 12,
  };
  lastKnownCases.push({
    name: 'live moving + 22s clock skew: prefer ingest so pin stays live',
    store: displayGpsAgeSec(liveMove.fixAgeSec, liveMove.ingestAgoSec, {
      gpsFixAgeSec: liveMove.gpsFixAgeSec,
      uploadLagSec: liveMove.uploadLagSec,
      spd: liveMove.speed,
    }),
    dash: mapDisplayAgeSec(liveMove),
    state: gpsFixState(liveMove),
    pass:
      displayGpsAgeSec(liveMove.fixAgeSec, liveMove.ingestAgoSec, {
        gpsFixAgeSec: liveMove.gpsFixAgeSec,
        uploadLagSec: liveMove.uploadLagSec,
        spd: liveMove.speed,
      }) === 3
      && mapDisplayAgeSec(liveMove) === 3
      && gpsFixState(liveMove) === 'live',
  });
}
{
  const matchingClockSit = {
    gpsFixAgeSec: 180,
    fixAgeSec: 180,
    ingestAgoSec: 2,
    lastSeenAgoSec: 2,
    uploadLagSec: 0,
    speed: 0.1,
  };
  lastKnownCases.push({
    name: 'sitting last-known with matching t/fixMs: use 180s not HTTP 2s',
    store: displayGpsAgeSec(matchingClockSit.fixAgeSec, matchingClockSit.ingestAgoSec, {
      gpsFixAgeSec: matchingClockSit.gpsFixAgeSec,
      uploadLagSec: matchingClockSit.uploadLagSec,
      spd: matchingClockSit.speed,
    }),
    dash: mapDisplayAgeSec(matchingClockSit),
    state: gpsFixState(matchingClockSit),
    pass:
      displayGpsAgeSec(matchingClockSit.fixAgeSec, matchingClockSit.ingestAgoSec, {
        gpsFixAgeSec: matchingClockSit.gpsFixAgeSec,
        uploadLagSec: matchingClockSit.uploadLagSec,
        spd: matchingClockSit.speed,
      }) === 180
      && mapDisplayAgeSec(matchingClockSit) === 180
      && gpsFixState(matchingClockSit) === 'amber',
  });
}
{
  const holeHeartbeat = {
    gpsFixAgeSec: 45,
    fixAgeSec: 45,
    ingestAgoSec: 2,
    lastSeenAgoSec: 2,
    uploadLagSec: 0,
    speed: 4.5,
  };
  lastKnownCases.push({
    name: 'GPS hole + heartbeat HTTP: badge ages from fix (not live from ingest)',
    store: displayGpsAgeSec(holeHeartbeat.fixAgeSec, holeHeartbeat.ingestAgoSec, {
      gpsFixAgeSec: holeHeartbeat.gpsFixAgeSec,
      uploadLagSec: holeHeartbeat.uploadLagSec,
      spd: holeHeartbeat.speed,
    }),
    dash: mapDisplayAgeSec(holeHeartbeat),
    state: gpsFixState(holeHeartbeat),
    pass:
      displayGpsAgeSec(holeHeartbeat.fixAgeSec, holeHeartbeat.ingestAgoSec, {
        gpsFixAgeSec: holeHeartbeat.gpsFixAgeSec,
        uploadLagSec: holeHeartbeat.uploadLagSec,
        spd: holeHeartbeat.speed,
      }) === 45
      && mapDisplayAgeSec(holeHeartbeat) === 45
      && gpsFixState(holeHeartbeat) === 'amber',
  });
}
{
  const fresh = { fixAgeSec: 8, ingestAgoSec: 7, lastSeenAgoSec: 7, speed: 4.2 };
  lastKnownCases.push({
    name: 'fresh rowing fix is GPS live',
    dash: mapDisplayAgeSec(fresh),
    state: gpsFixState(fresh),
    pass: mapDisplayAgeSec(fresh) === 8 && gpsFixState(fresh) === 'live',
  });
}
{
  const lost = {
    displayFixAgeSec: 420,
    gpsFixAgeSec: 420,
    fixAgeSec: 2,
    ingestAgoSec: 2,
    lastSeenAgoSec: 2,
    speed: 0,
  };
  lastKnownCases.push({
    name: 'displayFixAgeSec 420s → last known (lost), not live from HTTP',
    dash: mapDisplayAgeSec(lost),
    state: gpsFixState(lost),
    pass: mapDisplayAgeSec(lost) === 420 && gpsFixState(lost) === 'lost',
  });
}

const smokePass = cases.every((c) => c.pass);
const restampPass = restampCases.every((c) => c.pass);
const synthPass = synthTrails.every((t) => t.pass);
const junePass = june.found ? june.pass === true : false;
const dashPass = sourceChecks.every((c) => c.pass) && lastKnownCases.every((c) => c.pass);
const johnFetched = johnReplays.filter((r) => r.fetched);
const johnWalkOk = johnFetched.every((r) => r.rowing.walkDropped === 0);
const johnTeleportOk = johnFetched
  .filter((r) => r.expect === 'drive+teleports')
  .every((r) => r.rowing.teleportsDropped === r.rowing.kinds.teleport.n && r.rowing.kinds.teleport.n > 0);

const out = {
  ranAtNz: nzIso(Date.now()),
  smokePass,
  restampPass,
  synthPass,
  junePass,
  dashPass,
  johnWalkOk,
  johnTeleportOk,
  rnzNotGutted,
  cases,
  restampCases,
  synthTrails,
  june,
  juneLive: {
    status: juneLive.status,
    pointCount: juneLive.json?.pointCount ?? juneLive.json?.track?.length ?? null,
    error: juneLive.json?.error || null,
  },
  john: johnReplays,
  rnz: {
    listStatus: rnzList.status,
    sessionN: rnzSessions.length,
    candidatesTried: rnzCandidates.length,
    onWaterN: rnzOnWater.length,
    pick: rnzPick
      ? {
          sessionId: rnzPick.sessionId,
          uniqueId: rnzPick.uniqueId,
          gpsN: rnzPick.gpsN,
          firstNz: rnzPick.firstNz,
          lastNz: rnzPick.lastNz,
          endedAt: rnzPick.endedAt,
          nearKarapiro: rnzPick.nearKarapiro,
          strokeN: rnzPick.strokeN,
          km: rnzPick.km,
          rowing: rnzPick.rowing,
          car: rnzPick.car,
        }
      : null,
    recent: rnzReplays.map((r) => ({
      sessionId: r.sessionId,
      uniqueId: r.uniqueId,
      fetched: r.fetched,
      gpsN: r.gpsN,
      firstNz: r.firstNz,
      lastNz: r.lastNz,
      nearKarapiro: r.nearKarapiro,
      strokeN: r.strokeN,
      keptPctRowing: r.rowing?.keptPctNew,
      droppedNew: r.rowing?.droppedNew,
      walkDropped: r.rowing?.walkDropped,
      teleportsDropped: r.rowing?.teleportsDropped,
    })),
  },
  sourceChecks,
  lastKnownCases,
};

writeFileSync(join(HERE, '_tmp-gps-live-reporting.out.json'), JSON.stringify(out, null, 2));

const fail = [
  ...cases.filter((c) => !c.pass).map((c) => c.name),
  ...restampCases.filter((c) => !c.pass).map((c) => c.name),
  ...synthTrails.filter((t) => !t.pass).map((t) => t.label),
  ...sourceChecks.filter((c) => !c.pass).map((c) => c.name),
  ...lastKnownCases.filter((c) => !c.pass).map((c) => c.name),
];
if (june.found && !june.pass) fail.push('4 Jun 1 Hz drive chopped in car mode');

console.log(JSON.stringify({
  smokePass,
  restampPass,
  synthPass,
  juneFound: june.found,
  juneKeep1Hz: june.keep1HzDrive ?? null,
  juneOverlayPts: june.overlayRecorderPts ?? null,
  juneReconstructed: june.car?.in ?? null,
  juneCarKeptPct: june.car?.keptPctNew ?? null,
  juneLiveN: out.juneLive.pointCount,
  john: johnReplays.map((r) => ({
    id: r.id.slice(0, 8),
    fetched: r.fetched,
    gpsN: r.gpsN,
    endedAt: r.endedAt,
    walkKept: r.rowing?.walkKept,
    walkDropped: r.rowing?.walkDropped,
    teleports: r.rowing?.kinds?.teleport?.n,
    teleportsDropped: r.rowing?.teleportsDropped,
    keptPctRowing: r.rowing?.keptPctNew,
    keptPctCar: r.car?.keptPctNew,
    kmIn: r.km,
    kmNewRowing: r.rowing?.kmNew,
    kmNewCar: r.car?.kmNew,
  })),
  rnzListStatus: rnzList.status,
  rnzSessionN: rnzSessions.length,
  rnzOnWaterN: rnzOnWater.length,
  rnzPick: rnzPick
    ? {
        id: rnzPick.sessionId?.slice(0, 8),
        uniqueId: rnzPick.uniqueId,
        gpsN: rnzPick.gpsN,
        nearKarapiro: rnzPick.nearKarapiro,
        strokeN: rnzPick.strokeN,
        keptPctRowing: rnzPick.rowing.keptPctNew,
        droppedNew: rnzPick.rowing.droppedNew,
        walkDropped: rnzPick.rowing.walkDropped,
        rowDropped: rnzPick.rowing.kinds.row?.droppedNew,
        kmIn: rnzPick.km,
        kmNew: rnzPick.rowing.kmNew,
      }
    : null,
  rnzNotGutted,
  dashPass,
  johnWalkOk,
  johnTeleportOk,
  fail,
}, null, 2));

if (fail.length) process.exitCode = 1;
