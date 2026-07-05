#!/usr/bin/env node
/**
 * Copy Traccar geofences into CrewSight (POST /api/geofences) for an org.
 *
 * Usage:
 *   node scripts/sync-traccar-geofences.mjs
 *   node scripts/sync-traccar-geofences.mjs --dry-run
 *   node scripts/sync-traccar-geofences.mjs --replace
 *
 * Env:
 *   OVERLAY_URL   — traccar-overlay base (default https://traccar-overlay.vercel.app)
 *   ROWING_API    — CrewSight API base (default production recorder PWA)
 *   ROWING_TOKEN  — ingest token for org (default rnz)
 *   ECONOMY_SEC   — interval for non-RNZ zones (default 3)
 *   RNZ_ECONOMY_SEC — interval for Rowing NZ zone (default 30)
 *   COURSE_ECONOMY_SEC — interval for course zones (default 1)
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
    'update-settings': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/sync-traccar-geofences.mjs [--dry-run] [--replace] [--update-settings]

Imports polygon/circle geofences from Traccar (via overlay snapshot) into CrewSight.
Skips LINESTRING zones. Capsize on for all zones except Rowing NZ.
Intervals: course ${process.env.COURSE_ECONOMY_SEC || 1}s, other non-RNZ ${process.env.ECONOMY_SEC || 3}s, Rowing NZ ${process.env.RNZ_ECONOMY_SEC || 30}s.

--update-settings  Patch economy/capsize on existing CrewSight geofences by name (no geometry changes).`);
  process.exit(0);
}

const OVERLAY = (process.env.OVERLAY_URL || 'https://traccar-overlay.vercel.app').replace(/\/$/, '');
const ROWING = (process.env.ROWING_API || 'https://rowing-app-recorder-pwa.vercel.app').replace(/\/$/, '');
const TOKEN = String(process.env.ROWING_TOKEN || 'rnz').trim();
const ECONOMY_SEC = Number(process.env.ECONOMY_SEC || 3);
const RNZ_ECONOMY_SEC = Number(process.env.RNZ_ECONOMY_SEC || 30);
const COURSE_ECONOMY_SEC = Number(process.env.COURSE_ECONOMY_SEC || 1);

function isRnzBoundaryName(name) {
  const n = String(name || '').toLowerCase();
  return (
    n.includes('rowing nz') ||
    n.includes('row nz') ||
    n.includes('rowsafe') ||
    n.includes('rowing new zealand') ||
    n.includes('rowinghub')
  );
}

function isCourseGeofenceName(name) {
  const n = String(name || '').toLowerCase();
  return n.includes('course');
}

function geofenceSettingsForName(name) {
  if (isRnzBoundaryName(name)) {
    return { economyIntervalSec: RNZ_ECONOMY_SEC, disableCapsize: true };
  }
  if (isCourseGeofenceName(name)) {
    return { economyIntervalSec: COURSE_ECONOMY_SEC, disableCapsize: false };
  }
  return { economyIntervalSec: ECONOMY_SEC, disableCapsize: false };
}

/** @returns {{ shapeType: 'circle'|'polygon', centerLat?: number, centerLon?: number, radiusM?: number, polygonCoords?: number[][] } | null} */
function parseTraccarArea(areaStr) {
  if (!areaStr || typeof areaStr !== 'string') return null;
  const s = areaStr.trim();

  const circleM = s.match(/CIRCLE\s*\(\s*([\d.-]+)\s+([\d.-]+)\s*,\s*([\d.]+)\s*\)/i);
  if (circleM) {
    return {
      shapeType: 'circle',
      centerLat: parseFloat(circleM[1]),
      centerLon: parseFloat(circleM[2]),
      radiusM: parseFloat(circleM[3]),
    };
  }

  const polyM = s.match(/POLYGON\s*\(\s*\(\s*([^)]+)\)\s*\)/i);
  if (polyM) {
    const ring = [];
    for (const part of polyM[1].split(',')) {
      const bits = part.trim().split(/\s+/);
      if (bits.length >= 2) {
        const lat = parseFloat(bits[0]);
        const lon = parseFloat(bits[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lat, lon]);
      }
    }
    if (ring.length >= 3) {
      return { shapeType: 'polygon', polygonCoords: ring };
    }
  }

  return null;
}

