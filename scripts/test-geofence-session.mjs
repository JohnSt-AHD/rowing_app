#!/usr/bin/env node
/**
 * Geofence auto-start / auto-stop polarity (no live GPS).
 *
 * Hits apps/recorder-pwa/api/lib/geofence.js — the same helpers standby
 * (findAutoStartBlockingAt) and recorder (findSessionRestrictionAt +
 * autoStopOnEnter / suppressRecording) use.
 *
 * Usage:
 *   node scripts/test-geofence-session.mjs
 *   node scripts/test-geofence-session.mjs --quick   # same (already local)
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

const {
  normalizeGeofence,
  isSessionRestrictedAt,
  findSessionRestrictionAt,
  findSuppressRecordingAt,
  hasAutoStartZones,
  findAutoStartBlockingAt,
  findAutoStopZoneAt,
  shouldAutoStartAt,
  shouldAutoStopAt,
} = require('../apps/recorder-pwa/api/lib/geofence.js');

const KARAPIRO = { lat: -37.9305, lon: 175.5485 };

function offset(metersNorth, metersEast = 0, from = KARAPIRO) {
  const lat = from.lat + metersNorth / 111320;
  const lon = from.lon + metersEast / (111320 * Math.cos((from.lat * Math.PI) / 180));
  return { lat, lon };
}

function zone(partial) {
  return normalizeGeofence({
    enabled: true,
    shapeType: 'circle',
    centerLat: KARAPIRO.lat,
    centerLon: KARAPIRO.lon,
    radiusM: 100,
    suppressRecording: false,
    autoStopOnEnter: false,
    autoStartOnExit: false,
    sessionDwellSec: 45,
    ...partial,
  });
}

const lake = zone({
  id: 1,
  name: 'Lake Karapiro',
  kind: 'lake',
  radiusM: 2000,
  suppressRecording: true,
  autoStopOnEnter: true,
  autoStartOnExit: true,
});
const park = zone({
  id: 2,
  name: 'Rowing NZ',
  kind: 'boat_park',
  radiusM: 80,
  suppressRecording: true,
  autoStopOnEnter: true,
  autoStartOnExit: true,
});
const pausePark = zone({
  id: 3,
  name: 'Pause only',
  kind: 'boat_park',
  centerLat: offset(0, 300).lat,
  centerLon: offset(0, 300).lon,
  radiusM: 50,
  suppressRecording: true,
  autoStopOnEnter: false,
  autoStartOnExit: false,
});
const hazard = zone({
  id: 4,
  name: 'Weir',
  kind: 'hazard',
  centerLat: offset(400, 0).lat,
  centerLon: offset(400, 0).lon,
  radiusM: 40,
  notifyOnEnter: true,
});

/** RNZ-like: lake + boat park, both with session control. */
const rnz = [lake, park, pausePark, hazard];
/** Empty org: no geofences. */
const empty = [];

const inPark = KARAPIRO;
const onWater = offset(400, 0);
const inPause = offset(0, 300);
const outsideLake = offset(5000, 0);

const results = [];

function check(name, pass, extra = {}) {
  const row = { name, pass: Boolean(pass), ...extra };
  results.push(row);
  const mark = pass ? 'PASS' : 'FAIL';
  const detail = extra.detail ? ` — ${extra.detail}` : '';
  console.log(`  [${mark}] ${name}${detail}`);
  return pass;
}

function zoneName(g) {
  return g ? g.name : null;
}

console.log('\n== Geofence polarity (helpers) ==');

check(
  'lake polarity: inside lake is not restricted',
  !isSessionRestrictedAt(lake, onWater.lat, onWater.lon),
);
check(
  'lake polarity: outside lake is restricted',
  isSessionRestrictedAt(lake, outsideLake.lat, outsideLake.lon),
);
check(
  'boat_park polarity: inside park is restricted',
  isSessionRestrictedAt(park, inPark.lat, inPark.lon),
);
check(
  'boat_park polarity: outside park is not restricted',
  !isSessionRestrictedAt(park, onWater.lat, onWater.lon),
);
check(
  'hazard never session-restricts (even when inside)',
  !isSessionRestrictedAt(hazard, onWater.lat, onWater.lon),
);

