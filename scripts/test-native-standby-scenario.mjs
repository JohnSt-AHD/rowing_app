#!/usr/bin/env node
/**
 * Simulates the native geofence standby scenario (Phase 1+2):
 * record → enter RNZ → auto-stop → standby → reboot → leave RNZ → auto-start.
 * Uses production /api/geofences when INGEST_TOKEN is available.
 */

import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.CREWSIGHT_BASE ?? 'https://rowing-app-recorder-pwa.vercel.app';
const STANDBY_MAX_FIX_AGE_MS = 20_000;

const pass = (label, detail = '') => console.log(`PASS ${label}${detail ? ` - ${detail}` : ''}`);
const fail = (label, detail = '') => console.log(`FAIL ${label}${detail ? ` - ${detail}` : ''}`);
const info = (label, detail = '') => console.log(`INFO ${label}${detail ? ` - ${detail}` : ''}`);

function readEnvToken() {
  if (process.env.INGEST_TOKEN) return { token: process.env.INGEST_TOKEN, source: 'process.env' };
  for (const file of ['.env.local', '.env.vercel.local', '.env']) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*INGEST_TOKEN\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[1].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value) return { token: value, source: file };
    }
  }
  return { token: '', source: '' };
}

const EARTH_RADIUS_M = 6371000;
const toRad = (deg) => (deg * Math.PI) / 180;
function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
function pointInCircle(lat, lon, centerLat, centerLon, radiusM) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Number.isFinite(centerLat) &&
    Number.isFinite(centerLon) &&
    Number.isFinite(radiusM) &&
    radiusM > 0 &&
    distanceM(lat, lon, centerLat, centerLon) <= radiusM
  );
}
function pointInPolygon(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i].map(Number);
    const [yj, xj] = ring[j].map(Number);
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function parsePolygon(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const ring = [];
  for (const point of value) {
    if (Array.isArray(point) && point.length >= 2) {
      const lat = Number(point[0]);
      const lon = Number(point[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    }
  }
  return ring.length >= 3 ? ring : [];
}
function pointInGeofence(g, lat, lon) {
  if (!g || g.enabled === false) return false;
  if (g.kind && g.kind !== 'boat_park') return false;
  const shape = String(g.shapeType ?? g.shape_type ?? 'circle').toLowerCase();
  if (shape === 'polygon') {
    return pointInPolygon(lat, lon, parsePolygon(g.polygonCoords ?? g.polygon_coords));
  }
  return pointInCircle(
    lat,
    lon,
    Number(g.centerLat ?? g.center_lat),
    Number(g.centerLon ?? g.center_lon),
    Number(g.radiusM ?? g.radius_m),
  );
}
function findBoatParkAt(lat, lon, geofences) {
  for (const g of geofences) {
    if (pointInGeofence(g, lat, lon)) return g;
  }
  return null;
}
function autoStartOnExit(g) {
  return g?.autoStartOnExit === true || g?.auto_start_on_exit === true;
}
function autoStopOnEnter(g) {
  return g?.autoStopOnEnter === true || g?.auto_stop_on_enter === true;
}
function sessionDwellSec(g) {
  const v = Number(g?.sessionDwellSec ?? g?.session_dwell_sec);
  return Number.isFinite(v) && v >= 5 ? Math.min(600, Math.max(5, Math.round(v))) : 45;
}
function standbyDwellMs(geofences) {
  for (const g of geofences) {
    if (g?.enabled !== false && autoStartOnExit(g)) {
      return Math.max(5000, sessionDwellSec(g) * 1000);
    }
  }
  return 45_000;
}
function isInsideAutoStartBlockingZone(lat, lon, geofences) {
  const match = findBoatParkAt(lat, lon, geofences);
  return match != null && autoStartOnExit(match);
}
function northOf(point, meters) {
  return { lat: point.lat + meters / 111320, lon: point.lon };
}
function computePoints(zone) {
  const shape = String(zone.shapeType ?? zone.shape_type ?? 'circle').toLowerCase();
  if (shape === 'polygon') {
    const ring = parsePolygon(zone.polygonCoords ?? zone.polygon_coords);
    const sum = ring.reduce((acc, [lat, lon]) => ({ lat: acc.lat + lat, lon: acc.lon + lon }), { lat: 0, lon: 0 });
    const inside = { lat: sum.lat / ring.length, lon: sum.lon / ring.length };
    let maxRadius = 1;
    for (const [lat, lon] of ring) maxRadius = Math.max(maxRadius, distanceM(inside.lat, inside.lon, lat, lon));
    let outside = northOf(inside, Math.max(200, maxRadius + 80));
    let tries = 0;
    while (pointInGeofence(zone, outside.lat, outside.lon) && tries < 6) {
      outside = northOf(inside, Math.max(200, maxRadius + 80) * 2 ** (tries + 1));
      tries += 1;
    }
    return { inside, outside };
  }
  const inside = {
    lat: Number(zone.centerLat ?? zone.center_lat),
    lon: Number(zone.centerLon ?? zone.center_lon),
  };
  const radiusM = Number(zone.radiusM ?? zone.radius_m);
  return { inside, outside: northOf(inside, radiusM + 80) };
}

function createNativeSimulator(geofences) {
  const prefs = {
    recordingActive: false,
    standbyArmed: false,
    sessionId: '',
    deviceId: 'TEST-STANDBY',
    ingestUrl: 'https://example.test/api/ingest',
    standbyOutsideSinceMs: 0,
    standbyLastFreshFixMs: 0,
    standbyInsideZoneName: '',
    standbyAutoStartTriggered: false,
    autoStartedSession: false,
    serviceRunning: false,
    uploadCount: 0,
  };

  let insideSinceMs = null;
  let autoStopFired = false;

  const dwellMs = () => standbyDwellMs(geofences);
  const sessionDwellMs = (g) => Math.max(5000, sessionDwellSec(g) * 1000);

  return {
    prefs: () => ({ ...prefs }),
    startRecording(sessionId) {
      prefs.recordingActive = true;
      prefs.standbyArmed = false;
      prefs.sessionId = sessionId;
      prefs.serviceRunning = true;
      prefs.autoStartedSession = false;
      insideSinceMs = null;
      autoStopFired = false;
    },
    onGpsFix(lat, lon, nowMs, fixAgeMs = 0) {
      if (!prefs.serviceRunning) return;

      if (prefs.standbyArmed && !prefs.recordingActive) {
        if (fixAgeMs > STANDBY_MAX_FIX_AGE_MS) return;
        prefs.standbyLastFreshFixMs = nowMs;
        const inside = isInsideAutoStartBlockingZone(lat, lon, geofences);
        if (inside) {
          prefs.standbyOutsideSinceMs = 0;
          const match = findBoatParkAt(lat, lon, geofences);
          prefs.standbyInsideZoneName = match?.name ?? 'boat park';
        } else {
          if (!prefs.standbyOutsideSinceMs) prefs.standbyOutsideSinceMs = nowMs;
          if (!prefs.standbyAutoStartTriggered && nowMs - prefs.standbyOutsideSinceMs >= dwellMs()) {
            prefs.standbyAutoStartTriggered = true;
            prefs.recordingActive = true;
            prefs.standbyArmed = false;
            prefs.sessionId = `auto-${nowMs}`;
            prefs.autoStartedSession = true;
            prefs.uploadCount += 1;
            insideSinceMs = null;
            autoStopFired = false;
          }
        }
        return;
      }

      if (!prefs.recordingActive) return;

      const match = findBoatParkAt(lat, lon, geofences);
      if (match && autoStopOnEnter(match)) {
        if (insideSinceMs == null) insideSinceMs = nowMs;
        if (!autoStopFired && nowMs - insideSinceMs >= sessionDwellMs(match)) {
          autoStopFired = true;
          this.transitionToStandby(nowMs);
        }
      } else {
        insideSinceMs = null;
        autoStopFired = false;
        prefs.uploadCount += 1;
      }
    },
    transitionToStandby(nowMs) {
      prefs.recordingActive = false;
      prefs.standbyArmed = true;
      prefs.standbyOutsideSinceMs = 0;
      prefs.standbyLastFreshFixMs = nowMs;
      prefs.standbyAutoStartTriggered = false;
      prefs.autoStartedSession = false;
      prefs.serviceRunning = true;
    },
    simulateReboot() {
      if (!prefs.standbyArmed && !prefs.recordingActive) {
        prefs.serviceRunning = false;
        return false;
      }
      prefs.serviceRunning = true;
      return true;
    },
    shouldResumeAfterBoot() {
      const hasRecording =
        prefs.recordingActive && prefs.sessionId && prefs.deviceId && prefs.ingestUrl;
      const hasStandby =
        prefs.standbyArmed && !prefs.recordingActive && prefs.deviceId && prefs.ingestUrl;
      return Boolean(hasRecording || hasStandby);
    },
  };
}

function runScenario(geofences, points, label) {
  console.log(`\n${label}`);
  info('geofence order', geofences.map((g) => g.name).join(' → '));

  const matchAtCompound = findBoatParkAt(points.inside.lat, points.inside.lon, geofences);
  info(
    'compound match',
    `${matchAtCompound?.name ?? 'none'} autoStop=${autoStopOnEnter(matchAtCompound)} autoStart=${autoStartOnExit(matchAtCompound)}`,
  );

  const sim = createNativeSimulator(geofences);
  let ok = true;

  sim.startRecording('session-1');
  sim.onGpsFix(points.outside.lat, points.outside.lon, 0, 0);
  if (!sim.prefs().recordingActive) {
    fail('step 1 recording on water');
    ok = false;
  } else {
    pass('step 1 recording on water');
  }

  sim.onGpsFix(points.inside.lat, points.inside.lon, 1000, 0);
  for (let t = 2000; t <= 46_000; t += 1000) {
    sim.onGpsFix(points.inside.lat, points.inside.lon, t, 0);
  }
  const afterStop = sim.prefs();
  if (!afterStop.recordingActive && afterStop.standbyArmed && afterStop.serviceRunning) {
    pass('step 2 auto-stop → native standby');
  } else {
    fail('step 2 auto-stop → native standby', JSON.stringify(afterStop));
    ok = false;
  }

  if (sim.simulateReboot() && sim.shouldResumeAfterBoot() && sim.prefs().standbyArmed) {
    pass('step 3 reboot restores standby');
  } else {
    fail('step 3 reboot restores standby', JSON.stringify(sim.prefs()));
    ok = false;
  }

  for (let t = 50_000; t <= 120_000; t += 5000) {
    sim.onGpsFix(points.inside.lat, points.inside.lon, t, 0);
  }
  if (!sim.prefs().recordingActive && sim.prefs().standbyArmed) {
    pass('step 4 inside compound after reboot — no auto-start');
  } else {
    fail('step 4 inside compound after reboot', JSON.stringify(sim.prefs()));
    ok = false;
  }

  sim.onGpsFix(points.outside.lat, points.outside.lon, 125_000, 0);
  for (let t = 126_000; t <= 171_000; t += 1000) {
    sim.onGpsFix(points.outside.lat, points.outside.lon, t, 0);
  }
  const afterStart = sim.prefs();
  if (
    afterStart.recordingActive &&
    !afterStart.standbyArmed &&
    afterStart.autoStartedSession &&
    afterStart.sessionId.startsWith('auto-')
  ) {
    pass('step 5 leave compound → auto-start new session', `sessionId=${afterStart.sessionId}`);
  } else {
    fail('step 5 leave compound → auto-start', JSON.stringify(afterStart));
    ok = false;
  }

  return ok;
}

async function fetchProductionGeofences(token) {
  const res = await fetch(`${BASE}/api/geofences`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.geofences) ? data.geofences : [];
}

async function main() {
  console.log('Native standby scenario test');
  console.log(`BASE=${BASE}`);

  const { token, source } = readEnvToken();
  let geofences;
  let points;
  let prodConfigOk = false;

  if (token) {
    pass('token lookup', source);
    try {
      geofences = await fetchProductionGeofences(token);
      const rnz =
        geofences.find((g) => /rowing nz/i.test(String(g.name ?? ''))) ??
        geofences.find((g) => g.suppressRecording || g.suppress_recording);
      if (!rnz) throw new Error('Rowing NZ / suppress zone not found');
      points = computePoints(rnz);
      pass(
        'production geofence config',
        `${rnz.name}: autoStop=${autoStopOnEnter(rnz)} autoStart=${autoStartOnExit(rnz)} dwell=${sessionDwellSec(rnz)}s`,
      );
      prodConfigOk = true;
    } catch (e) {
      fail('production geofence fetch', e.message);
    }
  } else {
    fail('token lookup', 'INGEST_TOKEN not found — using fallback geofences only');
    const rnz = {
      id: 29,
      name: 'Rowing NZ',
      kind: 'boat_park',
      shapeType: 'polygon',
      enabled: true,
      suppressRecording: true,
      autoStopOnEnter: true,
      autoStartOnExit: true,
      sessionDwellSec: 45,
      polygonCoords: [
        [-37.9318, 175.543],
        [-37.9319, 175.5432],
        [-37.9321, 175.5431],
        [-37.932, 175.5428],
      ],
    };
    geofences = [rnz];
    points = computePoints(rnz);
    prodConfigOk = true;
  }

  if (!geofences || !points) {
    process.exitCode = 1;
    return;
  }

  const prodSimOk = runScenario(geofences, points, 'PRODUCTION ORDER SCENARIO');

  // If a large outer zone shadows RNZ, show that explicitly.
  const warmup = {
    name: 'Warmup',
    kind: 'boat_park',
    shapeType: 'circle',
    centerLat: points.inside.lat,
    centerLon: points.inside.lon,
    radiusM: 3000,
    enabled: true,
    autoStartOnExit: false,
    autoStopOnEnter: false,
    sessionDwellSec: 45,
  };
  const shadowedFailed = !runScenario(
    [warmup, ...geofences.filter((g) => /rowing nz|geofence/i.test(String(g.name ?? '')))],
    points,
    'SHADOWED ORDER (outer zone first — expect auto-stop failure)',
  );

  if (shadowedFailed) {
    pass(
      'geofence order caveat',
      'auto-stop/auto-start require RNZ to win findBoatParkAt at the compound',
    );
  } else {
    fail('geofence order caveat', 'expected shadowed order to fail step 2');
  }

  console.log('');
  if (prodSimOk && prodConfigOk) {
    pass('overall', 'intended scenario passes with production geofence order');
    console.log('\nDevice validation still required on Android APK:');
    console.log('  auto-stop → power off/on → leave RNZ without opening app.');
  } else {
    fail('overall');
  }
  process.exitCode = prodSimOk && prodConfigOk ? 0 : 1;
}

main().catch((e) => {
  fail('unexpected', e?.stack || e?.message || String(e));
  process.exitCode = 1;
});