function toCrewSightBody(traccarGeo) {
  const parsed = parseTraccarArea(traccarGeo.area);
  if (!parsed) return null;
  const settings = geofenceSettingsForName(traccarGeo.name);
  const body = {
    name: String(traccarGeo.name || `Traccar ${traccarGeo.id}`).trim(),
    kind: 'boat_park',
    enabled: true,
    ...settings,
    shapeType: parsed.shapeType,
  };
  if (parsed.shapeType === 'polygon') {
    body.polygonCoords = parsed.polygonCoords;
  } else {
    body.centerLat = parsed.centerLat;
    body.centerLon = parsed.centerLon;
    body.radiusM = parsed.radiusM;
  }
  return body;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${url} → ${res.status} ${data.error || res.statusText}`);
  }
  return data;
}

async function listCrewSightGeofences() {
  const data = await fetchJson(`${ROWING}/api/geofences`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  return data.geofences || [];
}

async function deleteCrewSightGeofence(id) {
  const url = `${ROWING}/api/geofences?id=${encodeURIComponent(String(id))}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DELETE ${id}: ${data.error || res.status}`);
}

async function createCrewSightGeofence(body) {
  const res = await fetch(`${ROWING}/api/geofences`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${body.name}: ${data.error || res.status}`);
  return data.geofence;
}

async function patchCrewSightGeofence(id, body) {
  const url = `${ROWING}/api/geofences?id=${encodeURIComponent(String(id))}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PATCH ${id}: ${data.error || res.status}`);
  return data.geofence;
}

async function updateExistingSettings() {
  const existing = await listCrewSightGeofences();
  console.log(`Updating settings on ${existing.length} CrewSight geofence(s)…\n`);
  for (const g of existing) {
    const settings = geofenceSettingsForName(g.name);
    console.log(
      `  ${g.name}: every ${settings.economyIntervalSec}s · capsize ${settings.disableCapsize ? 'off' : 'on'}`,
    );
    if (values['dry-run']) continue;
    await patchCrewSightGeofence(g.id, settings);
  }
  if (values['dry-run']) {
    console.log('\nDry run — no changes written.');
    return;
  }
  console.log('\nDone.');
}

async function main() {
  if (values['update-settings']) {
    console.log(`Target: ${ROWING}/api/geofences (token ${TOKEN ? '***' : 'missing'})`);
    console.log(
      `Intervals: course ${COURSE_ECONOMY_SEC}s · other ${ECONOMY_SEC}s · Rowing NZ ${RNZ_ECONOMY_SEC}s\n`,
    );
    await updateExistingSettings();
    return;
  }

  console.log(`Source: ${OVERLAY}/api/traccar?action=snapshot&source=rowing`);
  console.log(`Target: ${ROWING}/api/geofences (token ${TOKEN ? '***' : 'missing'})`);
  console.log(
    `Intervals: course ${COURSE_ECONOMY_SEC}s · other ${ECONOMY_SEC}s · Rowing NZ ${RNZ_ECONOMY_SEC}s\n`,
  );

  const snap = await fetchJson(`${OVERLAY}/api/traccar?action=snapshot&source=rowing`);
  const traccarGeos = Array.isArray(snap.geofences) ? snap.geofences : [];
  console.log(`Traccar geofences: ${traccarGeos.length}`);

  const toImport = [];
  const skipped = [];
  for (const g of traccarGeos) {
    const body = toCrewSightBody(g);
    if (!body) {
      skipped.push(`${g.name} (${(g.area || '').split('(')[0].trim() || 'unknown'})`);
      continue;
    }
    toImport.push(body);
  }

  if (skipped.length) {
    console.log('\nSkipped (unsupported shape — usually LINESTRING):');
    for (const s of skipped) console.log(`  - ${s}`);
  }

  console.log(`\nWill import ${toImport.length} zone(s):`);
  for (const b of toImport) {
    const shape =
      b.shapeType === 'polygon'
        ? `polygon ${b.polygonCoords.length} pts`
        : `circle r=${Math.round(b.radiusM)}m`;
    console.log(`  - ${b.name} · ${shape} · ${b.economyIntervalSec}s · capsize ${b.disableCapsize ? 'off' : 'on'}`);
  }

  if (values['dry-run']) {
    console.log('\nDry run — no changes written.');
    return;
  }

  let existing = await listCrewSightGeofences();
  if (values.replace && existing.length) {
    console.log(`\nRemoving ${existing.length} existing CrewSight geofence(s)…`);
    for (const g of existing) {
      await deleteCrewSightGeofence(g.id);
    }
    existing = [];
  }

  const existingNames = new Set(existing.map((g) => String(g.name).toLowerCase()));
  let created = 0;
  for (const body of toImport) {
    if (existingNames.has(body.name.toLowerCase())) {
      console.log(`Skip existing: ${body.name}`);
      continue;
    }
    const g = await createCrewSightGeofence(body);
    console.log(`Created #${g.id}: ${g.name}`);
    created++;
  }

  const finalList = await listCrewSightGeofences();
  console.log(`\nDone — ${created} created, ${finalList.length} total in CrewSight.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