console.log('\n== RNZ lake + parks: auto-start / auto-stop ==');

{
  const block = findAutoStartBlockingAt(onWater.lat, onWater.lon, rnz);
  const stop = findAutoStopZoneAt(onWater.lat, onWater.lon, rnz);
  const restrict = findSessionRestrictionAt(onWater.lat, onWater.lon, rnz);
  const suppress = findSuppressRecordingAt(onWater.lat, onWater.lon, rnz);
  check(
    'on water (inside lake, outside park): not blocked / can auto-start',
    block == null &&
      restrict == null &&
      suppress == null &&
      shouldAutoStartAt(onWater.lat, onWater.lon, rnz) === true &&
      shouldAutoStopAt(onWater.lat, onWater.lon, rnz) === false,
    { detail: `block=${zoneName(block)} stop=${zoneName(stop)}` },
  );
}

{
  const block = findAutoStartBlockingAt(inPark.lat, inPark.lon, rnz);
  const stop = findAutoStopZoneAt(inPark.lat, inPark.lon, rnz);
  const restrict = findSessionRestrictionAt(inPark.lat, inPark.lon, rnz);
  check(
    'inside boat park: auto-start blocked (leave park to start)',
    block != null &&
      block.name === 'Rowing NZ' &&
      restrict != null &&
      restrict.name === 'Rowing NZ' &&
      shouldAutoStartAt(inPark.lat, inPark.lon, rnz) === false,
    { detail: `block=${zoneName(block)} restrict=${zoneName(restrict)}` },
  );
  check(
    'inside boat park: auto-stop (re-enter park)',
    stop != null &&
      stop.name === 'Rowing NZ' &&
      shouldAutoStopAt(inPark.lat, inPark.lon, rnz) === true,
    { detail: `stop=${zoneName(stop)}` },
  );
}

{
  const block = findAutoStartBlockingAt(outsideLake.lat, outsideLake.lon, rnz);
  const stop = findAutoStopZoneAt(outsideLake.lat, outsideLake.lon, rnz);
  const restrict = findSessionRestrictionAt(outsideLake.lat, outsideLake.lon, rnz);
  check(
    'outside lake: auto-start blocked (enter lake to start)',
    block != null &&
      block.name === 'Lake Karapiro' &&
      restrict != null &&
      restrict.kind === 'lake' &&
      shouldAutoStartAt(outsideLake.lat, outsideLake.lon, rnz) === false,
    { detail: `block=${zoneName(block)}` },
  );
  check(
    'outside lake: auto-stop (lake kind suppresses outside water)',
    stop != null &&
      stop.name === 'Lake Karapiro' &&
      shouldAutoStopAt(outsideLake.lat, outsideLake.lon, rnz) === true,
    { detail: `stop=${zoneName(stop)}` },
  );
  check(
    'outside lake: recording suppressed',
    findSuppressRecordingAt(outsideLake.lat, outsideLake.lon, rnz)?.name === 'Lake Karapiro',
  );
}

console.log('\n== Empty org (no geofences) ==');

check('empty list: no auto-start zones', hasAutoStartZones(empty) === false);
check(
  'empty list: findAutoStartBlockingAt is null',
  findAutoStartBlockingAt(onWater.lat, onWater.lon, empty) == null,
);
check(
  'empty list: findAutoStopZoneAt is null',
  findAutoStopZoneAt(onWater.lat, onWater.lon, empty) == null,
);
check(
  'empty list: auto-start no-op (shouldAutoStartAt false)',
  shouldAutoStartAt(onWater.lat, onWater.lon, empty) === false &&
    shouldAutoStartAt(inPark.lat, inPark.lon, empty) === false &&
    shouldAutoStartAt(outsideLake.lat, outsideLake.lon, empty) === false,
);
check(
  'empty list: auto-stop no-op (shouldAutoStopAt false)',
  shouldAutoStopAt(onWater.lat, onWater.lon, empty) === false &&
    shouldAutoStopAt(inPark.lat, inPark.lon, empty) === false &&
    shouldAutoStopAt(outsideLake.lat, outsideLake.lon, empty) === false,
);
check(
  'empty list: no suppress',
  findSuppressRecordingAt(onWater.lat, onWater.lon, empty) == null &&
    findSessionRestrictionAt(onWater.lat, onWater.lon, empty) == null,
);

