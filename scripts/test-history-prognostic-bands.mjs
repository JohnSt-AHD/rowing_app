/**
 * Smoke test: Manager History prognostic bands require a resolvable boat class.
 *
 * Proves:
 *  - bands render thresholds when boatClass is present (incl. short form 1X)
 *  - bands are empty when boatClass is absent (documents the production failure mode)
 *  - normalizeBoatClassCode + parseBoatClass cover the client resolve path
 *
 * Run: node scripts/test-history-prognostic-bands.mjs
 */
import {
  normalizeBoatClassCode,
  parseBoatClass,
  speedMpsForPrognostic,
} from '../packages/rowing-pace/index.js';

function resolveTrackBoatClass(track) {
  return (
    normalizeBoatClassCode(track.boatClass) ||
    parseBoatClass(track.boatClass, track.athleteId, track.deviceId)
  );
}

/** Mirror apps/coach-pwa/src/lib/history-charts.ts#prognosticBandsKmh */
function prognosticBandsKmh(boatClass) {
  if (!boatClass) return [];
  return [60, 70, 80, 90]
    .map((pct) => {
      const mps = speedMpsForPrognostic(pct, boatClass);
      return mps != null && Number.isFinite(mps) ? { pct, y: mps * 3.6 } : null;
    })
    .filter((b) => b != null);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- present boatClass → bands ---
const withClass = resolveTrackBoatClass({ boatClass: 'M1x', athleteId: null, deviceId: 'A1' });
assert(withClass === 'M1x', `expected M1x, got ${withClass}`);
const bandsM1x = prognosticBandsKmh(withClass);
assert(bandsM1x.length === 4, `expected 4 bands for M1x, got ${bandsM1x.length}`);
assert(
  bandsM1x.every((b) => b.y > 10 && b.y < 30),
  `M1x band km/h out of expected range: ${JSON.stringify(bandsM1x)}`,
);

// short form (display code) must still resolve
const short = resolveTrackBoatClass({ boatClass: '1X', athleteId: null, deviceId: 'A1' });
assert(short === 'M1x', `expected 1X → M1x, got ${short}`);
assert(prognosticBandsKmh(short).length === 4, 'short-form 1X should yield bands');

// athlete/device label fallback
const fromLabel = resolveTrackBoatClass({
  boatClass: null,
  athleteId: 'Coach',
  deviceId: 'Karapiro M2x',
});
assert(fromLabel === 'M2x', `expected device label M2x, got ${fromLabel}`);
assert(prognosticBandsKmh(fromLabel).length === 4, 'label-derived class should yield bands');

// --- absent boatClass → no bands (APK-only / null DB failure mode) ---
const missing = resolveTrackBoatClass({ boatClass: null, athleteId: 'John', deviceId: 'PHONE1' });
assert(missing == null, `expected null without class cues, got ${missing}`);
assert(prognosticBandsKmh(missing).length === 0, 'no boatClass ⇒ no prognostic bands');
assert(prognosticBandsKmh(null).length === 0, 'null boatClass ⇒ empty bands');

console.log('ok — history prognostic bands:');
console.log('  M1x bands (km/h):', bandsM1x.map((b) => `${b.pct}%=${b.y.toFixed(2)}`).join(', '));
console.log('  absent class → 0 bands (charts stay uncoloured until API/session supplies boatClass)');
