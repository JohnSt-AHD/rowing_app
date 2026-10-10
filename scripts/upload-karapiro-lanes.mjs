#!/usr/bin/env node
/**
 * Upload Karāpiro traffic-lane geofences from the draft GeoJSON to org(s).
 *
 * Usage:
 *   node scripts/upload-karapiro-lanes.mjs --dry-run
 *   node scripts/upload-karapiro-lanes.mjs --orgs=test,rnz --replace
 *
 * Auth (first match wins per org slug):
 *   ORG_TOKENS={"test":"...","rnz":"..."}
 *   ROWING_TOKEN_TEST / ROWING_TOKEN_RNZ
 *   ROWING_TOKEN (used for every org if set alone)
 *
 * Env:
 *   ROWING_API — API base (default https://rowing-app-recorder-pwa.vercel.app)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GEOJSON_PATH = resolve(
  ROOT,
  'apps/recorder-pwa/public/karapiro-lanes-draft.geojson',
);

/** Load KEY=VAL from a .env file into process.env (no overwrite of existing). */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = val;
    }
  }
}

loadEnvFile(resolve(ROOT, '.env'));
loadEnvFile(resolve(ROOT, '.env.local'));
loadEnvFile(resolve(ROOT, 'apps/recorder-pwa/.env.local'));

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
    orgs: { type: 'string', default: 'test,rnz' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/upload-karapiro-lanes.mjs [--dry-run] [--replace] [--orgs=test,rnz]

Uploads lane_up, lane_down, lane_nogo, and turnaround polygons from
apps/recorder-pwa/public/karapiro-lanes-draft.geojson.

--replace  Delete existing geofences whose names match the draft lane names first.`);
  process.exit(0);
}

const ROWING = (process.env.ROWING_API || 'https://rowing-app-recorder-pwa.vercel.app').replace(
  /\/$/,
  '',
);

const LANE_NAME_MARKERS = [
  'up lane',
  'down lane',
  'no-go',
  'nogo',
  'weather buoy',
  'turnaround',
  'karāpiro traffic',
  'karapiro traffic',
];

function parseOrgTokens() {
  const map = {};
  const raw = process.env.ORG_TOKENS;
  if (raw) {
    try {
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        if (v) map[String(k).toLowerCase()] = String(v);
      }
    } catch {
      console.error('ORG_TOKENS is not valid JSON');
      process.exit(1);
    }
  }
  if (process.env.ROWING_TOKEN_TEST) map.test = process.env.ROWING_TOKEN_TEST;
  if (process.env.ROWING_TOKEN_RNZ) map.rnz = process.env.ROWING_TOKEN_RNZ;
  if (process.env.ROWING_TOKEN) {
    const t = process.env.ROWING_TOKEN;
    for (const slug of String(values.orgs).split(',').map((s) => s.trim().toLowerCase())) {
      if (slug && !map[slug]) map[slug] = t;
    }
  }
  return map;
}

function ringToLatLon(coords) {
  // GeoJSON: [lon, lat] → CrewSight: [lat, lon]
  const ring = [];
  for (const pt of coords || []) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lon = Number(pt[0]);
    const lat = Number(pt[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
  }
  return ring;
}

function featureToBody(feature, meta) {
  const props = feature.properties || {};
  const geom = feature.geometry;
  if (!geom) return null;
  let kind = String(props.kind || '').toLowerCase();
  const name = String(props.name || props.id || '').trim();
  if (!name) return null;

  // Skip reference layers
  if (kind === 'lake' || kind === 'centerline' || props.style === 'water' || props.style === 'center') {
    return null;
  }
  if (geom.type === 'Point' || props.style === 'buoyMarker') return null;

  if (kind === 'hazard' && (name.toLowerCase().includes('no-go') || name.toLowerCase().includes('nogo'))) {
    kind = 'lane_nogo';
  }
  if (!['lane_up', 'lane_down', 'lane_nogo', 'turnaround'].includes(kind)) {
    return null;
  }

  const notify = kind === 'lane_nogo';
  const body = {
    name,
    kind,
    enabled: true,
    disableCapsize: true,
    suppressRecording: false,
    notifyOnEnter: notify,
    entryNotifyMessage: notify ? 'No-go / safety zone — move to your lane' : '',
    economyIntervalSec: 3,
  };

  if (geom.type === 'Polygon' && geom.coordinates?.[0]) {
    const ring = ringToLatLon(geom.coordinates[0]);
    if (ring.length < 3) return null;
    body.shapeType = 'polygon';
    body.polygonCoords = ring;
    return body;
  }

  // Circle from properties (turnaround radius)
  const radiusM = Number(props.radiusM ?? meta?.turnaround?.radiusM);
  const lat = Number(meta?.turnaround?.lat);
  const lon = Number(meta?.turnaround?.lon);
  if (kind === 'turnaround' && Number.isFinite(radiusM) && Number.isFinite(lat) && Number.isFinite(lon)) {
    body.shapeType = 'circle';
    body.centerLat = lat;
    body.centerLon = lon;
    body.radiusM = radiusM;
    return body;
  }

  return null;
}

function isLaneGeofenceName(name) {
  const n = String(name || '').toLowerCase();
  return LANE_NAME_MARKERS.some((m) => n.includes(m));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${url} → ${res.status} ${data.error || res.statusText}`);
  }
  return data;
}