console.log('\n== Pause-only zone (suppress, no auto-stop) ==');

{
  const stop = findAutoStopZoneAt(inPause.lat, inPause.lon, rnz);
  const suppress = findSuppressRecordingAt(inPause.lat, inPause.lon, rnz);
  const restrict = findSessionRestrictionAt(inPause.lat, inPause.lon, rnz);
  const block = findAutoStartBlockingAt(inPause.lat, inPause.lon, rnz);
  check(
    'pause-only park: recording suppressed',
    suppress != null && suppress.name === 'Pause only' && restrict?.name === 'Pause only',
    { detail: `suppress=${zoneName(suppress)}` },
  );
  check(
    'pause-only park: does not auto-stop',
    stop == null && shouldAutoStopAt(inPause.lat, inPause.lon, rnz) === false,
    { detail: `stop=${zoneName(stop)}` },
  );
  check(
    'pause-only park: does not block auto-start (no autoStartOnExit)',
    block == null && shouldAutoStartAt(inPause.lat, inPause.lon, rnz) === true,
    { detail: `block=${zoneName(block)}` },
  );
}

{
  const pauseLake = [
    zone({
      id: 10,
      name: 'Pause lake',
      kind: 'lake',
      radiusM: 2000,
      suppressRecording: true,
      autoStopOnEnter: false,
      autoStartOnExit: false,
    }),
  ];
  check(
    'pause-only lake: outside water suppresses but does not auto-stop',
    findSuppressRecordingAt(outsideLake.lat, outsideLake.lon, pauseLake)?.name === 'Pause lake' &&
      findAutoStopZoneAt(outsideLake.lat, outsideLake.lon, pauseLake) == null &&
      shouldAutoStopAt(outsideLake.lat, outsideLake.lon, pauseLake) === false,
  );
  check(
    'pause-only lake: no auto-start (flag off, empty-org-like no-op)',
    hasAutoStartZones(pauseLake) === false &&
      shouldAutoStartAt(onWater.lat, onWater.lon, pauseLake) === false,
  );
}

console.log('\n== Flags independent of geometry ==');

{
  const startOnlyPark = [
    lake,
    zone({
      id: 20,
      name: 'Start only',
      kind: 'boat_park',
      radiusM: 80,
      suppressRecording: false,
      autoStopOnEnter: false,
      autoStartOnExit: true,
    }),
  ];
  check(
    'auto-start-only park: blocks start inside, does not auto-stop',
    findAutoStartBlockingAt(inPark.lat, inPark.lon, startOnlyPark)?.name === 'Start only' &&
      shouldAutoStartAt(inPark.lat, inPark.lon, startOnlyPark) === false &&
      shouldAutoStopAt(inPark.lat, inPark.lon, startOnlyPark) === false &&
      findSuppressRecordingAt(inPark.lat, inPark.lon, startOnlyPark) == null,
  );
}

const fail = results.filter((r) => !r.pass);
const passN = results.filter((r) => r.pass).length;
const out = {
  ranAt: new Date().toISOString(),
  passN,
  failN: fail.length,
  results,
};

writeFileSync(join(HERE, '_tmp-geofence-session.out.json'), JSON.stringify(out, null, 2));

console.log('\n== Summary ==');
console.log(
  JSON.stringify(
    {
      passN,
      failN: fail.length,
      fail: fail.map((f) => f.name),
    },
    null,
    2,
  ),
);

if (fail.length) process.exitCode = 1;
else console.log(`\nAll ${passN} geofence auto-start/stop tests passed.`);
