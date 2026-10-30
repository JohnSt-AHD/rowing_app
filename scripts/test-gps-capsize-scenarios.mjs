#!/usr/bin/env node
/**
 * Failure/regain (GPS + network) and capsize live-reporting scenarios.
 *
 * Hits in-memory ingest-store + gps-outlier + capsize-clear. Does not call
 * production, rnz tokens, or Postgres. Native NetworkCallback / siren / radio
 * are source-checked only.
 *
 * Field outings these --quick cases exist to catch (1.0.62 smoke missed fused-still-ticking):
 *   - empty John 30 Oct 05:38 Hamilton drive — fused window_avg still ticking with
 *     80s+ stale fixMs while GPS moved ~1–2 km (Karapiro→Hamilton)
 *   - Thu 29 Oct afternoon + Fri morning — client live pin vs concurrent manager_watch
 *   - Fri 30 Oct 2026 09:54 same-phone Melville walk — manager_watch gaps p50 31s
 *     vs Manager 7s on the same GPS chip. Fused must not be registered beside
 *     the live LocationManager listener. Live pin follows manager_watch even
 *     when fused/window_avg samples exist.
 *   - Fri 30 Oct 2026 11:03 same-phone Melville walk — John manager_watch gaps
 *     p50 12s and a 24–40s stale tail vs Manager p50 7s and ~2s fix age.
 *     1 s request, Sample interval throttles upload, newest fix in the window.
 *     Do not upload every callback. Fused stays off. Sitting last_known is not restamped.
 *   - Thu 29 Oct 14:36 — fused hole 62s / 2.2 km; live pin must follow GPS intermediates
 *   - 1.0.57 restamp — sitting last_known t=now must not badge "GPS live"
 *   - Thu afternoon last_known flood (122 samples, 3 map-eligible under old 8m rule)
 *   - empty org predictMode=car — John 13–31 m/s drive must not use 7.5 m/s rowing cap
 *   - after Stop leftover last-seen looking live for minutes
 *
 * Usage:
 *   node scripts/test-gps-capsize-scenarios.mjs
 *   node scripts/test-gps-capsize-scenarios.mjs --quick   # skip 32s / 61s waits
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Never persist fake capsizes / GPS to a real DB.
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_URL_NON_POOLING;
delete process.env.DATABASE_URL;
delete process.env.RESEND_API_KEY;

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const QUICK = process.argv.includes('--quick');

const store = require('../apps/recorder-pwa/api/lib/ingest-store.js');
const db = require('../apps/recorder-pwa/api/lib/db.js');
const dayLog = require('../apps/recorder-pwa/api/lib/capsize-day-log.js');
const gps = require('../apps/recorder-pwa/api/lib/gps-outlier.js');

const {
  isGpsFixOutlier,
  filterOutlierGpsFixes,
  distanceMeters,
  isGpsFixForMapPosition,
  isSittingLastKnownFix,
  pickEffectiveSampleTimeMs,
} = gps;

const GPS_LIVE_SEC = 30;
const GPS_STALE_SEC = 300;
const ORIGIN = { lat: -37.9305, lon: 175.5485 };
const ORG = 91001;
const ONLINE_MS = 180_000;
const STALE_MS = 300_000;
const HOLE_MS = QUICK ? 50 : 32_000;
const REARM_MS = QUICK ? 50 : 61_000;

if (store.hasDb()) {
  console.error('ABORT: Postgres still visible after unsetting DB env. Refusing fake capsizes.');
  process.exit(2);
}

const results = [];
const drift = [];
const apkOnly = [];

function offset(metersNorth, metersEast = 0, from = ORIGIN) {
  const lat = from.lat + metersNorth / 111320;
  const lon = from.lon + metersEast / (111320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat, lon };
}

function gpsState(p) {
  const age = Number(p?.displayFixAgeSec ?? p?.fixAgeSec);
  if (!Number.isFinite(age)) return 'lost';
  if (age <= GPS_LIVE_SEC) return 'live';
  if (age <= GPS_STALE_SEC) return 'amber';
  return 'lost';
}

function deviceState(d) {
  const age = Number(d?.gps?.displayAgeSec ?? d?.gps?.ageSec);
  if (!Number.isFinite(age)) return 'lost';
  if (age <= GPS_LIVE_SEC) return 'live';
  if (age <= GPS_STALE_SEC) return 'amber';
  return 'lost';
}

function lastSeenLive(row) {
  const age = Number(row?.lastSeenAgoSec);
  return Number.isFinite(age) && age <= GPS_LIVE_SEC;
}

function check(name, pass, extra = {}) {
  const row = { name, pass: Boolean(pass), ...extra };
  results.push(row);
  const mark = pass ? 'PASS' : 'FAIL';
  const detail = extra.detail ? ` — ${extra.detail}` : '';
  console.log(`  [${mark}] ${name}${detail}`);
  return pass;
}

function checkWait(name, pass, extra = {}) {
  if (QUICK) {
    results.push({ name, pass: true, skipped: true, detail: 'skipped in --quick (needs wall-clock)' });
    console.log(`  [SKIP] ${name} (needs wall-clock)`);
    return true;
  }
  return check(name, pass, extra);
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  process.stdout.write(`  … waiting ${Math.round(ms / 1000)}s\n`);
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function gpsSample(t, lat, lon, extra = {}) {
  const { spd = 4.5, acc = 6, sampleSource, lastKnown, fixMs, hdg } = extra;
  const gpsBody = {
    lat,
    lon,
    acc,
    spd,
    ...(fixMs != null ? { fixMs } : { fixMs: t }),
    ...(sampleSource ? { sampleSource } : {}),
    ...(lastKnown != null ? { lastKnown } : {}),
    ...(hdg != null ? { hdg } : {}),
  };
  return { t, gps: gpsBody };
}

function motionOnly(t) {
  return { t, motion: { ax: 0.1, ay: 0.2, az: 9.7 }, derived: { heartbeat: true } };
}

function tipSample(t, lat, lon) {
  return {
    t,
    gps: { lat, lon, acc: 6, spd: 0.2, fixMs: t },
    derived: { capsize: true, tiltDeg: 110 },
  };
}

function uprightSample(t, lat, lon) {
  return {
    t,
    gps: { lat, lon, acc: 6, spd: 0.2, fixMs: t },
    derived: { capsizeCleared: true, tiltDeg: 8 },
  };
}

function recallSample(t, lat, lon) {
  return {
    t,
    gps: { lat, lon, acc: 6, spd: 0.2, fixMs: t },
    derived: { capsizeRecalled: true, tiltDeg: 110 },
  };
}

async function ingest(deviceId, samples, sessionId = `s-${deviceId}`, boatMeta = {}) {
  return store.recordBatch(ORG, sessionId, deviceId, deviceId, samples, undefined, {
    boatName: deviceId,
    ...boatMeta,
  });
}

async function mapPin(deviceId, predictMode = 'rowing') {
  try {
    const positions = await store.getMapPositions(ORG, ONLINE_MS, STALE_MS, {
      predictMode,
    });
    return (positions || []).find((p) => p.deviceId === deviceId) || null;
  } catch (err) {
    console.error('  getMapPositions failed:', err?.message || err);
    return null;
  }
}

async function deviceCard(deviceId) {
  try {
    const listed = await store.listDevices(ORG, { windowMs: 180_000, onlineMs: ONLINE_MS });
    const devices = listed?.devices || listed || [];
    const arr = Array.isArray(devices) ? devices : [];
    return arr.find((d) => d.deviceId === deviceId) || null;
  } catch (err) {
    console.error('  listDevices failed:', err?.message || err);
    return null;
  }
}

async function capsizeOf(deviceId) {
  const pin = await mapPin(deviceId);
  return {
    pin,
    capsize: Boolean(pin?.capsize),
    phase: pin?.capsizePhase || null,
    responding: Boolean(pin?.capsizeResponding),
    respondingBy: pin?.capsizeRespondingBy || null,
    respondingSource: pin?.capsizeRespondingSource || null,
  };
}

store.setOrgGpsOutlierModeCache(ORG, 'rowing');

// ---------------------------------------------------------------------------
// Native / explainer source checks
// ---------------------------------------------------------------------------
console.log('\n== Source checks (native outbox + explainer) ==');
const nativeSrc = readFileSync(
  join(ROOT, 'apps/recorder-native/android/app/src/main/java/nz/org/rowing/recorder/CapsizeMonitorService.java'),
  'utf8',
);
const explainerSrc = readFileSync(join(ROOT, 'apps/recorder-pwa/public/capsize-explainer.js'), 'utf8');
const explainerHtml = readFileSync(join(ROOT, 'apps/recorder-pwa/public/capsize-explainer.html'), 'utf8');

check('native NetworkCallback onAvailable/onValidated kicks flush', /kickNetworkResume\("available"\)/.test(nativeSrc) && /kickNetworkResume\("validated"\)/.test(nativeSrc) && /onLost/.test(nativeSrc) && /Network lost — buffering ingest locally/.test(nativeSrc));
check('native pending outbox PENDING_BATCHES_KEY + flushPendingIngest', /PENDING_BATCHES_KEY = "pendingIngestBatches"/.test(nativeSrc) && /flushPendingIngest\(p, MAX_PENDING_FLUSH_PER_CYCLE\)/.test(nativeSrc) && /flushIngestBufferNow\(\)/.test(nativeSrc));
check('native uploads stale sitting last-known so the map can decide', /Keep stale sitting samples as last_known/.test(nativeSrc) && /source = "last_known"/.test(nativeSrc) && /FUSED_FREEZE_MS = 8_000L/.test(nativeSrc) && /LAST_KNOWN_FALLBACK_MAX_AGE_MS = 15_000L/.test(nativeSrc) && !/Drop stale last-known/.test(nativeSrc));
check('native GPS listener is the live pin (not gated on beating fused)', /Live pin is the LocationManager GPS listener/.test(nativeSrc) && /"manager_watch"/.test(nativeSrc) && /startGpsSatelliteFallback\(\)/.test(nativeSrc) && /MANAGER_WATCH_REQUEST_MS = 1_000L/.test(nativeSrc) && /MANAGER_WATCH_GPS_MIN_M = 0f/.test(nativeSrc) && /MANAGER_WATCH_NETWORK_MIN_M = 0f/.test(nativeSrc) && /1 s request, Sample interval throttles upload, newest fix in the window/.test(nativeSrc) && /Do not upload every callback/.test(nativeSrc) && /pendingLiveUpload/.test(nativeSrc) && /Fri 30 Oct 2026 11:03 Melville walk/.test(nativeSrc) && /p50 12s/.test(nativeSrc) && /24–40s/.test(nativeSrc) && /Do not clone/.test(nativeSrc) && !/Upload this callback when it arrives/.test(nativeSrc) && !/MANAGER_WATCH_REQUEST_MS = 5_000L/.test(nativeSrc) && !/MANAGER_WATCH_MIN_UPLOAD_MS/.test(nativeSrc) && !/lastManagerWatchUploadMs/.test(nativeSrc) && !/managerWatchHasFresherGpsClock/.test(nativeSrc));
check('native live GNSS is LocationManager only (no fused beside the listener)', /Do not register FusedLocationProviderClient beside this live listener/.test(nativeSrc) && /Fri 30 Oct 2026 09:54 same-phone Melville walk/.test(nativeSrc) && /p50 31s/.test(nativeSrc) && /Manager 7s/.test(nativeSrc) && /unregisterLocation\(\);\s*startGpsSatelliteFallback\(\);/.test(nativeSrc) && !/LocationServices\.getFusedLocationProviderClient/.test(nativeSrc) && !/\.getCurrentLocation\(/.test(nativeSrc) && !/fusedClient\s*\.requestLocationUpdates/.test(nativeSrc) && !/registerFusedLocation\(\);/.test(nativeSrc));
check('native fused stall is GPS clock (fixMs/getTime) not callback silence', /isFusedGpsClockStale/.test(nativeSrc) && /gpsClockAgeMs/.test(nativeSrc) && /lastFusedGpsClockMs/.test(nativeSrc) && /Do not wait for fused to go silent/.test(nativeSrc) && /isFusedGpsClockStale\(\)\) return true/.test(nativeSrc));
check('native queues capsize ingest while offline', /Capsize ingest queued/.test(nativeSrc));
check('explainer has tip / right / on-the-way / I\'m OK / offline / re-arm / multi', /id: 'stay'/.test(explainerSrc) && /id: 'right-no-ack'/.test(explainerSrc) && /id: 'right-on-way'/.test(explainerSrc) && /id: 'athlete-ok'/.test(explainerSrc) && /id: 'offline-reconnect'/.test(explainerSrc) && /id: 'multi'/.test(explainerSrc) && /REARM_MS = 60_000/.test(explainerSrc) && /holdUntilUpright/.test(explainerSrc));
check('explainer has no GPS-regain scenario', !/gps-regain|last-known|GPS live/.test(explainerSrc) && !/GPS regain/.test(explainerHtml));

apkOnly.push('Airplane-mode / cellular PDP cut on a real phone (NetworkCallback + SharedPreferences outbox)');
apkOnly.push('Underwater radio die (native screen/siren off; fleet sticky already covered in-memory)');
apkOnly.push('Native 5s shout / siren stop on upright, on-the-way, or I\'m OK');
apkOnly.push('Help-on-the-way athlete HUD (regatta message needs Postgres)');
apkOnly.push('Real GNSS indoor → outdoor lock time and fused-provider last-known');

if (!/gps-regain|last-known|GPS live/.test(explainerSrc)) {
  drift.push('Explainer is capsize-only: no GPS last-known → live-again demo (not added; different surface).');
}

// ---------------------------------------------------------------------------
// GPS / network
// ---------------------------------------------------------------------------
console.log('\n== GPS / network regain ==');

{
  const id = 'gps-indoor';
  const sitT = Date.now() - 180_000;
  const sit = offset(0, 0);
  const r1 = await ingest(id, [gpsSample(sitT, sit.lat, sit.lon, { spd: 0.05, sampleSource: 'direct', fixMs: sitT })]);
  const pin1 = await mapPin(id);
  const card1 = await deviceCard(id);
  check('indoor sitting last-known: ingest kept', r1.received >= 1 && !r1.ignoredEndedSession);
  check('indoor sitting last-known: map badge amber (fix ~180s, not HTTP-live)', gpsState(pin1) === 'amber' && (pin1.displayFixAgeSec ?? pin1.fixAgeSec) >= 150, {
    detail: `map=${gpsState(pin1)} age=${pin1?.displayFixAgeSec ?? pin1?.fixAgeSec} card=${card1 ? deviceState(card1) : 'n/a'}`,
  });
  check('indoor sitting last-known: listDevices card also amber/lost (not live)', !card1 || deviceState(card1) !== 'live', {
    detail: card1 ? `card=${deviceState(card1)} displayAge=${card1.gps?.displayAgeSec}` : 'listDevices missing',
  });

  const lkT = Date.now();
  await ingest(id, [
    gpsSample(lkT, sit.lat, sit.lon, {
      spd: 0,
      sampleSource: 'last_known',
      lastKnown: true,
      fixMs: sitT,
    }),
  ]);
  const pinLk = await mapPin(id);
  check('last_known sample is map-eligible (manager-like live pin)', isGpsFixForMapPosition('last_known') === true && isSittingLastKnownFix({ lastKnown: true }) === true);
  check('same-coord last_known still draws the pin', pinLk && distanceMeters(pinLk.latitude, pinLk.longitude, sit.lat, sit.lon) < 15, {
    detail: pinLk
      ? `d=${Math.round(distanceMeters(pinLk.latitude, pinLk.longitude, sit.lat, sit.lon))}m src=${pinLk.gpsSampleSource}`
      : 'no pin',
  });
  check('same-coord last_known does not look GPS live', gpsState(pinLk) !== 'live', {
    detail: pinLk ? `map=${gpsState(pinLk)} age=${pinLk.displayFixAgeSec ?? pinLk.fixAgeSec}` : 'no pin',
  });
  check('sitting last_known t=now old fixMs ages from fixMs not ingest (1.0.57 restamp)', gpsState(pinLk) !== 'live' && (pinLk.displayFixAgeSec ?? pinLk.fixAgeSec) >= 150, {
    detail: pinLk ? `map=${gpsState(pinLk)} age=${pinLk.displayFixAgeSec ?? pinLk.fixAgeSec} src=${pinLk.gpsSampleSource}` : 'no pin',
  });
  check('last_known does not restamp sitting clock to now', pickEffectiveSampleTimeMs(sitT, sitT, Date.now(), 'last_known', { spd: 0 }) === sitT);

  const movedLk = offset(25, 0);
  const movedFix = Date.now() - 90_000;
  await ingest(id, [
    gpsSample(Date.now(), movedLk.lat, movedLk.lon, {
      spd: 0.2,
      sampleSource: 'last_known',
      lastKnown: true,
      fixMs: movedFix,
    }),
  ]);
  const pinMoved = await mapPin(id);
  check('last_known moved is map-eligible', pinMoved && distanceMeters(pinMoved.latitude, pinMoved.longitude, movedLk.lat, movedLk.lon) < 15, {
    detail: pinMoved
      ? `d=${Math.round(distanceMeters(pinMoved.latitude, pinMoved.longitude, movedLk.lat, movedLk.lon))}m src=${pinMoved.gpsSampleSource}`
      : 'no pin',
  });
  check('last_known moved with old fixMs is not a live badge', gpsState(pinMoved) !== 'live', {
    detail: pinMoved ? `map=${gpsState(pinMoved)} age=${pinMoved.displayFixAgeSec ?? pinMoved.fixAgeSec}` : 'no pin',
  });

  const walk = offset(18, 0);
  const walkT = Date.now();
  await ingest(id, [
    gpsSample(walkT, walk.lat, walk.lon, { spd: 1.4, sampleSource: 'direct', fixMs: walkT }),
  ]);
  const pin2 = await mapPin(id);
  const card2 = await deviceCard(id);
  check('GPS returns (walk): pin moved nearby (~18m) and badge live again', gpsState(pin2) === 'live' && pin2 && distanceMeters(pin2.latitude, pin2.longitude, walk.lat, walk.lon) < 25, {
    detail: `map=${gpsState(pin2)} age=${pin2?.displayFixAgeSec ?? pin2?.fixAgeSec} moved=${pin2 ? Math.round(distanceMeters(pin2.latitude, pin2.longitude, sit.lat, sit.lon)) : '?'}m`,
  });
  check('GPS returns: listDevices card live again', card2 && deviceState(card2) === 'live', {
    detail: card2 ? `card=${deviceState(card2)} age=${card2.gps?.displayAgeSec}` : 'missing',
  });
}

{
  // Thu afternoon: 122 last_known, 3 map-eligible under the old 8m rule.
  // Restamping the same coord with t=now must not look like the boat moving.
  const id = 'gps-last-known-flood';
  const sit = offset(0, 0);
  const sitT = Date.now() - 180_000;
  await ingest(id, [gpsSample(sitT, sit.lat, sit.lon, { spd: 0, sampleSource: 'direct', fixMs: sitT })]);
  const flood = [];
  for (let i = 0; i < 24; i++) {
    flood.push(gpsSample(Date.now(), sit.lat, sit.lon, {
      spd: 0,
      sampleSource: 'last_known',
      lastKnown: true,
      fixMs: sitT,
    }));
  }
  await ingest(id, flood);
  const pinFlood = await mapPin(id);
  check('last_known flood same-coord does not look like live progress (Thu afternoon 122 last_known)', pinFlood && distanceMeters(pinFlood.latitude, pinFlood.longitude, sit.lat, sit.lon) < 15 && gpsState(pinFlood) !== 'live' && (pinFlood.displayFixAgeSec ?? pinFlood.fixAgeSec) >= 150, {
    detail: pinFlood
      ? `d=${Math.round(distanceMeters(pinFlood.latitude, pinFlood.longitude, sit.lat, sit.lon))}m map=${gpsState(pinFlood)} age=${pinFlood.displayFixAgeSec ?? pinFlood.fixAgeSec} src=${pinFlood.gpsSampleSource}`
      : 'no pin',
  });
}

{
  const id = 'gps-sit-restamp';
  const sit = offset(0, 0);
  const sitT = Date.now() - 180_000;
  await ingest(id, [
    gpsSample(Date.now(), sit.lat, sit.lon, { spd: 0.05, sampleSource: 'window_avg', fixMs: sitT }),
  ]);
  const pinSit = await mapPin(id);
  check('sitting fused t=now old fixMs is not GPS live (1.0.57 restamp via ingest time)', pinSit && gpsState(pinSit) !== 'live' && (pinSit.displayFixAgeSec ?? pinSit.gpsFixAgeSec ?? pinSit.fixAgeSec) >= 150, {
    detail: pinSit
      ? `map=${gpsState(pinSit)} age=${pinSit.displayFixAgeSec ?? pinSit.fixAgeSec} gpsFixAge=${pinSit.gpsFixAgeSec} src=${pinSit.gpsSampleSource}`
      : 'no pin',
  });
}

{
  const id = 'gps-manager-watch';
  const t0 = Date.now() - 8_000;
  const frozen = offset(0, 0);
  await ingest(id, [
    gpsSample(t0, frozen.lat, frozen.lon, { spd: 0.1, sampleSource: 'last_known', lastKnown: true, fixMs: t0 }),
  ]);
  const pinFrozen = await mapPin(id);
  check('fused stall last_known still draws the pin', pinFrozen && distanceMeters(pinFrozen.latitude, pinFrozen.longitude, frozen.lat, frozen.lon) < 15, {
    detail: pinFrozen
      ? `src=${pinFrozen.gpsSampleSource} map=${gpsState(pinFrozen)}`
      : 'no pin',
  });

  const stepped = offset(30, 0);
  const stepT = Date.now();
  await ingest(id, [
    gpsSample(stepT, stepped.lat, stepped.lon, { spd: 5, sampleSource: 'manager_watch', fixMs: stepT }),
  ]);
  const pinWatch = await mapPin(id);
  check('manager_watch during fused stall moves the live pin', pinWatch && distanceMeters(pinWatch.latitude, pinWatch.longitude, stepped.lat, stepped.lon) < 15 && gpsState(pinWatch) === 'live', {
    detail: pinWatch
      ? `d=${Math.round(distanceMeters(pinWatch.latitude, pinWatch.longitude, stepped.lat, stepped.lon))}m src=${pinWatch.gpsSampleSource} map=${gpsState(pinWatch)}`
      : 'no pin',
  });
}

{
  const id = 'gps-fused-stale-clock';
  const fusedFix = Date.now() - 80_000;
  const fused = offset(0, 0);
  await ingest(id, [
    gpsSample(Date.now(), fused.lat, fused.lon, {
      spd: 5,
      sampleSource: 'window_avg',
      fixMs: fusedFix,
    }),
  ]);
  const gpsPos = offset(25, 0);
  const gpsT = Date.now() + 4_000;
  await ingest(id, [
    gpsSample(gpsT, gpsPos.lat, gpsPos.lon, {
      spd: 5,
      sampleSource: 'manager_watch',
      fixMs: gpsT,
    }),
  ]);
  const pinGps = await mapPin(id);
  check('fused still ticking with 80s-old fixMs: manager_watch takes live pin', pinGps && distanceMeters(pinGps.latitude, pinGps.longitude, gpsPos.lat, gpsPos.lon) < 15 && gpsState(pinGps) === 'live' && pinGps.gpsSampleSource === 'manager_watch', {
    detail: pinGps
      ? `d=${Math.round(distanceMeters(pinGps.latitude, pinGps.longitude, gpsPos.lat, gpsPos.lon))}m src=${pinGps.gpsSampleSource} map=${gpsState(pinGps)} age=${pinGps.displayFixAgeSec ?? pinGps.fixAgeSec}`
      : 'no pin',
  });

  const fused2 = offset(8, 0);
  await ingest(id, [
    gpsSample(gpsT + 1_000, fused2.lat, fused2.lon, {
      spd: 5,
      sampleSource: 'window_avg',
      fixMs: Date.now() - 80_000,
    }),
  ]);
  const pinHeld = await mapPin(id);
  check('fused still ticking after manager_watch: GPS keeps live pin (stale fused does not steal it)', pinHeld && distanceMeters(pinHeld.latitude, pinHeld.longitude, gpsPos.lat, gpsPos.lon) < 15 && pinHeld.gpsSampleSource === 'manager_watch' && gpsState(pinHeld) === 'live', {
    detail: pinHeld
      ? `d=${Math.round(distanceMeters(pinHeld.latitude, pinHeld.longitude, gpsPos.lat, gpsPos.lon))}m src=${pinHeld.gpsSampleSource} map=${gpsState(pinHeld)}`
      : 'no pin',
  });
}

{
  // Fri 30 Oct 2026 09:54 same-phone Melville walk: both apps, one GPS chip.
  // CrewSight gaps p50 31s vs Manager 7s because fused held GNSS. The ingest
  // pin must stay on manager_watch even when a newer fused/window_avg exists.
  const id = 'gps-melville-newer-fused';
  const tNow = Date.now();
  const gpsFix = tNow - 48_000;
  const fusedFix = tNow - 40_000;
  const gpsPos = offset(400, 0);
  const fusedPos = offset(445, 0);
  await ingest(id, [
    gpsSample(tNow, gpsPos.lat, gpsPos.lon, { spd: 1.4, sampleSource: 'manager_watch', fixMs: gpsFix }),
    gpsSample(tNow + 1_000, fusedPos.lat, fusedPos.lon, { spd: 1.4, sampleSource: 'window_avg', fixMs: fusedFix }),
  ]);
  const pinMel = await mapPin(id);
  const dGps = pinMel ? distanceMeters(pinMel.latitude, pinMel.longitude, gpsPos.lat, gpsPos.lon) : Infinity;
  const dFused = pinMel ? distanceMeters(pinMel.latitude, pinMel.longitude, fusedPos.lat, fusedPos.lon) : 0;
  const age = Number(pinMel?.displayFixAgeSec ?? pinMel?.gpsFixAgeSec ?? pinMel?.fixAgeSec);
  check('Melville walk: newer fused fixMs does not steal live pin from GPS manager_watch', pinMel && dGps < 15 && dFused > 30 && pinMel.gpsSampleSource === 'manager_watch' && age >= 45, {
    detail: pinMel
      ? `dGps=${Math.round(dGps)}m dFused=${Math.round(dFused)}m src=${pinMel.gpsSampleSource} age=${age} gpsFixAge=${pinMel.gpsFixAgeSec}`
      : 'no pin',
  });

  const fusedLater = offset(490, 0);
  await ingest(id, [
    gpsSample(tNow + 2_000, fusedLater.lat, fusedLater.lon, {
      spd: 1.4,
      sampleSource: 'window_avg',
      fixMs: tNow - 1_000,
    }),
  ]);
  const pinHeldMel = await mapPin(id);
  const dHeld = pinHeldMel
    ? distanceMeters(pinHeldMel.latitude, pinHeldMel.longitude, gpsPos.lat, gpsPos.lon)
    : Infinity;
  check('Melville walk: later window_avg with a fresher fixMs stays off the live pin', pinHeldMel && dHeld < 15 && pinHeldMel.gpsSampleSource === 'manager_watch' && Number(pinHeldMel.displayFixAgeSec ?? pinHeldMel.gpsFixAgeSec) >= 45, {
    detail: pinHeldMel
      ? `d=${Math.round(dHeld)}m src=${pinHeldMel.gpsSampleSource} age=${pinHeldMel.displayFixAgeSec ?? pinHeldMel.gpsFixAgeSec}`
      : 'no pin',
  });

  const idAfter = 'gps-melville-gps-after-fused';
  const fusedFirst = offset(600, 0);
  const gpsSecond = offset(645, 0);
  await ingest(idAfter, [
    gpsSample(tNow, fusedFirst.lat, fusedFirst.lon, { spd: 1.4, sampleSource: 'window_avg', fixMs: tNow - 2_000 }),
  ]);
  await ingest(idAfter, [
    gpsSample(tNow + 1_000, gpsSecond.lat, gpsSecond.lon, { spd: 1.4, sampleSource: 'manager_watch', fixMs: gpsFix }),
  ]);
  const pinAfter = await mapPin(idAfter);
  const dAfterGps = pinAfter ? distanceMeters(pinAfter.latitude, pinAfter.longitude, gpsSecond.lat, gpsSecond.lon) : Infinity;
  const dAfterFused = pinAfter ? distanceMeters(pinAfter.latitude, pinAfter.longitude, fusedFirst.lat, fusedFirst.lon) : 0;
  check('Melville walk: older GPS manager_watch replaces a newer fused pin', pinAfter && dAfterGps < 15 && dAfterFused > 30 && pinAfter.gpsSampleSource === 'manager_watch', {
    detail: pinAfter
      ? `dGps=${Math.round(dAfterGps)}m dFused=${Math.round(dAfterFused)}m src=${pinAfter.gpsSampleSource} age=${pinAfter.displayFixAgeSec ?? pinAfter.gpsFixAgeSec}`
      : 'no pin',
  });
}

{
  // empty John 30 Oct 05:38 Hamilton drive (predictMode=car): fused window_avg
  // still ticking every ~6s with 80s+ stale fixMs at Karapiro while GPS/network
  // had already moved ~1.5 km toward Hamilton. 1.0.62 only checked fused-going-quiet.
  store.setOrgGpsOutlierModeCache(ORG, 'car');
  const id = 'gps-fused-stale-hamilton';
  const tNow = Date.now();
  const fusedFix = tNow - 90_000;
  const start = offset(0, 0);
  const steps = 8;
  const stepM = 180;
  const dest = offset(steps * stepM, 0);
  const samples = [
    gpsSample(tNow, start.lat, start.lon, { spd: 22, sampleSource: 'window_avg', fixMs: fusedFix }),
  ];
  for (let i = 1; i <= steps; i++) {
    const t = tNow - (steps - i) * 6_000;
    const pos = offset(i * stepM, 0);
    samples.push(gpsSample(t, pos.lat, pos.lon, { spd: 30, sampleSource: 'manager_watch', fixMs: t }));
    samples.push(gpsSample(tNow, start.lat, start.lon, { spd: 20, sampleSource: 'window_avg', fixMs: fusedFix }));
  }
  await ingest(id, samples);
  const pinHam = await mapPin(id, 'car');
  const dDest = pinHam ? distanceMeters(pinHam.latitude, pinHam.longitude, dest.lat, dest.lon) : Infinity;
  const dStart = pinHam ? distanceMeters(pinHam.latitude, pinHam.longitude, start.lat, start.lon) : 0;
  check('fused ticking 90s-old fixMs after ~1.5 km GPS move: live pin is GPS not Karapiro (empty John 30 Oct 05:38 Hamilton drive)', pinHam && dDest < 250 && dStart > 1000 && pinHam.gpsSampleSource === 'manager_watch' && gpsState(pinHam) === 'live', {
    detail: pinHam
      ? `fromStart=${Math.round(dStart)}m fromDest=${Math.round(dDest)}m src=${pinHam.gpsSampleSource} map=${gpsState(pinHam)} age=${pinHam.displayFixAgeSec ?? pinHam.fixAgeSec}`
      : 'no pin',
  });

  const coachId = 'gps-coach-hamilton';
  await ingest(
    coachId,
    [gpsSample(tNow, dest.lat, dest.lon, { spd: 30, sampleSource: 'manager_watch', fixMs: tNow })],
    `s-${coachId}`,
    { source: 'manager', boatClass: 'Coach' },
  );
  const coachPin = await mapPin(coachId, 'car');
  const vsCoach = pinHam && coachPin
    ? distanceMeters(pinHam.latitude, pinHam.longitude, coachPin.latitude, coachPin.longitude)
    : Infinity;
  check('manager vs client live pin: client not 500m–2km behind concurrent manager_watch (Thu afternoon + Fri morning)', pinHam && coachPin && vsCoach < 250 && gpsState(coachPin) === 'live' && gpsState(pinHam) === 'live', {
    detail: pinHam && coachPin
      ? `clientVsCoach=${Math.round(vsCoach)}m clientSrc=${pinHam.gpsSampleSource} coachSrc=${coachPin.gpsSampleSource} clientAge=${pinHam.displayFixAgeSec ?? pinHam.fixAgeSec}`
      : 'missing pin',
  });
  store.setOrgGpsOutlierModeCache(ORG, 'rowing');
}

{
  // Thu 29 Oct 14:36: fused froze ~62s then jumped 2.2 km. GPS+network had
  // intermediate highway points — live pin must have followed those, not jump.
  store.setOrgGpsOutlierModeCache(ORG, 'car');
  const id = 'gps-highway-hole-jump';
  const tNow = Date.now();
  const fusedFix = tNow - 70_000;
  const start = offset(0, 0);
  const steps = 11;
  const stepM = 200;
  const dest = offset(steps * stepM, 0);
  const samples = [
    gpsSample(tNow - 70_000, start.lat, start.lon, { spd: 28, sampleSource: 'window_avg', fixMs: fusedFix }),
  ];
  for (let i = 1; i <= steps; i++) {
    const t = tNow - (steps - i) * 6_000;
    const pos = offset(i * stepM, 0);
    samples.push(gpsSample(t, pos.lat, pos.lon, { spd: 33, sampleSource: 'manager_watch', fixMs: t }));
    samples.push(gpsSample(tNow, start.lat, start.lon, { spd: 20, sampleSource: 'window_avg', fixMs: fusedFix }));
  }
  await ingest(id, samples);
  const pinAlong = await mapPin(id, 'car');
  const alongFromStart = pinAlong
    ? distanceMeters(pinAlong.latitude, pinAlong.longitude, start.lat, start.lon)
    : 0;
  const alongFromDest = pinAlong
    ? distanceMeters(pinAlong.latitude, pinAlong.longitude, dest.lat, dest.lon)
    : Infinity;
  check('highway fused hole: live pin followed GPS intermediates, not frozen at start (Thu 29 Oct 14:36 62s / 2.2 km)', pinAlong && alongFromStart > 1500 && alongFromDest < 400 && pinAlong.gpsSampleSource === 'manager_watch', {
    detail: pinAlong
      ? `fromStart=${Math.round(alongFromStart)}m fromDest=${Math.round(alongFromDest)}m src=${pinAlong.gpsSampleSource}`
      : 'no pin',
  });

  await ingest(id, [
    gpsSample(tNow, dest.lat, dest.lon, { spd: 28, sampleSource: 'window_avg', fixMs: tNow }),
  ]);
  const pinCaught = await mapPin(id, 'car');
  const catchJump = pinAlong && pinCaught
    ? distanceMeters(pinAlong.latitude, pinAlong.longitude, pinCaught.latitude, pinCaught.longitude)
    : Infinity;
  check('highway fused hole: fused catch-up does not jump 2 km after GPS already moved', pinCaught && catchJump < 400 && distanceMeters(pinCaught.latitude, pinCaught.longitude, start.lat, start.lon) > 1500, {
    detail: pinCaught
      ? `catchJump=${Math.round(catchJump)}m fromStart=${Math.round(distanceMeters(pinCaught.latitude, pinCaught.longitude, start.lat, start.lon))}m`
      : 'no pin',
  });
  store.setOrgGpsOutlierModeCache(ORG, 'rowing');
}

{
  // empty org predictMode=car: John 13–31 m/s highway must not be stripped at 7.5 m/s.
  store.setOrgGpsOutlierModeCache(ORG, 'car');
  const id = 'gps-car-highway-keep';
  const t0 = Date.now() - 8_000;
  const drive = [];
  for (let i = 0; i < 4; i++) {
    const pos = offset(i * 13, 0);
    const t = t0 + i * 1000;
    drive.push(gpsSample(t, pos.lat, pos.lon, { spd: 13, sampleSource: 'direct', fixMs: t }));
  }
  for (let i = 1; i <= 4; i++) {
    const pos = offset(39 + i * 31, 0);
    const t = t0 + 4_000 + i * 1000;
    drive.push(gpsSample(t, pos.lat, pos.lon, { spd: 31, sampleSource: 'direct', fixMs: t }));
  }
  const rDrive = await ingest(id, drive);
  const pinDrive = await mapPin(id, 'car');
  const destDrive = offset(39 + 4 * 31, 0);
  const driveFromStart = pinDrive
    ? distanceMeters(pinDrive.latitude, pinDrive.longitude, ORIGIN.lat, ORIGIN.lon)
    : 0;
  const driveFromDest = pinDrive
    ? distanceMeters(pinDrive.latitude, pinDrive.longitude, destDrive.lat, destDrive.lon)
    : Infinity;
  check('car 13–31 m/s highway kept (empty org predictMode=car, John drive)', pinDrive && driveFromStart > 80 && driveFromDest < 40 && (rDrive.dropped ?? 0) === 0, {
    detail: pinDrive
      ? `fromStart=${Math.round(driveFromStart)}m fromDest=${Math.round(driveFromDest)}m dropped=${rDrive.dropped ?? 0}`
      : 'no pin',
  });
  store.setOrgGpsOutlierModeCache(ORG, 'rowing');
}

{
  const id = 'gps-hole';
  const t0 = Date.now() - 12_000;
  const trail = [];
  for (let i = 0; i < 12; i++) {
    const pos = offset(i * 5, 0);
    const t = t0 + i * 1000;
    trail.push(gpsSample(t, pos.lat, pos.lon, { spd: 5, sampleSource: 'direct', fixMs: t }));
  }
  await ingest(id, trail);
  const pinBefore = await mapPin(id);
  const before = pinBefore ? { lat: pinBefore.latitude, lon: pinBefore.longitude } : null;

  const idNet = 'gps-net';
  await ingest(idNet, [gpsSample(Date.now(), ORIGIN.lat, ORIGIN.lon, { spd: 4.2, sampleSource: 'direct' })]);
  const netDropStarted = Date.now();

  await sleep(HOLE_MS);

  await ingest(id, [motionOnly(Date.now())]);
  const pinPaused = await mapPin(id);
  const pauseJump = pinPaused && before
    ? distanceMeters(pinPaused.latitude, pinPaused.longitude, before.lat, before.lon)
    : Infinity;
  const pauseAge = pinPaused?.displayFixAgeSec ?? pinPaused?.fixAgeSec;
  checkWait('GPS hole: pin paused (no leap) while age leaves live', pauseJump < 25 && gpsState(pinPaused) !== 'live' && pauseAge >= 25, {
    detail: `jump=${Math.round(pauseJump)}m age=${pauseAge} state=${gpsState(pinPaused)}`,
  });

  const netDuring = await mapPin(idNet);
  checkWait('network drop: lastSeen ages out of live (no flush yet)', Boolean(netDuring) && !lastSeenLive(netDuring), {
    detail: `lastSeenAgo=${netDuring?.lastSeenAgoSec}s online=${netDuring?.online}`,
  });

  const leap = offset(4000, 0);
  const leapT = Date.now();
  const leapIn = await ingest(id, [gpsSample(leapT, leap.lat, leap.lon, { spd: 20, sampleSource: 'direct', fixMs: leapT })]);
  const pinLeap = await mapPin(id);
  const leapJump = pinLeap && before
    ? distanceMeters(pinLeap.latitude, pinLeap.longitude, before.lat, before.lon)
    : Infinity;
  check('GPS hole then 4km leap: rejected, pin does not jump a km', pinLeap && leapJump < 80 && distanceMeters(pinLeap.latitude, pinLeap.longitude, leap.lat, leap.lon) > 1000, {
    detail: `pinJump=${Math.round(leapJump)}m dropped=${leapIn.dropped ?? 0} outliers=${store.getMetrics().gpsOutliersRejected}`,
  });
  check('4km / ~32s is an outlier in rowing (speed×dt, no 30s bypass)', isGpsFixOutlier(
    { t: Date.now() - 32_000, ...before },
    { t: Date.now(), lat: leap.lat, lon: leap.lon, acc: 6 },
    { mode: 'rowing' },
  ) === true);

  const resume = offset((before ? distanceMeters(ORIGIN.lat, ORIGIN.lon, before.lat, before.lon) : 55) + 40, 0);
  const resumeT = Date.now();
  await ingest(id, [gpsSample(resumeT, resume.lat, resume.lon, { spd: 4.8, sampleSource: 'direct', fixMs: resumeT })]);
  const pinResume = await mapPin(id);
  const resumeJump = pinResume && before
    ? distanceMeters(pinResume.latitude, pinResume.longitude, before.lat, before.lon)
    : Infinity;
  checkWait('GPS hole then nearby resume: pin continues (~40m) and live again', gpsState(pinResume) === 'live' && resumeJump < 120 && resumeJump > 10, {
    detail: `continue=${Math.round(resumeJump)}m state=${gpsState(pinResume)} age=${pinResume?.displayFixAgeSec ?? pinResume?.fixAgeSec}`,
  });

  // Phone keeps sampling during the outage (native outbox). Timestamps span the
  // hole; the last sample is ~now. Walk-speed so rowing outlier rules keep them.
  const flushNow = Date.now();
  const queued = [];
  const steps = 8;
  const dtMs = Math.max(1000, Math.round((flushNow - netDropStarted) / steps));
  for (let i = 1; i <= steps; i++) {
    const t = netDropStarted + i * dtMs;
    const pos = offset(i * 6, 0);
    queued.push(gpsSample(Math.min(t, flushNow), pos.lat, pos.lon, { spd: 1.6, sampleSource: 'direct' }));
  }
  const flushed = await ingest(idNet, queued);
  const netAfter = await mapPin(idNet);
  check('network reconnect flush: lastSeen live again after queued ingest', netAfter && lastSeenLive(netAfter) && gpsState(netAfter) === 'live', {
    detail: `lastSeenAgo=${netAfter?.lastSeenAgoSec}s state=${gpsState(netAfter)} received=${flushed.received} dropped=${flushed.dropped ?? 0}`,
  });
}

{
  const id = 'gps-stop';
  const sessionId = `s-${id}`;
  const a = offset(10, 0);
  const b = offset(80, 0);
  await ingest(id, [gpsSample(Date.now(), a.lat, a.lon, { spd: 4, sampleSource: 'direct' })], sessionId);
  const pinA = await mapPin(id);
  await store.endSession(ORG, sessionId, id, Date.now(), id);
  const afterStop = await ingest(id, [gpsSample(Date.now(), b.lat, b.lon, { spd: 5, sampleSource: 'direct' })], sessionId);
  const pinB = await mapPin(id);
  const moved = pinA && pinB
    ? distanceMeters(pinA.latitude, pinA.longitude, pinB.latitude, pinB.longitude)
    : Infinity;
  check('Stop: further GPS ignored for that session', afterStop.ignoredEndedSession === true || (afterStop.received === 0 && (afterStop.dropped || 0) > 0), {
    detail: `received=${afterStop.received} dropped=${afterStop.dropped} ignored=${afterStop.ignoredEndedSession}`,
  });
  check('Stop: pin does not jump to post-stop GPS', moved < 30, {
    detail: `moved=${Math.round(moved)}m`,
  });

  const leftoverT = Date.now();
  const leftover = offset(200, 0);
  const leftoverGps = await ingest(
    id,
    [gpsSample(leftoverT, leftover.lat, leftover.lon, { spd: 5, sampleSource: 'last_known', lastKnown: true, fixMs: leftoverT })],
    sessionId,
  );
  const pinLeftover = await mapPin(id);
  const leftoverMoved = pinA && pinLeftover
    ? distanceMeters(pinA.latitude, pinA.longitude, pinLeftover.latitude, pinLeftover.longitude)
    : Infinity;
  check('Stop leftover last_known GPS is ignored (does not look live for minutes)', leftoverGps.ignoredEndedSession === true || leftoverGps.received === 0, {
    detail: `received=${leftoverGps.received} dropped=${leftoverGps.dropped} ignored=${leftoverGps.ignoredEndedSession}`,
  });
  check('Stop leftover last-seen: pin stays at pre-stop fix, not leftover last_known', leftoverMoved < 30, {
    detail: `moved=${Math.round(leftoverMoved)}m src=${pinLeftover?.gpsSampleSource} map=${gpsState(pinLeftover)}`,
  });

  const leftoverHb = await ingest(
    id,
    [{
      t: Date.now(),
      gps: { lat: leftover.lat, lon: leftover.lon, acc: 6, spd: 0, fixMs: Date.now(), sampleSource: 'last_known', lastKnown: true },
      derived: { heartbeat: true },
    }],
    sessionId,
  );
  const pinHb = await mapPin(id);
  const hbMoved = pinA && pinHb
    ? distanceMeters(pinA.latitude, pinA.longitude, pinHb.latitude, pinHb.longitude)
    : Infinity;
  check('Stop leftover heartbeat+last_known: GPS stripped, pin does not jump', hbMoved < 30 && (leftoverHb.ignoredEndedSession === true || (leftoverHb.dropped || 0) > 0 || leftoverHb.received >= 0), {
    detail: `moved=${Math.round(hbMoved)}m received=${leftoverHb.received} dropped=${leftoverHb.dropped} ignored=${leftoverHb.ignoredEndedSession}`,
  });
}

{
  const id = 'gps-mode';
  store.setOrgGpsOutlierModeCache(ORG, 'rowing');
  const t0 = Date.now() - 9_000;
  const drive = [];
  for (let i = 0; i < 10; i++) {
    const pos = offset(i * 25, 0);
    const t = t0 + i * 1000;
    drive.push(gpsSample(t, pos.lat, pos.lon, { spd: 25, sampleSource: 'direct', fixMs: t }));
  }
  const rRow = await ingest(id, drive);
  const pinRow = await mapPin(id);
  const stick = pinRow
    ? distanceMeters(pinRow.latitude, pinRow.longitude, ORIGIN.lat, ORIGIN.lon)
    : Infinity;
  check('wrong mode (drive in rowing): pin sticks near first fix, not a 250m trail', stick < 80, {
    detail: `stick=${Math.round(stick)}m dropped=${rRow.dropped ?? 0} received=${rRow.received}`,
  });

  store.setOrgGpsOutlierModeCache(ORG, 'car');
  const t1 = Date.now();
  const last = pinRow || { latitude: ORIGIN.lat, longitude: ORIGIN.lon };
  const car = [];
  for (let i = 1; i <= 8; i++) {
    const pos = offset(stick + i * 25, 0);
    const t = t1 + i * 1000;
    car.push(gpsSample(t, pos.lat, pos.lon, { spd: 25, sampleSource: 'direct', fixMs: t }));
  }
  await ingest(id, car);
  const pinCar = await mapPin(id);
  const carMove = pinCar
    ? distanceMeters(pinCar.latitude, pinCar.longitude, last.latitude ?? last.lat, last.longitude ?? last.lon)
    : 0;
  check('switch interpretation to car: pin moves along the drive', carMove > 80, {
    detail: `moved=${Math.round(carMove)}m`,
  });
  store.setOrgGpsOutlierModeCache(ORG, 'rowing');
}

{
  const { prev, fix } = (() => {
    const t0 = Date.now();
    return {
      prev: { t: t0, ...ORIGIN, acc: 6 },
      fix: { t: t0 + 1000, ...offset(25), acc: 6 },
    };
  })();
  check('document pin-stick: 25 m / 1s rejected in rowing, kept in car', isGpsFixOutlier(prev, fix, { mode: 'rowing' }) === true && isGpsFixOutlier(prev, fix, { mode: 'car' }) === false);
}

// ---------------------------------------------------------------------------
// Capsize
// ---------------------------------------------------------------------------
console.log('\n== Capsize (ingest-store / capsize-clear, in-memory) ==');

{
  const id = 'cap-stay';
  const pos = offset(0, 40);
  await ingest(id, [tipSample(Date.now(), pos.lat, pos.lon)]);
  const a = await capsizeOf(id);
  check('tip stay inverted: sticky active', a.capsize && a.phase === 'active' && !a.responding, {
    detail: `phase=${a.phase} capsize=${a.capsize}`,
  });
}

{
  const id = 'cap-right';
  const pos = offset(0, 80);
  await ingest(id, [tipSample(Date.now() - 1500, pos.lat, pos.lon)]);
  await ingest(id, [uprightSample(Date.now(), pos.lat, pos.lon)]);
  const a = await capsizeOf(id);
  check('tip then right, no ack: fleet sticky remains', a.capsize && a.phase === 'active', {
    detail: `phase=${a.phase} (phone upright must not clear Manager)`,
  });
}

{
  const id = 'cap-onway';
  const pos = offset(0, 120);
  await ingest(id, [tipSample(Date.now(), pos.lat, pos.lon)]);
  const ack = await store.clearCapsizeAlert(ORG, id, {
    ackKind: 'responding',
    ackedBy: 'Coach Tom',
    ackSource: 'manager',
  });
  const a = await capsizeOf(id);
  check('manager on-the-way: sticky stays, phase responding', a.capsize && a.phase === 'responding' && a.responding && a.respondingBy === 'Coach Tom' && ack.ackKind === 'responding' && (ack.cleared || []).length === 0, {
    detail: `phase=${a.phase} by=${a.respondingBy} helpNotified=${JSON.stringify(ack.helpNotified)}`,
  });
  if (!ack.helpNotified?.length) {
    drift.push('Help-on-the-way text is sent via db.setRegattaMessage — no-op without Postgres (explainer always shows the HUD). Shout stop is native.');
  }
}

{
  const id = 'cap-athlete';
  const pos = offset(0, 160);
  await ingest(id, [tipSample(Date.now() - 400, pos.lat, pos.lon)]);
  await ingest(id, [recallSample(Date.now(), pos.lat, pos.lon)]);
  const a = await capsizeOf(id);
  const log = await dayLog.listDayLog(ORG);
  const events = log?.events || [];
  const mine = events.find((e) => e.deviceId === id);
  check('athlete I\'m OK: crew safe, sticky cleared', !a.capsize, {
    detail: `capsize=${a.capsize} logStatus=${mine?.status} ackedBy=${mine?.ackedBy}`,
  });
  check('athlete I\'m OK: day log Crew OK — false alarm', Boolean(mine) && /crew ok|false alarm/i.test(String(mine.ackedBy || '')), {
    detail: `ackedBy=${mine?.ackedBy} status=${mine?.status}`,
  });
}

{
  const idMgr = 'cap-safe-mgr';
  const idRs = 'cap-safe-rs';
  const posM = offset(0, 200);
  const posR = offset(0, 240);
  await ingest(idMgr, [tipSample(Date.now(), posM.lat, posM.lon)]);
  await ingest(idRs, [tipSample(Date.now(), posR.lat, posR.lon)]);
  const mgr = await store.clearCapsizeAlert(ORG, idMgr, {
    ackKind: 'safe',
    ackedBy: 'Coach Tom',
    ackSource: 'manager',
  });
  const rs = await store.clearCapsizeAlert(ORG, idRs, {
    ackKind: 'safe',
    ackedBy: 'RowSafe',
    ackSource: 'rowsafe',
  });
  const aM = await capsizeOf(idMgr);
  const aR = await capsizeOf(idRs);
  check('crew is safe (manager, per-boat): sticky cleared', !aM.capsize && mgr.ackKind === 'safe', {
    detail: `cleared=${JSON.stringify(mgr.cleared)}`,
  });
  check('crew is safe (rowsafe, per-boat): sticky cleared', !aR.capsize && rs.ackKind === 'safe', {
    detail: `cleared=${JSON.stringify(rs.cleared)}`,
  });
}

{
  const id = 'cap-offline';
  const pos = offset(0, 280);
  const queuedTip = [tipSample(Date.now(), pos.lat, pos.lon)];
  const before = await capsizeOf(id);
  check('offline tip: fleet quiet until reconnect (queue not ingested)', !before.capsize, {
    detail: 'no recordBatch yet',
  });
  await ingest(id, queuedTip);
  const after = await capsizeOf(id);
  check('offline reconnect: queued capsize:true raises sticky', after.capsize && after.phase === 'active', {
    detail: `phase=${after.phase}`,
  });
}

{
  const idA = 'cap-two-a';
  const idB = 'cap-two-b';
  const posA = offset(20, 320);
  const posB = offset(-20, 320);
  await ingest(idA, [tipSample(Date.now(), posA.lat, posA.lon)]);
  await ingest(idB, [tipSample(Date.now(), posB.lat, posB.lon)]);
  const fleetWay = await store.clearCapsizeAlert(ORG, undefined, {
    ackKind: 'responding',
    ackedBy: 'Coach Tom',
    ackSource: 'manager',
  });
  const aA = await capsizeOf(idA);
  const aB = await capsizeOf(idB);
  check('two boats: manager ack (no deviceId) covers unacked boats (both responding)', aA.phase === 'responding' && aB.phase === 'responding' && (fleetWay.responded || []).length >= 2, {
    detail: `responded=${JSON.stringify(fleetWay.responded)}`,
  });
}

{
  const idA = 'cap-per-a';
  const idB = 'cap-per-b';
  const posA = offset(20, 360);
  const posB = offset(-20, 360);
  await ingest(idA, [tipSample(Date.now(), posA.lat, posA.lon)]);
  await ingest(idB, [tipSample(Date.now(), posB.lat, posB.lon)]);
  await ingest(idA, [recallSample(Date.now(), posA.lat, posA.lon)]);
  const aA = await capsizeOf(idA);
  const aB = await capsizeOf(idB);
  check('two boats: athlete I\'m OK is per-boat (A safe, B still sticky)', !aA.capsize && aB.capsize && aB.phase === 'active', {
    detail: `A=${aA.phase} B=${aB.phase}`,
  });
  await store.clearCapsizeAlert(ORG, idB, {
    ackKind: 'safe',
    ackedBy: 'RowSafe',
    ackSource: 'rowsafe',
  });
  const bAfter = await capsizeOf(idB);
  check('two boats: RowSafe crew-safe is per-boat (B cleared)', !bAfter.capsize);
}

{
  const idRearm = 'cap-rearm';
  const idHold = 'cap-hold';
  const posR = offset(0, 400);
  const posH = offset(0, 440);
  await ingest(idRearm, [tipSample(Date.now(), posR.lat, posR.lon)]);
  await store.clearCapsizeAlert(ORG, idRearm, {
    ackKind: 'safe',
    ackedBy: 'Coach Tom',
    ackSource: 'manager',
  });
  const immediate = await ingest(idRearm, [tipSample(Date.now(), posR.lat, posR.lon)]);
  const rearmNow = await capsizeOf(idRearm);
  check('60s re-arm: tip immediately after crew-safe is ignored', !rearmNow.capsize, {
    detail: `received=${immediate.received} capsize=${rearmNow.capsize}`,
  });

  await ingest(idHold, [tipSample(Date.now() - 200, posH.lat, posH.lon)]);
  await ingest(idHold, [recallSample(Date.now(), posH.lat, posH.lon)]);
  const holdCleared = await capsizeOf(idHold);
  check('hold-until-upright: athlete recall clears sticky while still inverted', !holdCleared.capsize);

  await sleep(REARM_MS);

  await ingest(idRearm, [tipSample(Date.now(), posR.lat, posR.lon)]);
  const rearmLater = await capsizeOf(idRearm);
  checkWait('60s re-arm: tip after cooldown raises sticky again', rearmLater.capsize && rearmLater.phase === 'active', {
    detail: `phase=${rearmLater.phase}`,
  });

  await ingest(idHold, [tipSample(Date.now(), posH.lat, posH.lon)]);
  const holdStill = await capsizeOf(idHold);
  checkWait('hold-until-upright: tip after 60s still ignored while inverted', !holdStill.capsize, {
    detail: `capsize=${holdStill.capsize}`,
  });
  await ingest(idHold, [uprightSample(Date.now(), posH.lat, posH.lon)]);
  await ingest(idHold, [tipSample(Date.now(), posH.lat, posH.lon)]);
  const holdReleased = await capsizeOf(idHold);
  checkWait('hold-until-upright: after upright, a new tip can fire', holdReleased.capsize && holdReleased.phase === 'active', {
    detail: `phase=${holdReleased.phase}`,
  });
}

{
  const filterNearby = filterOutlierGpsFixes(
    [
      { t: 1_000, ...ORIGIN, acc: 6 },
      { t: 46_000, ...offset(40), acc: 6 },
    ],
    { mode: 'rowing' },
  );
  const filterLeap = filterOutlierGpsFixes(
    [
      { t: 1_000, ...ORIGIN, acc: 6 },
      { t: 46_000, ...offset(4000), acc: 6 },
    ],
    { mode: 'rowing' },
  );
  check('helper: 40m / 45s nearby resume kept', filterNearby.length === 2);
  check('helper: 4km / 45s leap dropped', filterLeap.length === 1);
}

const fail = results.filter((r) => !r.pass);
const passN = results.filter((r) => r.pass).length;

const out = {
  ranAt: new Date().toISOString(),
  quick: QUICK,
  hasDb: store.hasDb(),
  passN,
  failN: fail.length,
  results,
  drift,
  apkOnly,
  metrics: store.getMetrics(),
};

writeFileSync(join(HERE, '_tmp-gps-capsize-scenarios.out.json'), JSON.stringify(out, null, 2));

console.log('\n== Summary ==');
console.log(JSON.stringify({
  passN,
  failN: fail.length,
  fail: fail.map((f) => f.name),
  drift,
  apkOnly,
  quick: QUICK,
}, null, 2));

if (fail.length) process.exitCode = 1;