async function listGeofences(token) {
  const data = await fetchJson(`${ROWING}/api/geofences`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  return data.geofences || [];
}

async function deleteGeofence(token, id) {
  const url = `${ROWING}/api/geofences?id=${encodeURIComponent(String(id))}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DELETE ${id}: ${data.error || res.status}`);
}

async function createGeofence(token, body) {
  const res = await fetch(`${ROWING}/api/geofences`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body.name}: ${data.error || res.status}`);
  return data.geofence;
}

async function uploadForOrg(slug, token, bodies) {
  console.log(`\n=== org:${slug} ===`);
  if (!token) {
    console.error(`  No token for ${slug} — set ORG_TOKENS or ROWING_TOKEN_${slug.toUpperCase()}`);
    return { ok: false, reason: 'no_token' };
  }

  const existing = await listGeofences(token);
  const laneExisting = existing.filter((g) => isLaneGeofenceName(g.name));
  console.log(`  Existing geofences: ${existing.length} (${laneExisting.length} lane-related)`);

  if (values.replace && laneExisting.length) {
    for (const g of laneExisting) {
      console.log(`  delete ${g.id} ${g.name}`);
      if (!values['dry-run']) await deleteGeofence(token, g.id);
    }
  }

  for (const body of bodies) {
    console.log(
      `  POST ${body.kind} ${body.name} (${body.shapeType}, ${
        body.polygonCoords?.length ?? 0
      } pts)`,
    );
    if (!values['dry-run']) {
      const created = await createGeofence(token, body);
      console.log(`    → id ${created?.id}`);
    }
  }
  return { ok: true };
}

async function main() {
  const fc = JSON.parse(readFileSync(GEOJSON_PATH, 'utf8'));
  const meta = fc.properties || {};
  const bodies = [];
  for (const f of fc.features || []) {
    const body = featureToBody(f, meta);
    if (body) bodies.push(body);
  }

  console.log(`Source: ${GEOJSON_PATH}`);
  console.log(`editedAt: ${meta.editedAt || meta.generatedAt || '?'}`);
  console.log(`API: ${ROWING}`);
  console.log(`Features to upload: ${bodies.length}`);
  for (const b of bodies) {
    console.log(`  - ${b.kind}: ${b.name}`);
  }
  if (values['dry-run']) console.log('(dry-run — no writes)');

  if (!bodies.length) {
    console.error('No lane features found in GeoJSON');
    process.exit(1);
  }

  const tokens = parseOrgTokens();
  const orgs = String(values.orgs)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  let failed = 0;
  for (const slug of orgs) {
    try {
      const r = await uploadForOrg(slug, tokens[slug], bodies);
      if (!r.ok) failed += 1;
    } catch (e) {
      console.error(`  ERROR ${slug}: ${e.message || e}`);
      failed += 1;
    }
  }

  if (failed) {
    console.error(`\nFinished with ${failed} org error(s).`);
    process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
