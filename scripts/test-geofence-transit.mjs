#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://rowing-app-recorder-pwa.vercel.app';
const DEVICE_ID = 'TEST-GF-JS';
const SESSION_ID = `test-gf-${Date.now()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnvToken() {
  if (process.env.INGEST_TOKEN) {
    return { token: process.env.INGEST_TOKEN, source: 'process.env' };
  }

  for (const file of ['.env.local', '.env.vercel.local', '.env']) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const line of text.split(/\r?\n/)) {
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

function pass(label, detail = '') {
  console.log(`PASS ${label}${detail ? ` - ${detail}` : ''}`);
}

function fail(label, detail = '') {
  console.log(`FAIL ${label}${detail ? ` - ${detail}` : ''}`);
}

function info(label, detail = '') {
  console.log(`INFO ${label}${detail ? ` - ${detail}` : ''}`);
}

function toNum(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

const EARTH_RADIUS_M = 6371000;
function toRad(deg) { return (deg * Math.PI) / 180; }
function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}
function pointInCircle(lat, lon, centerLat, centerLon, radiusM) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(centerLat) && Number.isFinite(centerLon) && Number.isFinite(radiusM) && radiusM > 0 && distanceM(lat, lon, centerLat, centerLon) <= radiusM;
}
function pointInPolygon(lat, lon, ring) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i].map(Number);
    const [yj, xj] = ring[j].map(Number);
    if (![yi, xi, yj, xj].every(Number.isFinite)) return false;
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function parsePolygon(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const ring = [];
  for (const point of value) {
    if (Array.isArray(point) && point.length >= 2) {
      const lat = Number(point[0]);
      const lon = Number(point[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    } else if (point && typeof point === 'object') {
      const lat = Number(point.lat ?? point.latitude);
      const lon = Number(point.lon ?? point.lng ?? point.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
    }
  }
  return ring.length >= 3 ? ring : [];
}
function centroid(ring) {
  const sum = ring.reduce((acc, [lat, lon]) => ({ lat: acc.lat + lat, lon: acc.lon + lon }), { lat: 0, lon: 0 });
  return { lat: sum.lat / ring.length, lon: sum.lon / ring.length };
}
function northOf(point, meters) {
  return { lat: point.lat + meters / 111320, lon: point.lon };
}
function zoneContains(zone, point) {
  const shape = String(zone.shapeType ?? zone.shape_type ?? 'circle').toLowerCase();
  if (shape === 'polygon') {
    const ring = parsePolygon(zone.polygonCoords ?? zone.polygon_coords);
    return pointInPolygon(point.lat, point.lon, ring);
  }
  return pointInCircle(point.lat, point.lon, toNum(zone.centerLat, zone.center_lat), toNum(zone.centerLon, zone.center_lon), toNum(zone.radiusM, zone.radius_m));
}
function computePoints(zone) {
  const shape = String(zone.shapeType ?? zone.shape_type ?? 'circle').toLowerCase();
  if (shape === 'polygon') {
    const ring = parsePolygon(zone.polygonCoords ?? zone.polygon_coords);
    if (!ring.length) throw new Error('selected polygon zone has no usable polygonCoords');
    const inside = centroid(ring);
    let maxRadius = 1;
    for (const [lat, lon] of ring) maxRadius = Math.max(maxRadius, distanceM(inside.lat, inside.lon, lat, lon));
    let outside = northOf(inside, Math.max(200, maxRadius + 80));
    let tries = 0;
    while (zoneContains(zone, outside) && tries < 6) {
      outside = northOf(inside, Math.max(200, maxRadius + 80) * 2 ** (tries + 1));
      tries += 1;
    }
    return { inside, outside };
  }

  const inside = {
    lat: toNum(zone.centerLat, zone.center_lat),
    lon: toNum(zone.centerLon, zone.center_lon),
  };
  const radiusM = toNum(zone.radiusM, zone.radius_m);
  if (!Number.isFinite(inside.lat) || !Number.isFinite(inside.lon) || !Number.isFinite(radiusM)) {
    throw new Error('selected circle zone has invalid center/radius');
  }
  return { inside, outside: northOf(inside, radiusM + 80) };
}

function sampleBatch(point, baseTime = Date.now()) {
  return [0, 1000, 2000].map((offset) => ({
    t: baseTime + offset,
    gps: { lat: point.lat, lon: point.lon, acc: 5, spd: 1 },
  }));
}

async function fetchJson(pathname, token, options = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    const error = new Error(`${res.status} ${res.statusText}: ${JSON.stringify(data).slice(0, 500)}`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function summarizeIngest(data) {
  return `received=${data.received}, total=${data.total}, persisted=${data.persisted}, suppressedInGeofence=${data.suppressedInGeofence ?? 'n/a'}, dropped=${data.dropped ?? 'n/a'}`;
}

function findDeviceObject(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeviceObject(item);
      if (found) return found;
    }
    return null;
  }
  const id = value.deviceId ?? value.device_id ?? value.id ?? value.name;
  if (String(id) === DEVICE_ID) return value;
  for (const key of Object.keys(value)) {
    const found = findDeviceObject(value[key]);
    if (found) return found;
  }
  return null;
}

function pointFromDevice(device) {
  if (!device) return null;
  const gps = device.gps && typeof device.gps === 'object' ? device.gps : {};
  const lat = toNum(device.lat, device.latitude, gps.lat, gps.latitude);
  const lon = toNum(device.lon, device.lng, device.longitude, gps.lon, gps.lng, gps.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function checkMapAbsentOrOutside(label, mapData, outside) {
  const device = findDeviceObject(mapData);
  if (!device) {
    pass(label, `${DEVICE_ID} absent from map`);
    return true;
  }
  const point = pointFromDevice(device);
  if (!point) {
    fail(label, `${DEVICE_ID} present but no readable coordinates`);
    return false;
  }
  const dist = distanceM(point.lat, point.lon, outside.lat, outside.lon);
  if (dist <= 50) {
    pass(label, `${DEVICE_ID} remains near last outside fix (${dist.toFixed(1)}m)`);
    return true;
  }
  fail(label, `${DEVICE_ID} map point moved away from outside fix (${dist.toFixed(1)}m)`);
  return false;
}

function runLocalDwellLogicTest() {
  console.log('\nLOCAL DWELL LOGIC');
  const zone = { centerLat: 0, centerLon: 0, radiusM: 100, sessionDwellSec: 45, autoStartOnExit: true, autoStopOnEnter: true };
  const inside = { lat: 0, lon: 0 };
  const outside = northOf(inside, 200);
  let recording = false;
  let armed = true;
  let outsideSince = null;
  let insideSince = null;
  let startedAt = null;
  let stoppedAt = null;

  function tick(point, nowMs) {
    const isInside = pointInCircle(point.lat, point.lon, zone.centerLat, zone.centerLon, zone.radiusM);
    const dwellMs = zone.sessionDwellSec * 1000;
    if (!recording && armed && zone.autoStartOnExit) {
      if (!isInside) {
        outsideSince ??= nowMs;
        if (nowMs - outsideSince >= dwellMs) {
          recording = true;
          armed = false;
          startedAt = nowMs;
          insideSince = null;
        }
      } else {
        outsideSince = null;
      }
    }
    if (recording && zone.autoStopOnEnter) {
      if (isInside) {
        insideSince ??= nowMs;
        if (nowMs - insideSince >= dwellMs) {
          recording = false;
          stoppedAt = nowMs;
        }
      } else {
        insideSince = null;
      }
    }
  }

  tick(inside, -1000);
  for (let t = 0; t <= 45000; t += 1000) tick(outside, t);
  const startOk = startedAt === 45000 && recording === true;
  if (startOk) pass('local armed inside -> outside 45s -> start', `startedAt=${startedAt}ms`);
  else fail('local armed inside -> outside 45s -> start', `startedAt=${startedAt}, recording=${recording}`);

  for (let t = 45000; t <= 90000; t += 1000) tick(inside, t);
  const stopOk = stoppedAt === 90000 && recording === false;
  if (stopOk) pass('local session inside 45s -> stop', `stoppedAt=${stoppedAt}ms`);
  else fail('local session inside 45s -> stop', `stoppedAt=${stoppedAt}, recording=${recording}`);

  return startOk && stopOk;
}

async function runProductionTransit(token) {
  console.log('\nPRODUCTION TRANSIT');
  info('target', BASE);
  info('device/session', `${DEVICE_ID} / ${SESSION_ID}`);

  let geofencePayload;
  try {
    geofencePayload = await fetchJson('/api/geofences', token);
    pass('GET /api/geofences', `count=${Array.isArray(geofencePayload.geofences) ? geofencePayload.geofences.length : 'n/a'}`);
  } catch (error) {
    fail('GET /api/geofences', error.message);
    return false;
  }

  const geofences = Array.isArray(geofencePayload.geofences) ? geofencePayload.geofences : [];
  const suppressZones = geofences.filter((g) => g?.suppressRecording === true || g?.suppress_recording === true);
  const preferred = suppressZones.find((g) => /geofence|rowing nz/i.test(String(g.name ?? '')));
  const zone = preferred ?? suppressZones[0];
  if (!zone) {
    fail('select suppressRecording zone', 'none returned by production');
    return false;
  }
  pass('select suppressRecording zone', `name=${zone.name ?? zone.id}, shape=${zone.shapeType ?? zone.shape_type ?? 'circle'}`);

  let points;
  try {
    points = computePoints(zone);
    pass('compute inside/outside points', `inside=${points.inside.lat.toFixed(6)},${points.inside.lon.toFixed(6)} outside=${points.outside.lat.toFixed(6)},${points.outside.lon.toFixed(6)}`);
  } catch (error) {
    fail('compute inside/outside points', error.message);
    return false;
  }

  let allOk = true;
  const ingest = async (label, point) => {
    const body = JSON.stringify({ sessionId: SESSION_ID, deviceId: DEVICE_ID, samples: sampleBatch(point) });
    try {
      const data = await fetchJson('/api/ingest', token, { method: 'POST', body });
      pass(label, summarizeIngest(data));
      return data;
    } catch (error) {
      fail(label, error.message);
      allOk = false;
      return null;
    }
  };

  const inside1 = await ingest('POST /api/ingest inside #1', points.inside);
  if (inside1) {
    const suppressed = inside1.received === 0 || Number(inside1.suppressedInGeofence ?? 0) > 0;
    if (suppressed) pass('inside #1 suppressed expectation', summarizeIngest(inside1));
    else { fail('inside #1 suppressed expectation', summarizeIngest(inside1)); allOk = false; }
  }
  await sleep(2000);

  try {
    const map1 = await fetchJson('/api/map-positions?onlineSec=30&staleSec=3600', token);
    const device = findDeviceObject(map1);
    if (!device) pass('map after inside #1', `${DEVICE_ID} absent`);
    else {
      const point = pointFromDevice(device);
      fail('map after inside #1', `${DEVICE_ID} present${point ? ` at ${point.lat},${point.lon}` : ''}`);
      allOk = false;
    }
  } catch (error) {
    fail('GET /api/map-positions after inside #1', error.message);
    allOk = false;
  }

  const outside1 = await ingest('POST /api/ingest outside', points.outside);
  if (outside1) {
    const ok = Number(outside1.received ?? 0) > 0 && outside1.persisted === true;
    if (ok) pass('outside persisted expectation', summarizeIngest(outside1));
    else { fail('outside persisted expectation', summarizeIngest(outside1)); allOk = false; }
  }
  await sleep(2000);

  try {
    const map2 = await fetchJson('/api/map-positions?onlineSec=30&staleSec=3600', token);
    const device = findDeviceObject(map2);
    const point = pointFromDevice(device);
    if (point) {
      const dist = distanceM(point.lat, point.lon, points.outside.lat, points.outside.lon);
      if (dist <= 50) pass('map after outside', `${DEVICE_ID} near outside (${dist.toFixed(1)}m)`);
      else { fail('map after outside', `${DEVICE_ID} not near outside (${dist.toFixed(1)}m)`); allOk = false; }
    } else { fail('map after outside', `${DEVICE_ID} absent or no coordinates`); allOk = false; }
  } catch (error) {
    fail('GET /api/map-positions after outside', error.message);
    allOk = false;
  }

  try {
    const devices = await fetchJson('/api/devices?windowSec=60&onlineSec=30', token);
    const device = findDeviceObject(devices);
    if (device) pass('GET /api/devices after outside', `${DEVICE_ID} present`);
    else { fail('GET /api/devices after outside', `${DEVICE_ID} absent`); allOk = false; }
  } catch (error) {
    fail('GET /api/devices after outside', error.message);
    allOk = false;
  }

  const inside2 = await ingest('POST /api/ingest inside #2', points.inside);
  if (inside2) {
    const suppressed = inside2.received === 0 || Number(inside2.suppressedInGeofence ?? 0) > 0;
    if (suppressed) pass('inside #2 suppressed expectation', summarizeIngest(inside2));
    else { fail('inside #2 suppressed expectation', summarizeIngest(inside2)); allOk = false; }
  }
  await sleep(2000);

  try {
    const map3 = await fetchJson('/api/map-positions?onlineSec=30&staleSec=3600', token);
    if (!checkMapAbsentOrOutside('map after inside #2', map3, points.outside)) allOk = false;
  } catch (error) {
    fail('GET /api/map-positions after inside #2', error.message);
    allOk = false;
  }

  if (allOk) pass('production transit overall');
  else fail('production transit overall');
  return allOk;
}

async function main() {
  console.log('Geofence transit test');
  console.log(`BASE=${BASE}`);
  const localOk = runLocalDwellLogicTest();

  const { token, source } = readEnvToken();
  if (!token) {
    console.log('\nPRODUCTION TRANSIT');
    fail('token lookup', 'INGEST_TOKEN not found in process env, .env.local, .env.vercel.local, or .env');
    fail('production transit overall', 'not run without token');
    process.exitCode = localOk ? 2 : 1;
    return;
  }
  pass('token lookup', `INGEST_TOKEN found in ${source}`);

  const prodOk = await runProductionTransit(token);
  process.exitCode = localOk && prodOk ? 0 : 1;
}

main().catch((error) => {
  fail('unexpected error', error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
