/**
 * Postgres persistence for RNZ telemetry (Vercel Postgres / Neon).
 * Set POSTGRES_URL in Vercel. Falls back gracefully when unset.
 */

let schemaReady = false;
let orgBootstrapDone = false;

/** @type {Map<string, { id: number, slug: string, name: string }> | null} */
let memoryOrgByHash = null;

function parseOrgTokensEnv() {
  const raw = process.env.ORG_TOKENS;
  if (!raw || !String(raw).trim()) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function buildMemoryOrgRegistry() {
  const { hashToken } = require('./org-auth');
  /** @type {Map<string, { id: number, slug: string, name: string }>} */
  const byHash = new Map();
  let nextId = 1;
  const fromJson = parseOrgTokensEnv();
  if (fromJson) {
    for (const [slug, token] of Object.entries(fromJson)) {
      const plain = String(token ?? '').trim();
      if (!plain) continue;
      const id = slug === 'default' ? 1 : ++nextId;
      const entry = {
        id: slug === 'default' ? 1 : id,
        slug: String(slug),
        name: String(slug).replace(/-/g, ' '),
      };
      byHash.set(hashToken(plain), entry);
      if (slug === 'default') nextId = Math.max(nextId, 1);
    }
  }
  const legacy = String(process.env.INGEST_TOKEN || '').trim();
  if (legacy && !byHash.size) {
    byHash.set(hashToken(legacy), { id: 1, slug: 'default', name: 'Default' });
  }
  if (!byHash.size) {
    byHash.set('__open__', { id: 1, slug: 'default', name: 'Default' });
  }
  return byHash;
}

function getMemoryOrgRegistry() {
  if (!memoryOrgByHash) memoryOrgByHash = buildMemoryOrgRegistry();
  return memoryOrgByHash;
}

function resolveMemoryOrgFromToken(token) {
  const { hashToken, tokensEqual } = require('./org-auth');
  const plain = String(token ?? '').trim();
  const registry = getMemoryOrgRegistry();
  if (plain) {
    const hit = registry.get(hashToken(plain));
    if (hit) return hit;
    const legacy = String(process.env.INGEST_TOKEN || '').trim();
    if (legacy && tokensEqual(plain, legacy)) {
      return registry.get(hashToken(legacy)) || { id: 1, slug: 'default', name: 'Default' };
    }
  }
  const authRequired = Boolean(
    process.env.INGEST_TOKEN || process.env.ORG_TOKENS,
  );
  if (!authRequired) {
    return registry.get('__open__') || { id: 1, slug: 'default', name: 'Default' };
  }
  return null;
}

function hasDb() {
  return Boolean(
    process.env.POSTGRES_URL ||
      process.env.POSTGRES_URL_NON_POOLING ||
      process.env.DATABASE_URL,
  );
}

async function getSql() {
  if (!hasDb()) return null;
  const { sql } = await import('@vercel/postgres');
  return sql;
}

async function initSchema() {
  if (schemaReady || !hasDb()) return;
  const sql = await getSql();
  if (!sql) return;

  await sql`
    CREATE TABLE IF NOT EXISTS rnz_devices (
      id SERIAL PRIMARY KEY,
      unique_id TEXT NOT NULL UNIQUE,
      athlete_id TEXT,
      name TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_sessions (
      session_id TEXT PRIMARY KEY,
      device_ref INTEGER NOT NULL REFERENCES rnz_devices(id),
      unique_id TEXT NOT NULL,
      athlete_id TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_samples (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      device_ref INTEGER NOT NULL REFERENCES rnz_devices(id),
      unique_id TEXT NOT NULL,
      t_ms BIGINT NOT NULL,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      accuracy DOUBLE PRECISION,
      speed DOUBLE PRECISION,
      course DOUBLE PRECISION,
      altitude DOUBLE PRECISION,
      hr INTEGER,
      ax DOUBLE PRECISION,
      ay DOUBLE PRECISION,
      az DOUBLE PRECISION,
      stroke_rate DOUBLE PRECISION,
      capsize BOOLEAN,
      tilt_deg DOUBLE PRECISION
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_idempotency (
      key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      response JSONB NOT NULL
    )
  `;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS stroke_rate DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS capsize BOOLEAN`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS tilt_deg DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS battery_pct SMALLINT`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS heartbeat BOOLEAN`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS compass_deg DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_gps_t_ms BIGINT`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_lat DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_lon DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_gps_accuracy DOUBLE PRECISION`;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS last_gps_ingest_at TIMESTAMPTZ`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_unique_time
      ON rnz_samples (unique_id, t_ms DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_gps_time
      ON rnz_samples (unique_id, t_ms DESC)
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_device_ref_time
      ON rnz_samples (device_ref, t_ms DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_idempotency_created
      ON rnz_idempotency (created_at DESC)
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_geofences (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'boat_park',
      shape_type TEXT NOT NULL DEFAULT 'circle',
      center_lat DOUBLE PRECISION NOT NULL,
      center_lon DOUBLE PRECISION NOT NULL,
      radius_m DOUBLE PRECISION NOT NULL,
      polygon_coords JSONB,
      enabled BOOLEAN NOT NULL DEFAULT true,
      economy_gps_interval_sec DOUBLE PRECISION NOT NULL DEFAULT 30,
      economy_upload_interval_sec DOUBLE PRECISION NOT NULL DEFAULT 30,
      disable_capsize BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE rnz_geofences ADD COLUMN IF NOT EXISTS shape_type TEXT NOT NULL DEFAULT 'circle'`;
  await sql`ALTER TABLE rnz_geofences ADD COLUMN IF NOT EXISTS polygon_coords JSONB`;
  await sql`ALTER TABLE rnz_geofences ADD COLUMN IF NOT EXISTS suppress_recording BOOLEAN NOT NULL DEFAULT true`;
  await sql`ALTER TABLE rnz_geofences ADD COLUMN IF NOT EXISTS auto_stop_on_enter BOOLEAN NOT NULL DEFAULT true`;
  await sql`ALTER TABLE rnz_geofences ADD COLUMN IF NOT EXISTS auto_start_on_exit BOOLEAN NOT NULL DEFAULT true`;
  await sql`ALTER TABLE rnz_geofences ADD COLUMN IF NOT EXISTS session_dwell_sec DOUBLE PRECISION NOT NULL DEFAULT 45`;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_regatta_messages (
      id SERIAL PRIMARY KEY,
      device_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cleared_at TIMESTAMPTZ NULL
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_regatta_messages_active
      ON rnz_regatta_messages (device_id)
      WHERE cleared_at IS NULL
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS rnz_orgs (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE rnz_devices ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES rnz_orgs(id)`;
  await sql`ALTER TABLE rnz_sessions ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES rnz_orgs(id)`;
  await sql`ALTER TABLE rnz_samples ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES rnz_orgs(id)`;
  await sql`ALTER TABLE rnz_geofences ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES rnz_orgs(id)`;
  await sql`ALTER TABLE rnz_regatta_messages ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES rnz_orgs(id)`;
  await sql`ALTER TABLE rnz_idempotency ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES rnz_orgs(id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS rnz_timing_lines (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      line_type TEXT NOT NULL DEFAULT 'split',
      lat1 DOUBLE PRECISION NOT NULL,
      lon1 DOUBLE PRECISION NOT NULL,
      lat2 DOUBLE PRECISION NOT NULL,
      lon2 DOUBLE PRECISION NOT NULL,
      distance_m DOUBLE PRECISION,
      sort_order INTEGER NOT NULL DEFAULT 0,
      course_group TEXT,
      course_bearing_deg DOUBLE PRECISION,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE rnz_timing_lines ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES rnz_orgs(id)`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_timing_lines_org
      ON rnz_timing_lines (org_id, sort_order ASC, distance_m ASC NULLS LAST)
  `;

  if (!globalThis.__rnzRegistryGpsBackfill) {
    globalThis.__rnzRegistryGpsBackfill = true;
    await sql`
      UPDATE rnz_devices d
      SET last_gps_t_ms = s.t_ms,
          last_lat = s.latitude,
          last_lon = s.longitude,
          last_gps_accuracy = s.accuracy
      FROM (
        SELECT DISTINCT ON (unique_id)
          unique_id, t_ms, latitude, longitude, accuracy
        FROM rnz_samples
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY unique_id, t_ms DESC
      ) s
      WHERE d.unique_id = s.unique_id
        AND (d.last_gps_t_ms IS NULL OR d.last_gps_t_ms < s.t_ms)
    `;
  }

  schemaReady = true;
}

function orgDisplayName(slug) {
  if (slug === 'default') return 'Default';
  return String(slug)
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Upsert org rows from ORG_TOKENS / INGEST_TOKEN env. Returns true if any env config was applied. */
async function upsertOrgsFromEnv(sql) {
  const { hashToken } = require('./org-auth');
  const fromJson = parseOrgTokensEnv();
  if (fromJson && Object.keys(fromJson).length) {
    for (const [slug, token] of Object.entries(fromJson)) {
      const plain = String(token ?? '').trim();
      if (!plain) continue;
      await sql`
        INSERT INTO rnz_orgs (slug, name, token_hash)
        VALUES (${String(slug)}, ${orgDisplayName(slug)}, ${hashToken(plain)})
        ON CONFLICT (slug) DO UPDATE SET
          token_hash = EXCLUDED.token_hash,
          name = EXCLUDED.name
      `;
    }
    return true;
  }
  const legacy = String(process.env.INGEST_TOKEN || '').trim();
  if (legacy) {
    await sql`
      INSERT INTO rnz_orgs (slug, name, token_hash)
      VALUES ('default', 'Default', ${hashToken(legacy)})
      ON CONFLICT (slug) DO UPDATE SET
        token_hash = EXCLUDED.token_hash,
        name = EXCLUDED.name
    `;
    return true;
  }
  return false;
}

async function ensureOrgsBootstrapped() {
  if (orgBootstrapDone) return;
  if (!hasDb()) {
    orgBootstrapDone = true;
    return;
  }
  await initSchema();
  const sql = await getSql();
  if (!sql) {
    orgBootstrapDone = true;
    return;
  }

  const { hashToken } = require('./org-auth');

  const syncedFromEnv = await upsertOrgsFromEnv(sql);

  const countRows = await sql`SELECT COUNT(*)::int AS n FROM rnz_orgs`;
  let orgCount = Number(countRows.rows[0]?.n) || 0;

  if (orgCount === 0 && !syncedFromEnv) {
    await sql`
      INSERT INTO rnz_orgs (slug, name, token_hash)
      VALUES ('default', 'Default', ${hashToken('__open__')})
      ON CONFLICT (slug) DO NOTHING
    `;
    orgCount = Number(
      (await sql`SELECT COUNT(*)::int AS n FROM rnz_orgs`).rows[0]?.n,
    );
  }

  const defaultRows = await sql`
    SELECT id FROM rnz_orgs WHERE slug = 'default' ORDER BY id ASC LIMIT 1
  `;
  let defaultOrgId = defaultRows.rows[0]?.id;
  if (!defaultOrgId) {
    const first = await sql`SELECT id FROM rnz_orgs ORDER BY id ASC LIMIT 1`;
    defaultOrgId = first.rows[0]?.id;
  }

  if (defaultOrgId) {
    await sql`UPDATE rnz_devices SET org_id = ${defaultOrgId} WHERE org_id IS NULL`;
    await sql`UPDATE rnz_sessions SET org_id = ${defaultOrgId} WHERE org_id IS NULL`;
    await sql`UPDATE rnz_samples SET org_id = ${defaultOrgId} WHERE org_id IS NULL`;
    await sql`UPDATE rnz_geofences SET org_id = ${defaultOrgId} WHERE org_id IS NULL`;
    await sql`UPDATE rnz_regatta_messages SET org_id = ${defaultOrgId} WHERE org_id IS NULL`;
    await sql`UPDATE rnz_idempotency SET org_id = ${defaultOrgId} WHERE org_id IS NULL`;
  }

  await sql`ALTER TABLE rnz_devices ALTER COLUMN org_id SET NOT NULL`.catch(() => {});
  await sql`ALTER TABLE rnz_sessions ALTER COLUMN org_id SET NOT NULL`.catch(() => {});
  await sql`ALTER TABLE rnz_samples ALTER COLUMN org_id SET NOT NULL`.catch(() => {});

  await sql`ALTER TABLE rnz_devices DROP CONSTRAINT IF EXISTS rnz_devices_unique_id_key`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rnz_devices_org_unique
      ON rnz_devices (org_id, unique_id)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_samples_org_time
      ON rnz_samples (org_id, unique_id, t_ms DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_rnz_geofences_org
      ON rnz_geofences (org_id, name)
  `;

  orgBootstrapDone = true;
}

async function findOrgByTokenHash(tokenHash) {
  if (!hasDb()) return null;
  await ensureOrgsBootstrapped();
  const sql = await getSql();
  const rows = await sql`
    SELECT id, slug, name FROM rnz_orgs WHERE token_hash = ${String(tokenHash)} LIMIT 1
  `;
  return rows.rows[0] || null;
}

async function getDefaultOrg() {
  if (!hasDb()) {
    return resolveMemoryOrgFromToken('') || { id: 1, slug: 'default', name: 'Default' };
  }
  await ensureOrgsBootstrapped();
  const sql = await getSql();
  const rows = await sql`
    SELECT id, slug, name FROM rnz_orgs WHERE slug = 'default' ORDER BY id ASC LIMIT 1
  `;
  if (rows.rows[0]) return rows.rows[0];
  const any = await sql`SELECT id, slug, name FROM rnz_orgs ORDER BY id ASC LIMIT 1`;
  return any.rows[0] || null;
}

async function isOrgAuthRequired() {
  if (!hasDb()) {
    return Boolean(process.env.INGEST_TOKEN || process.env.ORG_TOKENS);
  }
  if (parseOrgTokensEnv() || String(process.env.INGEST_TOKEN || '').trim()) {
    return true;
  }
  await ensureOrgsBootstrapped();
  const sql = await getSql();
  const rows = await sql`SELECT COUNT(*)::int AS n FROM rnz_orgs`;
  const n = Number(rows.rows[0]?.n) || 0;
  if (n === 0) return false;
  const open = await sql`
    SELECT 1 FROM rnz_orgs
    WHERE slug = 'default' AND token_hash = ${require('./org-auth').hashToken('__open__')}
    LIMIT 1
  `;
  if (open.rows.length) return false;
  return true;
}

/**
 * @param {string} slug
 * @param {string} name
 * @param {string} plainToken
 */
async function createOrg(slug, name, plainToken) {
  if (!hasDb()) throw new Error('Database required to create orgs');
  await ensureOrgsBootstrapped();
  const sql = await getSql();
  const { hashToken } = require('./org-auth');
  const s = String(slug).trim().toLowerCase();
  const n = String(name).trim() || s;
  const token = String(plainToken).trim();
  if (!s || !token) throw new Error('slug and token required');
  const rows = await sql`
    INSERT INTO rnz_orgs (slug, name, token_hash)
    VALUES (${s}, ${n}, ${hashToken(token)})
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      token_hash = EXCLUDED.token_hash
    RETURNING id, slug, name
  `;
  return rows.rows[0];
}

async function listOrgs() {
  if (!hasDb()) return [];
  await ensureOrgsBootstrapped();
  const sql = await getSql();
  const rows = await sql`SELECT id, slug, name, created_at FROM rnz_orgs ORDER BY name ASC`;
  return rows.rows;
}

/**
 * @returns {Promise<{ id: number, unique_id: string, athlete_id: string|null, name: string }>}
 */
async function ensureDevice(orgId, uniqueId, athleteId) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const name = String(uniqueId);
  const rows = await sql`
    INSERT INTO rnz_devices (org_id, unique_id, athlete_id, name, last_seen_at)
    VALUES (${orgId}, ${uniqueId}, ${athleteId || null}, ${name}, NOW())
    ON CONFLICT (org_id, unique_id) DO UPDATE SET
      last_seen_at = NOW(),
      athlete_id = COALESCE(EXCLUDED.athlete_id, rnz_devices.athlete_id)
    RETURNING id, unique_id, athlete_id, name
  `;
  return rows.rows[0];
}

async function upsertSession(orgId, sessionId, deviceRef, uniqueId, athleteId) {
  const sql = await getSql();
  await sql`
    INSERT INTO rnz_sessions (org_id, session_id, device_ref, unique_id, athlete_id, started_at, updated_at)
    VALUES (${orgId}, ${sessionId}, ${deviceRef}, ${uniqueId}, ${athleteId || null}, NOW(), NOW())
    ON CONFLICT (session_id) DO UPDATE SET
      updated_at = NOW(),
      athlete_id = COALESCE(EXCLUDED.athlete_id, rnz_sessions.athlete_id)
  `;
}

/**
 * @param {import('@vercel/postgres').QueryResultRow} row
 */
function derivedFromRow(row) {
  /** @type {Record<string, unknown>} */
  const derived = {};
  if (row.stroke_rate != null) derived.strokeRate = Number(row.stroke_rate);
  if (row.capsize === true) derived.capsize = true;
  if (row.tilt_deg != null) derived.tiltDeg = Number(row.tilt_deg);
  if (row.battery_pct != null) derived.batteryPct = Number(row.battery_pct);
  if (row.heartbeat === true) derived.heartbeat = true;
  return Object.keys(derived).length ? derived : undefined;
}

/**
 * @param {Array<{ t: number, gps?: object, motion?: object, hr?: object, derived?: object }>} samples
 */
async function insertSamples(orgId, sessionId, deviceRef, uniqueId, samples) {
  const sql = await getSql();
  const packed = samples.map((s) => {
    const d = s.derived || {};
    return {
      t_ms: Number(s.t),
      latitude: s.gps?.lat ?? null,
      longitude: s.gps?.lon ?? null,
      accuracy: s.gps?.acc ?? null,
      speed: s.gps?.spd ?? null,
      course: s.gps?.hdg ?? null,
      compass_deg: s.gps?.compass ?? null,
      altitude: s.gps?.alt ?? null,
      hr: s.hr?.bpm ?? null,
      ax: s.motion?.ax ?? null,
      ay: s.motion?.ay ?? null,
      az: s.motion?.az ?? null,
      stroke_rate: d.strokeRate ?? null,
      capsize: d.capsize === true ? true : d.capsize === false ? false : null,
      tilt_deg: d.tiltDeg ?? null,
      battery_pct:
        d.batteryPct != null && Number.isFinite(Number(d.batteryPct))
          ? Math.round(Number(d.batteryPct))
          : null,
      heartbeat: d.heartbeat === true ? true : null,
    };
  });
  await sql`
    INSERT INTO rnz_samples (
      org_id, session_id, device_ref, unique_id, t_ms,
      latitude, longitude, accuracy, speed, course, compass_deg, altitude,
      hr, ax, ay, az, stroke_rate, capsize, tilt_deg, battery_pct, heartbeat
    )
    SELECT
      ${orgId}::int, ${sessionId}::text, ${deviceRef}::int, ${uniqueId}::text,
      x.t_ms, x.latitude, x.longitude, x.accuracy, x.speed, x.course, x.compass_deg, x.altitude,
      x.hr, x.ax, x.ay, x.az, x.stroke_rate, x.capsize, x.tilt_deg, x.battery_pct, x.heartbeat
    FROM jsonb_to_recordset(${JSON.stringify(packed)}::jsonb) AS x(
      t_ms bigint,
      latitude double precision,
      longitude double precision,
      accuracy double precision,
      speed double precision,
      course double precision,
      compass_deg double precision,
      altitude double precision,
      hr integer,
      ax double precision,
      ay double precision,
      az double precision,
      stroke_rate double precision,
      capsize boolean,
      tilt_deg double precision,
      battery_pct smallint,
      heartbeat boolean
    )
  `;
}

/**
 * @param {Array<{ t: number, gps?: object }>} samples
 */
async function updateDeviceLatestGps(orgId, uniqueId, samples) {
  let best = null;
  for (const s of samples) {
    const lat = s.gps?.lat;
    const lon = s.gps?.lon;
    if (lat == null || lon == null) continue;
    const t = Number(s.t);
    if (!Number.isFinite(t)) continue;
    if (!best || t >= best.t) {
      best = {
        t,
        lat: Number(lat),
        lon: Number(lon),
        acc:
          s.gps?.acc != null && Number.isFinite(Number(s.gps.acc))
            ? Number(s.gps.acc)
            : null,
      };
    }
  }
  if (!best) return;
  const sql = await getSql();
  await sql`
    UPDATE rnz_devices
    SET last_gps_t_ms = ${best.t},
        last_lat = ${best.lat},
        last_lon = ${best.lon},
        last_gps_accuracy = ${best.acc},
        last_gps_ingest_at = NOW()
    WHERE org_id = ${orgId}
      AND unique_id = ${String(uniqueId)}
      AND (last_gps_t_ms IS NULL OR last_gps_t_ms <= ${best.t})
  `;
}

async function persistBatch(orgId, sessionId, deviceId, athleteId, samples) {
  if (!hasDb() || !samples.length) return false;
  await ensureOrgsBootstrapped();
  const dev = await ensureDevice(orgId, deviceId, athleteId);
  await upsertSession(orgId, sessionId, dev.id, deviceId, athleteId);
  await insertSamples(orgId, sessionId, dev.id, deviceId, samples);
  await updateDeviceLatestGps(orgId, deviceId, samples);
  return true;
}

async function resolveDevice(orgId, deviceIdParam, uniqueIdParam) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  if (uniqueIdParam) {
    const rows = await sql`
      SELECT id, unique_id, athlete_id, name FROM rnz_devices
      WHERE org_id = ${orgId} AND unique_id = ${uniqueIdParam} LIMIT 1
    `;
    return rows.rows[0] || null;
  }
  const n = Number(deviceIdParam);
  if (Number.isFinite(n)) {
    const rows = await sql`
      SELECT id, unique_id, athlete_id, name FROM rnz_devices
      WHERE org_id = ${orgId} AND id = ${n} LIMIT 1
    `;
    return rows.rows[0] || null;
  }
  return null;
}

/** Prefer magnetometer bow heading; fall back to GPS course when moving. */
function resolveCourseFromRow(row) {
  const compass =
    row.compass_deg != null && Number.isFinite(Number(row.compass_deg))
      ? Number(row.compass_deg)
      : null;
  if (compass != null) return compass;
  const spd =
    row.speed != null && Number.isFinite(Number(row.speed)) ? Number(row.speed) : 0;
  const hdg =
    row.course != null && Number.isFinite(Number(row.course)) ? Number(row.course) : null;
  if (spd >= 1.2 && hdg != null) return hdg;
  return hdg ?? 0;
}

function rowToTraccarPosition(row) {
  const fix = new Date(Number(row.t_ms)).toISOString();
  const attrs = {};
  if (row.hr != null) {
    attrs.hr = row.hr;
    attrs.heartRate = row.hr;
  }
  if (row.ax != null) {
    attrs.ax = row.ax;
    attrs.ay = row.ay;
    attrs.az = row.az;
  }
  if (row.stroke_rate != null) attrs.strokeRate = Number(row.stroke_rate);
  if (row.capsize === true) attrs.capsize = true;
  if (row.tilt_deg != null) attrs.tiltDeg = Number(row.tilt_deg);
  if (row.battery_pct != null) attrs.batteryPct = Number(row.battery_pct);
  if (row.heartbeat === true) attrs.heartbeat = true;
  if (row.compass_deg != null && Number.isFinite(Number(row.compass_deg))) {
    attrs.compass = Number(row.compass_deg);
  }
  return {
    id: Number(row.id),
    deviceId: Number(row.device_ref),
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: row.altitude ?? 0,
    speed: row.speed ?? 0,
    course: resolveCourseFromRow(row),
    accuracy: row.accuracy ?? 0,
    fixTime: fix,
    deviceTime: fix,
    serverTime: fix,
    attributes: attrs,
    deviceName: row.unique_id,
  };
}

async function getRoutePositions(orgId, deviceRef, fromIso, toIso) {
  const sql = await getSql();
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  const rows = await sql`
    SELECT id, device_ref, unique_id, t_ms, latitude, longitude, accuracy, speed, course, compass_deg, altitude, hr, ax, ay, az,
      stroke_rate, capsize, tilt_deg
    FROM rnz_samples
    WHERE org_id = ${orgId}
      AND device_ref = ${deviceRef}
      AND t_ms >= ${fromMs}
      AND t_ms <= ${toMs}
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
    ORDER BY t_ms ASC
    LIMIT 50000
  `;
  return rows.rows.map(rowToTraccarPosition);
}

async function getLatestTraccarPositions(orgId, onlineMs = 30000) {
  const sql = await getSql();
  const cutoff = Date.now() - onlineMs;
  const rows = await sql`
    SELECT DISTINCT ON (s.device_ref)
      s.id, s.device_ref, s.unique_id, s.t_ms, s.latitude, s.longitude, s.accuracy, s.speed, s.course, s.compass_deg, s.altitude, s.hr, s.ax, s.ay, s.az,
      s.stroke_rate, s.capsize, s.tilt_deg,
      d.last_seen_at
    FROM rnz_samples s
    JOIN rnz_devices d ON d.id = s.device_ref AND d.org_id = s.org_id
    WHERE s.org_id = ${orgId}
      AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
    ORDER BY s.device_ref, s.t_ms DESC
  `;
  return rows.rows.map(rowToTraccarPosition);
}

/**
 * Recent samples grouped by device (for dashboard when Postgres is enabled).
 * @returns {Promise<Map<string, { deviceId: string, athleteId: string|null, sessionId: string, samples: object[], lastSeenMs: number, firstSeenMs: number }>>}
 */
async function fetchRecentSamplesByDevice(orgId, windowMs) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const cutoff = Date.now() - windowMs;
  const rows = await sql`
    SELECT s.unique_id, s.session_id, s.t_ms,
      s.latitude, s.longitude, s.accuracy, s.speed, s.course, s.compass_deg, s.altitude,
      s.hr, s.ax, s.ay, s.az, s.stroke_rate, s.capsize, s.tilt_deg,
      s.battery_pct, s.heartbeat,
      d.athlete_id
    FROM rnz_samples s
    LEFT JOIN rnz_devices d ON d.org_id = s.org_id AND d.unique_id = s.unique_id
    WHERE s.org_id = ${orgId}
      AND s.t_ms >= ${cutoff}
    ORDER BY s.unique_id, s.t_ms ASC
    LIMIT 80000
  `;

  /** @type {Map<string, object>} */
  const byDevice = new Map();
  for (const row of rows.rows) {
    const uid = String(row.unique_id);
    let entry = byDevice.get(uid);
    const t = Number(row.t_ms);
    const sample = {
      t,
      gps:
        row.latitude != null
          ? {
              lat: row.latitude,
              lon: row.longitude,
              acc: row.accuracy,
              spd: row.speed,
              hdg: row.course,
              alt: row.altitude,
              ...(row.compass_deg != null && Number.isFinite(Number(row.compass_deg))
                ? { compass: Number(row.compass_deg) }
                : {}),
            }
          : undefined,
      hr: row.hr != null ? { bpm: row.hr } : undefined,
      motion:
        row.ax != null ? { ax: row.ax, ay: row.ay, az: row.az } : undefined,
    };
    const derived = derivedFromRow(row);
    if (derived) sample.derived = derived;
    if (!entry) {
      entry = {
        deviceId: uid,
        athleteId: row.athlete_id || null,
        sessionId: String(row.session_id),
        samples: [],
        lastSeenMs: t,
        firstSeenMs: t,
      };
      byDevice.set(uid, entry);
    }
    entry.samples.push(sample);
    if (t >= entry.lastSeenMs) {
      entry.lastSeenMs = t;
      entry.sessionId = String(row.session_id);
    }
    if (t < entry.firstSeenMs) entry.firstSeenMs = t;
    if (row.athlete_id) entry.athleteId = row.athlete_id;
  }
  return byDevice;
}

/**
 * Server ingest times per device (telemetry + last GPS batch).
 * @returns {Promise<Map<string, { lastSeenMs: number, lastGpsIngestMs: number|null }>>}
 */
async function getDeviceRegistryTimes(orgId) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const rows = await sql`
    SELECT unique_id, last_seen_at, last_gps_ingest_at FROM rnz_devices
    WHERE org_id = ${orgId}
  `;
  const byDevice = new Map();
  for (const row of rows.rows) {
    byDevice.set(String(row.unique_id), {
      lastSeenMs: new Date(row.last_seen_at).getTime(),
      lastGpsIngestMs: row.last_gps_ingest_at
        ? new Date(row.last_gps_ingest_at).getTime()
        : null,
    });
  }
  return byDevice;
}

/**
 * Server ingest time per device (updated on each persistBatch).
 * @returns {Promise<Map<string, number>>}
 */
async function getDeviceIngestTimes(orgId) {
  const registry = await getDeviceRegistryTimes(orgId);
  return new Map(
    [...registry.entries()].map(([id, row]) => [id, row.lastSeenMs]),
  );
}

/**
 * Latest GPS fix per device from registry (one row read — works across serverless instances).
 */
async function getRegistryMapPositions(orgId, onlineMs, staleMs) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const now = Date.now();
  const staleCutoff = now - staleMs;
  const rows = await sql`
    SELECT unique_id, athlete_id, last_seen_at,
      last_gps_t_ms, last_lat, last_lon, last_gps_accuracy
    FROM rnz_devices
    WHERE org_id = ${orgId}
      AND last_gps_t_ms IS NOT NULL
      AND last_lat IS NOT NULL
      AND last_lon IS NOT NULL
      AND last_gps_t_ms >= ${staleCutoff}
  `;
  return rows.rows.map((row) => {
    const fixMs = Number(row.last_gps_t_ms);
    const lastSeenMs = Math.max(
      fixMs,
      new Date(row.last_seen_at).getTime(),
    );
    return {
      deviceId: String(row.unique_id),
      athleteId: row.athlete_id || null,
      latitude: row.last_lat,
      longitude: row.last_lon,
      accuracy: row.last_gps_accuracy,
      fixMs,
      fixAgeSec: Math.round((now - fixMs) / 1000),
      lastSeenAgoSec: Math.round((now - lastSeenMs) / 1000),
      online: now - lastSeenMs <= onlineMs,
      hr: null,
    };
  });
}

/**
 * Latest GPS fix per device for dashboard map (within stale window).
 */
async function getMapPositions(orgId, onlineMs, staleMs) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const now = Date.now();
  const staleCutoff = now - staleMs;
  const rows = await sql`
    SELECT DISTINCT ON (s.unique_id)
      s.unique_id, s.latitude, s.longitude, s.accuracy, s.speed, s.course, s.t_ms, s.hr,
      d.last_seen_at, d.athlete_id
    FROM rnz_samples s
    JOIN rnz_devices d ON d.org_id = s.org_id AND d.unique_id = s.unique_id
    WHERE s.org_id = ${orgId}
      AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
      AND s.t_ms >= ${staleCutoff}
    ORDER BY s.unique_id, s.t_ms DESC
  `;
  return rows.rows.map((row) => {
    const fixMs = Number(row.t_ms);
    const lastSeenMs = Math.max(
      fixMs,
      new Date(row.last_seen_at).getTime(),
    );
    return {
      deviceId: String(row.unique_id),
      athleteId: row.athlete_id || null,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracy: row.accuracy,
      speed: row.speed != null ? Number(row.speed) : null,
      course: row.course != null ? Number(row.course) : null,
      fixMs,
      fixAgeSec: Math.round((now - fixMs) / 1000),
      lastSeenAgoSec: Math.round((now - lastSeenMs) / 1000),
      online: now - lastSeenMs <= onlineMs,
      hr: row.hr,
    };
  });
}

/** @returns {Promise<Map<string, { t: number, lat: number, lon: number, acc: number|null }>>} */
async function getRegistryGpsByDevice(orgId) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const rows = await sql`
    SELECT unique_id, last_gps_t_ms, last_lat, last_lon, last_gps_accuracy
    FROM rnz_devices
    WHERE org_id = ${orgId}
      AND last_gps_t_ms IS NOT NULL
      AND last_lat IS NOT NULL
      AND last_lon IS NOT NULL
  `;
  /** @type {Map<string, { t: number, lat: number, lon: number, acc: number|null }>} */
  const byDevice = new Map();
  for (const row of rows.rows) {
    byDevice.set(String(row.unique_id), {
      t: Number(row.last_gps_t_ms),
      lat: row.last_lat,
      lon: row.last_lon,
      acc: row.last_gps_accuracy,
    });
  }
  return byDevice;
}

async function listRegistryDevices(orgId) {
  const sql = await getSql();
  const rows = await sql`
    SELECT id, unique_id, athlete_id, name, first_seen_at, last_seen_at
    FROM rnz_devices
    WHERE org_id = ${orgId}
    ORDER BY last_seen_at DESC
  `;
  return rows.rows.map((d) => ({
    id: Number(d.id),
    name: d.name || d.unique_id,
    uniqueId: d.unique_id,
    status: 'online',
    lastUpdate: d.last_seen_at,
    disabled: false,
    attributes: {
      athleteId: d.athlete_id || '',
      uniqueId: d.unique_id,
    },
  }));
}

/** Devices with sample time range (for dashboard history — not limited to live poll). */
async function listHistoryDevicesDetailed(orgId) {
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const rows = await sql`
    SELECT d.unique_id, d.name, d.last_seen_at,
      MIN(s.t_ms)::bigint AS first_sample_ms,
      MAX(s.t_ms)::bigint AS last_sample_ms,
      COUNT(s.id)::int AS sample_count
    FROM rnz_devices d
    INNER JOIN rnz_samples s ON s.org_id = d.org_id AND s.unique_id = d.unique_id
    WHERE d.org_id = ${orgId}
    GROUP BY d.id, d.unique_id, d.name, d.last_seen_at
    ORDER BY MAX(s.t_ms) DESC
  `;
  return rows.rows.map((r) => ({
    uniqueId: String(r.unique_id),
    name: r.name || r.unique_id,
    lastUpdate: r.last_seen_at,
    firstSampleMs: Number(r.first_sample_ms),
    lastSampleMs: Number(r.last_sample_ms),
    sampleCount: Number(r.sample_count),
  }));
}

async function getTraccarSnapshot(orgId, onlineMs = 120000) {
  const devices = await listRegistryDevices(orgId);
  const positions = await getLatestTraccarPositions(orgId, onlineMs);
  return { devices, positions, geofences: [], groups: [] };
}

async function listSessions(orgId, uniqueId, limit = 100) {
  const sql = await getSql();
  const rows = uniqueId
    ? await sql`
        SELECT session_id, unique_id, athlete_id, started_at, ended_at, updated_at,
          (SELECT COUNT(*)::int FROM rnz_samples WHERE session_id = rnz_sessions.session_id AND org_id = ${orgId}) AS sample_count
        FROM rnz_sessions
        WHERE org_id = ${orgId} AND unique_id = ${uniqueId}
        ORDER BY started_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT session_id, unique_id, athlete_id, started_at, ended_at, updated_at,
          (SELECT COUNT(*)::int FROM rnz_samples WHERE session_id = rnz_sessions.session_id AND org_id = ${orgId}) AS sample_count
        FROM rnz_sessions
        WHERE org_id = ${orgId}
        ORDER BY started_at DESC
        LIMIT ${limit}
      `;
  return rows.rows;
}

/**
 * @param {import('@vercel/postgres').QueryResultRow[]} rows
 */
function buildDashboardHistoryFromRows(rows, meta = {}) {
  /** @type {object[]} */
  const track = [];
  /** @type {object[]} */
  const capsizeEvents = [];
  let gpsCount = 0;

  for (const row of rows) {
    const t = Number(row.t_ms);
    const hasGps = row.latitude != null && row.longitude != null;
    if (hasGps) gpsCount++;
    track.push({
      t,
      lat: hasGps ? row.latitude : null,
      lon: hasGps ? row.longitude : null,
      speed: row.speed != null ? Number(row.speed) : null,
      hr: row.hr != null ? Number(row.hr) : null,
      strokeRate:
        row.stroke_rate != null ? Number(row.stroke_rate) : null,
      capsize: row.capsize === true,
      tiltDeg: row.tilt_deg != null ? Number(row.tilt_deg) : null,
    });
    if (row.capsize === true && hasGps) {
      capsizeEvents.push({
        t,
        lat: row.latitude,
        lon: row.longitude,
        tiltDeg: row.tilt_deg != null ? Number(row.tilt_deg) : null,
      });
    }
  }

  /** Collapse rapid capsize samples into incidents (~60s). */
  const incidents = [];
  for (const ev of capsizeEvents) {
    const prev = incidents[incidents.length - 1];
    if (prev && ev.t - prev.t < 60000) continue;
    incidents.push(ev);
  }

  const MAX_TRACK_POINTS = 4000;
  let trackOut = track;
  let downsampled = false;
  if (track.length > MAX_TRACK_POINTS) {
    const step = Math.ceil(track.length / MAX_TRACK_POINTS);
    trackOut = [];
    for (let i = 0; i < track.length; i += step) trackOut.push(track[i]);
    if (trackOut[trackOut.length - 1] !== track[track.length - 1]) {
      trackOut.push(track[track.length - 1]);
    }
    downsampled = true;
  }

  return {
    ...meta,
    track: trackOut,
    capsizeEvents: incidents,
    capsizeSampleCount: capsizeEvents.length,
    pointCount: track.length,
    gpsCount,
    downsampled,
  };
}

async function getDashboardHistory(orgId, uniqueId, fromIso, toIso) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const fromMs = new Date(fromIso).getTime();
  const toMs = new Date(toIso).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;

  const rows = await sql`
    SELECT t_ms, latitude, longitude, speed, hr, stroke_rate, capsize, tilt_deg
    FROM rnz_samples
    WHERE org_id = ${orgId}
      AND unique_id = ${String(uniqueId)}
      AND t_ms >= ${fromMs}
      AND t_ms <= ${toMs}
    ORDER BY t_ms ASC
    LIMIT 50000
  `;

  return buildDashboardHistoryFromRows(rows.rows, {
    uniqueId: String(uniqueId),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  });
}

async function getDashboardHistoryBySession(orgId, sessionId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const meta = await sql`
    SELECT session_id, unique_id, athlete_id, started_at, ended_at
    FROM rnz_sessions
    WHERE org_id = ${orgId} AND session_id = ${String(sessionId)}
    LIMIT 1
  `;
  if (!meta.rows[0]) return null;
  const row = meta.rows[0];
  const samples = await sql`
    SELECT t_ms, latitude, longitude, speed, hr, stroke_rate, capsize, tilt_deg
    FROM rnz_samples
    WHERE org_id = ${orgId} AND session_id = ${String(sessionId)}
    ORDER BY t_ms ASC
    LIMIT 50000
  `;
  const fromMs = samples.rows.length
    ? Number(samples.rows[0].t_ms)
    : new Date(row.started_at).getTime();
  const toMs = samples.rows.length
    ? Number(samples.rows[samples.rows.length - 1].t_ms)
    : new Date(row.ended_at || row.started_at).getTime();

  return buildDashboardHistoryFromRows(samples.rows, {
    sessionId: row.session_id,
    uniqueId: row.unique_id,
    athleteId: row.athlete_id || null,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  });
}

async function getSessionFromDb(orgId, sessionId) {
  const sql = await getSql();
  const meta = await sql`
    SELECT * FROM rnz_sessions WHERE org_id = ${orgId} AND session_id = ${sessionId} LIMIT 1
  `;
  if (!meta.rows[0]) return null;
  const samples = await sql`
    SELECT t_ms AS t, latitude, longitude, accuracy, speed, course, compass_deg, altitude, hr, ax, ay, az,
      stroke_rate, capsize, tilt_deg, battery_pct, heartbeat
    FROM rnz_samples
    WHERE org_id = ${orgId} AND session_id = ${sessionId}
    ORDER BY t_ms ASC
    LIMIT 50000
  `;
  const row = meta.rows[0];
  return {
    sessionId: row.session_id,
    deviceId: row.unique_id,
    athleteId: row.athlete_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    samples: samples.rows.map((s) => ({
      t: Number(s.t),
      gps:
        s.latitude != null
          ? {
              lat: s.latitude,
              lon: s.longitude,
              acc: s.accuracy,
              spd: s.speed,
              hdg: s.course,
              alt: s.altitude,
              ...(s.compass_deg != null && Number.isFinite(Number(s.compass_deg))
                ? { compass: Number(s.compass_deg) }
                : {}),
            }
          : undefined,
      hr: s.hr != null ? { bpm: s.hr } : undefined,
      motion:
        s.ax != null
          ? { ax: s.ax, ay: s.ay, az: s.az }
          : undefined,
      derived: derivedFromRow(s),
    })),
  };
}

async function getStorageStats(orgId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const fromEnv =
    process.env.POSTGRES_STORAGE_LIMIT_MB ?? process.env.STORAGE_LIMIT_MB;
  const parsed =
    fromEnv != null && String(fromEnv).trim() !== '' ? Number(fromEnv) : NaN;
  const limitMb =
    Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 512;
  const result = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM rnz_devices WHERE org_id = ${orgId}) AS device_count,
      (SELECT COUNT(*)::int FROM rnz_sessions WHERE org_id = ${orgId}) AS session_count,
      (SELECT COUNT(*)::int FROM rnz_samples WHERE org_id = ${orgId}) AS sample_count,
      (SELECT MIN(t_ms)::bigint FROM rnz_samples WHERE org_id = ${orgId}) AS oldest_sample_ms,
      (SELECT MAX(t_ms)::bigint FROM rnz_samples WHERE org_id = ${orgId}) AS newest_sample_ms,
      pg_database_size(current_database())::bigint AS database_size_bytes,
      pg_total_relation_size('rnz_samples')::bigint AS samples_table_bytes
  `;
  const r = result.rows[0];
  const usedBytes =
    r.database_size_bytes != null ? Number(r.database_size_bytes) : null;
  const limitBytes =
    limitMb != null && Number.isFinite(limitMb) && limitMb > 0
      ? Math.round(limitMb * 1024 * 1024)
      : null;
  return {
    deviceCount: Number(r.device_count) || 0,
    sessionCount: Number(r.session_count) || 0,
    sampleCount: Number(r.sample_count) || 0,
    oldestSampleMs:
      r.oldest_sample_ms != null ? Number(r.oldest_sample_ms) : null,
    newestSampleMs:
      r.newest_sample_ms != null ? Number(r.newest_sample_ms) : null,
    usedBytes,
    samplesTableBytes:
      r.samples_table_bytes != null ? Number(r.samples_table_bytes) : null,
    storageLimitBytes: limitBytes,
    storageUsedPct:
      usedBytes != null && limitBytes != null && limitBytes > 0
        ? Math.round((usedBytes / limitBytes) * 1000) / 10
        : null,
  };
}

async function deleteSession(orgId, sessionId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const sid = String(sessionId);
  const delSamples = await sql`
    DELETE FROM rnz_samples WHERE org_id = ${orgId} AND session_id = ${sid}
  `;
  const delSession = await sql`
    DELETE FROM rnz_sessions WHERE org_id = ${orgId} AND session_id = ${sid}
  `;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delSession.rowCount ?? 0,
  };
}

async function deleteDeviceData(orgId, uniqueId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const uid = String(uniqueId);
  const delSamples = await sql`
    DELETE FROM rnz_samples WHERE org_id = ${orgId} AND unique_id = ${uid}
  `;
  const delSessions = await sql`
    DELETE FROM rnz_sessions WHERE org_id = ${orgId} AND unique_id = ${uid}
  `;
  const delDevice = await sql`
    DELETE FROM rnz_devices WHERE org_id = ${orgId} AND unique_id = ${uid}
  `;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delSessions.rowCount ?? 0,
    devicesDeleted: delDevice.rowCount ?? 0,
  };
}

async function deleteSamplesInRange(orgId, uniqueId, fromMs, toMs) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const uid = String(uniqueId);
  const delSamples = await sql`
    DELETE FROM rnz_samples
    WHERE org_id = ${orgId}
      AND unique_id = ${uid}
      AND t_ms >= ${fromMs}
      AND t_ms <= ${toMs}
  `;
  const delEmptySessions = await sql`
    DELETE FROM rnz_sessions s
    WHERE s.org_id = ${orgId}
      AND s.unique_id = ${uid}
      AND NOT EXISTS (
        SELECT 1 FROM rnz_samples x WHERE x.org_id = ${orgId} AND x.session_id = s.session_id
      )
  `;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delEmptySessions.rowCount ?? 0,
  };
}

async function deleteAllStoredData(orgId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const delSamples = await sql`DELETE FROM rnz_samples WHERE org_id = ${orgId}`;
  const delSessions = await sql`DELETE FROM rnz_sessions WHERE org_id = ${orgId}`;
  const delDevices = await sql`DELETE FROM rnz_devices WHERE org_id = ${orgId}`;
  const delGeofences = await sql`DELETE FROM rnz_geofences WHERE org_id = ${orgId}`;
  const delTimingLines = await sql`DELETE FROM rnz_timing_lines WHERE org_id = ${orgId}`;
  const delMessages = await sql`DELETE FROM rnz_regatta_messages WHERE org_id = ${orgId}`;
  return {
    samplesDeleted: delSamples.rowCount ?? 0,
    sessionsDeleted: delSessions.rowCount ?? 0,
    devicesDeleted: delDevices.rowCount ?? 0,
    geofencesDeleted: delGeofences.rowCount ?? 0,
    timingLinesDeleted: delTimingLines.rowCount ?? 0,
    messagesDeleted: delMessages.rowCount ?? 0,
  };
}

async function getIdempotency(orgId, key, ttlMs = 10 * 60 * 1000) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const scopedKey = `${orgId}:${String(key)}`;
  const rows = await sql`
    SELECT response, created_at
    FROM rnz_idempotency
    WHERE org_id = ${orgId} AND key = ${scopedKey}
    LIMIT 1
  `;
  const row = rows.rows[0];
  if (!row) return null;
  const createdMs = new Date(row.created_at).getTime();
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > ttlMs) return null;
  return row.response || null;
}

async function setIdempotency(orgId, key, response) {
  if (!hasDb()) return;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const scopedKey = `${orgId}:${String(key)}`;
  await sql`
    INSERT INTO rnz_idempotency (org_id, key, created_at, response)
    VALUES (${orgId}, ${scopedKey}, NOW(), ${JSON.stringify(response)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET
      created_at = NOW(),
      response = EXCLUDED.response
  `;
  await sql`
    DELETE FROM rnz_idempotency
    WHERE created_at < NOW() - INTERVAL '30 minutes'
  `;
}

const {
  normalizeGeofence,
  normalizePolygonInput,
  polygonCentroid,
  polygonBoundingRadiusM,
  economyIntervalSecFromInput,
  sessionDwellSecFromInput,
  boolFromInput,
} = require('./geofence');

async function listGeofences(orgId) {
  if (!hasDb()) return [];
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const rows = await sql`
    SELECT id, name, kind, shape_type, center_lat, center_lon, radius_m, polygon_coords, enabled,
           economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
           suppress_recording, auto_stop_on_enter, auto_start_on_exit, session_dwell_sec,
           created_at, updated_at
    FROM rnz_geofences
    WHERE org_id = ${orgId}
    ORDER BY name ASC
  `;
  return rows.rows.map(normalizeGeofence);
}

async function createGeofence(orgId, body) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('name is required');
  const kind = String(body.kind ?? 'boat_park').trim() || 'boat_park';
  const economyInterval = economyIntervalSecFromInput(body);
  const economyGps = economyInterval;
  const economyUpload = economyInterval;
  const disableCapsize = body.disableCapsize !== false;
  const suppressRecording = boolFromInput(body, 'suppressRecording', 'suppress_recording', true);
  const autoStopOnEnter = boolFromInput(body, 'autoStopOnEnter', 'auto_stop_on_enter', true);
  const autoStartOnExit = boolFromInput(body, 'autoStartOnExit', 'auto_start_on_exit', true);
  const sessionDwellSec = sessionDwellSecFromInput(body);
  const enabled = body.enabled !== false;
  const shapeType =
    String(body.shapeType ?? 'circle').toLowerCase() === 'polygon' ? 'polygon' : 'circle';

  let centerLat;
  let centerLon;
  let radiusM;
  let polygonRing = null;

  if (shapeType === 'polygon') {
    const ring = normalizePolygonInput(body.polygonCoords);
    if (ring.length < 3) {
      throw new Error('polygonCoords requires at least 3 points');
    }
    const centroid = polygonCentroid(ring);
    centerLat = centroid.lat;
    centerLon = centroid.lon;
    radiusM = polygonBoundingRadiusM(ring);
    polygonRing = ring;
  } else {
    centerLat = Number(body.centerLat);
    centerLon = Number(body.centerLon);
    radiusM = Number(body.radiusM);
    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
      throw new Error('centerLat and centerLon are required');
    }
    if (!Number.isFinite(radiusM) || radiusM <= 0) {
      throw new Error('radiusM must be a positive number');
    }
  }

  const rows =
    shapeType === 'polygon'
      ? await sql`
    INSERT INTO rnz_geofences (
      org_id, name, kind, shape_type, center_lat, center_lon, radius_m, polygon_coords, enabled,
      economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
      suppress_recording, auto_stop_on_enter, auto_start_on_exit, session_dwell_sec
    )
    VALUES (
      ${orgId}, ${name}, ${kind}, ${shapeType}, ${centerLat}, ${centerLon}, ${radiusM},
      ${JSON.stringify(polygonRing)}::jsonb, ${enabled},
      ${economyGps}, ${economyUpload}, ${disableCapsize},
      ${suppressRecording}, ${autoStopOnEnter}, ${autoStartOnExit}, ${sessionDwellSec}
    )
    RETURNING id, name, kind, shape_type, center_lat, center_lon, radius_m, polygon_coords, enabled,
              economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
              suppress_recording, auto_stop_on_enter, auto_start_on_exit, session_dwell_sec,
              created_at, updated_at
  `
      : await sql`
    INSERT INTO rnz_geofences (
      org_id, name, kind, shape_type, center_lat, center_lon, radius_m, polygon_coords, enabled,
      economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
      suppress_recording, auto_stop_on_enter, auto_start_on_exit, session_dwell_sec
    )
    VALUES (
      ${orgId}, ${name}, ${kind}, ${shapeType}, ${centerLat}, ${centerLon}, ${radiusM}, NULL, ${enabled},
      ${economyGps}, ${economyUpload}, ${disableCapsize},
      ${suppressRecording}, ${autoStopOnEnter}, ${autoStartOnExit}, ${sessionDwellSec}
    )
    RETURNING id, name, kind, shape_type, center_lat, center_lon, radius_m, polygon_coords, enabled,
              economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
              suppress_recording, auto_stop_on_enter, auto_start_on_exit, session_dwell_sec,
              created_at, updated_at
  `;
  return normalizeGeofence(rows.rows[0]);
}

async function updateGeofenceSettings(orgId, id, body = {}) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const n = Number(id);
  if (!Number.isFinite(n)) throw new Error('Invalid geofence id');

  const hasInterval =
    body.economyIntervalSec != null ||
    body.economyGpsIntervalSec != null ||
    body.economyUploadIntervalSec != null;
  const economyInterval = hasInterval ? economyIntervalSecFromInput(body) : null;
  const disableCapsize =
    body.disableCapsize === true
      ? true
      : body.disableCapsize === false
        ? false
        : null;
  const suppressRecording =
    body.suppressRecording === true
      ? true
      : body.suppressRecording === false
        ? false
        : body.suppress_recording === true
          ? true
          : body.suppress_recording === false
            ? false
            : null;
  const autoStopOnEnter =
    body.autoStopOnEnter === true
      ? true
      : body.autoStopOnEnter === false
        ? false
        : body.auto_stop_on_enter === true
          ? true
          : body.auto_stop_on_enter === false
            ? false
            : null;
  const autoStartOnExit =
    body.autoStartOnExit === true
      ? true
      : body.autoStartOnExit === false
        ? false
        : body.auto_start_on_exit === true
          ? true
          : body.auto_start_on_exit === false
            ? false
            : null;
  const sessionDwellSec =
    body.sessionDwellSec != null || body.session_dwell_sec != null
      ? sessionDwellSecFromInput(body)
      : null;
  const name = body.name != null ? String(body.name).trim() : null;

  let centerLat = null;
  let centerLon = null;
  let radiusM = null;
  let polygonRing = null;
  let shapeType = null;

  if (body.polygonCoords != null) {
    const ring = normalizePolygonInput(body.polygonCoords);
    if (ring.length < 3) throw new Error('polygonCoords requires at least 3 points');
    const centroid = polygonCentroid(ring);
    centerLat = centroid.lat;
    centerLon = centroid.lon;
    radiusM = polygonBoundingRadiusM(ring);
    polygonRing = ring;
    shapeType = 'polygon';
  } else if (
    body.centerLat != null ||
    body.centerLon != null ||
    body.radiusM != null
  ) {
    const cur = await sql`
      SELECT center_lat, center_lon, radius_m FROM rnz_geofences
      WHERE org_id = ${orgId} AND id = ${n} LIMIT 1
    `;
    if (!cur.rows[0]) return null;
    centerLat = Number(body.centerLat ?? cur.rows[0].center_lat);
    centerLon = Number(body.centerLon ?? cur.rows[0].center_lon);
    radiusM = Number(body.radiusM ?? cur.rows[0].radius_m);
    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
      throw new Error('centerLat and centerLon are required');
    }
    if (!Number.isFinite(radiusM) || radiusM <= 0) {
      throw new Error('radiusM must be a positive number');
    }
    shapeType = 'circle';
    polygonRing = null;
  }

  const rows = await sql`
    UPDATE rnz_geofences
    SET
      name = COALESCE(${name || null}, name),
      shape_type = COALESCE(${shapeType}, shape_type),
      center_lat = COALESCE(${centerLat}, center_lat),
      center_lon = COALESCE(${centerLon}, center_lon),
      radius_m = COALESCE(${radiusM}, radius_m),
      polygon_coords = CASE
        WHEN ${polygonRing != null} THEN ${JSON.stringify(polygonRing)}::jsonb
        WHEN ${shapeType === 'circle'} THEN NULL
        ELSE polygon_coords
      END,
      economy_gps_interval_sec = COALESCE(${economyInterval}, economy_gps_interval_sec),
      economy_upload_interval_sec = COALESCE(${economyInterval}, economy_upload_interval_sec),
      disable_capsize = COALESCE(${disableCapsize}, disable_capsize),
      suppress_recording = COALESCE(${suppressRecording}, suppress_recording),
      auto_stop_on_enter = COALESCE(${autoStopOnEnter}, auto_stop_on_enter),
      auto_start_on_exit = COALESCE(${autoStartOnExit}, auto_start_on_exit),
      session_dwell_sec = COALESCE(${sessionDwellSec}, session_dwell_sec),
      updated_at = NOW()
    WHERE org_id = ${orgId} AND id = ${n}
    RETURNING id, name, kind, shape_type, center_lat, center_lon, radius_m, polygon_coords, enabled,
              economy_gps_interval_sec, economy_upload_interval_sec, disable_capsize,
              suppress_recording, auto_stop_on_enter, auto_start_on_exit, session_dwell_sec,
              created_at, updated_at
  `;
  if (!rows.rows.length) return null;
  return normalizeGeofence(rows.rows[0]);
}

async function deleteGeofence(orgId, id) {
  if (!hasDb()) return false;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  const del = await sql`DELETE FROM rnz_geofences WHERE org_id = ${orgId} AND id = ${n}`;
  return (del.rowCount ?? 0) > 0;
}

const {
  normalizeTimingLine,
  validateEndpoints,
  normalizeLineType,
  courseBearingFromLine,
  generateSplitLines,
  generateCourseFromStartFinish,
} = require('./timing-line');

async function listTimingLines(orgId) {
  if (!hasDb()) return [];
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const rows = await sql`
    SELECT id, name, line_type, lat1, lon1, lat2, lon2, distance_m, sort_order,
           course_group, course_bearing_deg, enabled, created_at, updated_at
    FROM rnz_timing_lines
    WHERE org_id = ${orgId}
    ORDER BY course_group ASC NULLS LAST, sort_order ASC, distance_m ASC NULLS LAST, name ASC
  `;
  return rows.rows.map(normalizeTimingLine);
}

async function createTimingLine(orgId, body) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('name is required');
  const { lat1, lon1, lat2, lon2 } = validateEndpoints(
    body.lat1,
    body.lon1,
    body.lat2,
    body.lon2,
  );
  const lineType = normalizeLineType(body.lineType ?? body.line_type);
  const distanceM =
    body.distanceM != null || body.distance_m != null
      ? Number(body.distanceM ?? body.distance_m)
      : null;
  const sortOrder = Number(body.sortOrder ?? body.sort_order ?? 0);
  const courseGroup =
    body.courseGroup != null || body.course_group != null
      ? String(body.courseGroup ?? body.course_group).trim() || null
      : null;
  const courseBearingDeg =
    body.courseBearingDeg != null || body.course_bearing_deg != null
      ? Number(body.courseBearingDeg ?? body.course_bearing_deg)
      : null;
  const enabled = body.enabled !== false;

  const rows = await sql`
    INSERT INTO rnz_timing_lines (
      org_id, name, line_type, lat1, lon1, lat2, lon2, distance_m, sort_order,
      course_group, course_bearing_deg, enabled
    )
    VALUES (
      ${orgId}, ${name}, ${lineType}, ${lat1}, ${lon1}, ${lat2}, ${lon2},
      ${Number.isFinite(distanceM) ? distanceM : null}, ${sortOrder},
      ${courseGroup}, ${Number.isFinite(courseBearingDeg) ? courseBearingDeg : null}, ${enabled}
    )
    RETURNING id, name, line_type, lat1, lon1, lat2, lon2, distance_m, sort_order,
              course_group, course_bearing_deg, enabled, created_at, updated_at
  `;
  return normalizeTimingLine(rows.rows[0]);
}

async function generateTimingSplitCourse(orgId, body) {
  if (!hasDb()) return [];
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const courseGroup = String(body.courseGroup ?? body.courseName ?? 'Course').trim() || 'Course';

  const hasFinishLineIds =
    body.startLineId != null &&
    body.finishLineId != null &&
    Number.isFinite(Number(body.startLineId)) &&
    Number.isFinite(Number(body.finishLineId));
  const hasFinishCoords =
    body.finishLat1 != null ||
    body.finish_lat1 != null ||
    body.finishLon1 != null ||
    body.finish_lon1 != null;

  let specs;
  if (hasFinishLineIds) {
    const startLineId = Number(body.startLineId);
    const finishLineId = Number(body.finishLineId);
    const startRow = await sql`
      SELECT lat1, lon1, lat2, lon2 FROM rnz_timing_lines
      WHERE org_id = ${orgId} AND id = ${startLineId} LIMIT 1
    `;
    const finishRow = await sql`
      SELECT lat1, lon1, lat2, lon2 FROM rnz_timing_lines
      WHERE org_id = ${orgId} AND id = ${finishLineId} LIMIT 1
    `;
    if (!startRow.rows[0] || !finishRow.rows[0]) {
      throw new Error('Selected start or finish line not found');
    }
    specs = generateCourseFromStartFinish({
      startLat1: startRow.rows[0].lat1,
      startLon1: startRow.rows[0].lon1,
      startLat2: startRow.rows[0].lat2,
      startLon2: startRow.rows[0].lon2,
      finishLat1: finishRow.rows[0].lat1,
      finishLon1: finishRow.rows[0].lon1,
      finishLat2: finishRow.rows[0].lat2,
      finishLon2: finishRow.rows[0].lon2,
      courseGroup,
      courseDirection: body.courseDirection === 'left' ? 'left' : 'right',
      courseBearingDeg: body.courseBearingDeg ?? body.course_bearing_deg,
      targetDistanceM:
        body.adjustToDistance === false || body.adjustToDistance === 'false'
          ? null
          : body.totalDistanceM ?? body.totalDistance,
      splitCount: body.splitCount ?? body.splitLines ?? body.numSplits,
      parallelLines: body.parallelLines !== false && body.parallelLines !== 'false',
    });
  } else if (hasFinishCoords) {
    const { lat1, lon1, lat2, lon2 } = validateEndpoints(
      body.lat1 ?? body.startLat1,
      body.lon1 ?? body.startLon1,
      body.lat2 ?? body.startLat2,
      body.lon2 ?? body.startLon2,
    );
    const finish = validateEndpoints(
      body.finishLat1 ?? body.finish_lat1,
      body.finishLon1 ?? body.finish_lon1,
      body.finishLat2 ?? body.finish_lat2,
      body.finishLon2 ?? body.finish_lon2,
    );
    specs = generateCourseFromStartFinish({
      startLat1: lat1,
      startLon1: lon1,
      startLat2: lat2,
      startLon2: lon2,
      finishLat1: finish.lat1,
      finishLon1: finish.lon1,
      finishLat2: finish.lat2,
      finishLon2: finish.lon2,
      courseGroup,
      courseDirection: body.courseDirection === 'left' ? 'left' : 'right',
      courseBearingDeg: body.courseBearingDeg ?? body.course_bearing_deg,
      targetDistanceM:
        body.adjustToDistance === false || body.adjustToDistance === 'false'
          ? null
          : body.totalDistanceM ?? body.totalDistance,
      splitCount: body.splitCount ?? body.splitLines ?? body.numSplits,
      parallelLines: body.parallelLines !== false && body.parallelLines !== 'false',
    });
  } else {
    const { lat1, lon1, lat2, lon2 } = validateEndpoints(
      body.lat1 ?? body.startLat1,
      body.lon1 ?? body.startLon1,
      body.lat2 ?? body.startLat2,
      body.lon2 ?? body.startLon2,
    );
    let courseBearingDeg = Number(body.courseBearingDeg ?? body.course_bearing_deg);
    if (!Number.isFinite(courseBearingDeg)) {
      const dir = body.courseDirection === 'left' ? 'left' : 'right';
      courseBearingDeg = courseBearingFromLine(lat1, lon1, lat2, lon2, dir);
    }
    specs = generateSplitLines({
      startLat1: lat1,
      startLon1: lon1,
      startLat2: lat2,
      startLon2: lon2,
      courseBearingDeg,
      totalDistanceM: body.totalDistanceM ?? body.totalDistance ?? 2000,
      courseGroup,
      splitCount: body.splitCount ?? body.splitLines ?? body.numSplits,
      splitIntervalM: body.splitIntervalM ?? body.splitInterval,
    });
  }

  await sql`DELETE FROM rnz_timing_lines WHERE org_id = ${orgId} AND course_group = ${courseGroup}`;

  const created = [];
  for (const spec of specs) {
    const row = await createTimingLine(orgId, spec);
    if (row) created.push(row);
  }
  return created;
}

async function updateTimingLine(orgId, id, body = {}) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const n = Number(id);
  if (!Number.isFinite(n)) throw new Error('Invalid timing line id');

  let lat1 = null;
  let lon1 = null;
  let lat2 = null;
  let lon2 = null;
  if (
    body.lat1 != null ||
    body.lon1 != null ||
    body.lat2 != null ||
    body.lon2 != null
  ) {
    const cur = await sql`
      SELECT lat1, lon1, lat2, lon2 FROM rnz_timing_lines
      WHERE org_id = ${orgId} AND id = ${n} LIMIT 1
    `;
    if (!cur.rows[0]) return null;
    const pts = validateEndpoints(
      body.lat1 ?? cur.rows[0].lat1,
      body.lon1 ?? cur.rows[0].lon1,
      body.lat2 ?? cur.rows[0].lat2,
      body.lon2 ?? cur.rows[0].lon2,
    );
    lat1 = pts.lat1;
    lon1 = pts.lon1;
    lat2 = pts.lat2;
    lon2 = pts.lon2;
  }

  const name = body.name != null ? String(body.name).trim() : null;
  const lineType = body.lineType != null ? normalizeLineType(body.lineType) : null;
  const distanceM =
    body.distanceM != null || body.distance_m != null
      ? Number(body.distanceM ?? body.distance_m)
      : null;
  const sortOrder =
    body.sortOrder != null || body.sort_order != null
      ? Number(body.sortOrder ?? body.sort_order)
      : null;
  const enabled =
    body.enabled === true ? true : body.enabled === false ? false : null;
  const courseBearingDeg =
    body.courseBearingDeg != null || body.course_bearing_deg != null
      ? Number(body.courseBearingDeg ?? body.course_bearing_deg)
      : null;

  const rows = await sql`
    UPDATE rnz_timing_lines
    SET
      name = COALESCE(${name || null}, name),
      line_type = COALESCE(${lineType}, line_type),
      lat1 = COALESCE(${lat1}, lat1),
      lon1 = COALESCE(${lon1}, lon1),
      lat2 = COALESCE(${lat2}, lat2),
      lon2 = COALESCE(${lon2}, lon2),
      distance_m = COALESCE(${Number.isFinite(distanceM) ? distanceM : null}, distance_m),
      sort_order = COALESCE(${Number.isFinite(sortOrder) ? sortOrder : null}, sort_order),
      course_bearing_deg = COALESCE(${Number.isFinite(courseBearingDeg) ? courseBearingDeg : null}, course_bearing_deg),
      enabled = COALESCE(${enabled}, enabled),
      updated_at = NOW()
    WHERE org_id = ${orgId} AND id = ${n}
    RETURNING id, name, line_type, lat1, lon1, lat2, lon2, distance_m, sort_order,
              course_group, course_bearing_deg, enabled, created_at, updated_at
  `;
  if (!rows.rows.length) return null;
  return normalizeTimingLine(rows.rows[0]);
}

async function deleteTimingLine(orgId, id) {
  if (!hasDb()) return false;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  const del = await sql`DELETE FROM rnz_timing_lines WHERE org_id = ${orgId} AND id = ${n}`;
  return (del.rowCount ?? 0) > 0;
}

async function deleteTimingCourseGroup(orgId, courseGroup) {
  if (!hasDb()) return 0;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const del = await sql`
    DELETE FROM rnz_timing_lines
    WHERE org_id = ${orgId} AND course_group = ${String(courseGroup)}
  `;
  return del.rowCount ?? 0;
}

const { normalizeRegattaMessage } = require('./regatta-message');

async function getActiveRegattaMessage(orgId, deviceId) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const id = String(deviceId ?? '').trim();
  if (!id) return null;
  const rows = await sql`
    SELECT id, device_id, text, created_at
    FROM rnz_regatta_messages
    WHERE org_id = ${orgId} AND device_id = ${id} AND cleared_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return normalizeRegattaMessage(rows.rows[0]);
}

async function listActiveRegattaMessages(orgId) {
  if (!hasDb()) return [];
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const rows = await sql`
    SELECT DISTINCT ON (device_id) id, device_id, text, created_at
    FROM rnz_regatta_messages
    WHERE org_id = ${orgId} AND cleared_at IS NULL
    ORDER BY device_id ASC, created_at DESC
  `;
  return rows.rows.map(normalizeRegattaMessage).filter(Boolean);
}

async function setRegattaMessage(orgId, deviceId, text) {
  if (!hasDb()) return null;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const id = String(deviceId ?? '').trim();
  const msg = String(text ?? '').trim();
  if (!id || !msg) return null;

  await sql`
    UPDATE rnz_regatta_messages
    SET cleared_at = NOW()
    WHERE org_id = ${orgId} AND device_id = ${id} AND cleared_at IS NULL
  `;

  const ins = await sql`
    INSERT INTO rnz_regatta_messages (org_id, device_id, text)
    VALUES (${orgId}, ${id}, ${msg})
    RETURNING id, device_id, text, created_at
  `;
  return normalizeRegattaMessage(ins.rows[0]);
}

async function broadcastRegattaMessage(orgId, text, deviceIds = null) {
  if (!hasDb()) return [];
  let ids = Array.isArray(deviceIds)
    ? [...new Set(deviceIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
    : [];
  if (!ids.length) {
    const devices = await listRegistryDevices(orgId);
    ids = devices.map((d) => String(d.uniqueId ?? '').trim()).filter(Boolean);
  }
  const messages = [];
  for (const deviceId of ids) {
    const message = await setRegattaMessage(orgId, deviceId, text);
    if (message) messages.push(message);
  }
  return messages;
}

async function clearRegattaMessage(orgId, deviceId) {
  if (!hasDb()) return false;
  const sql = await getSql();
  await ensureOrgsBootstrapped();
  const id = String(deviceId ?? '').trim();
  if (!id) return false;
  const upd = await sql`
    UPDATE rnz_regatta_messages
    SET cleared_at = NOW()
    WHERE org_id = ${orgId} AND device_id = ${id} AND cleared_at IS NULL
  `;
  return (upd.rowCount ?? 0) > 0;
}

module.exports = {
  hasDb,
  initSchema,
  ensureOrgsBootstrapped,
  findOrgByTokenHash,
  getDefaultOrg,
  isOrgAuthRequired,
  createOrg,
  listOrgs,
  resolveMemoryOrgFromToken,
  persistBatch,
  fetchRecentSamplesByDevice,
  getDeviceIngestTimes,
  getDeviceRegistryTimes,
  getMapPositions,
  getRegistryMapPositions,
  getRegistryGpsByDevice,
  getTraccarSnapshot,
  getRoutePositions,
  resolveDevice,
  listRegistryDevices,
  listHistoryDevicesDetailed,
  listSessions,
  getSessionFromDb,
  getDashboardHistory,
  getDashboardHistoryBySession,
  getStorageStats,
  deleteSession,
  deleteDeviceData,
  deleteSamplesInRange,
  deleteAllStoredData,
  getIdempotency,
  setIdempotency,
  listGeofences,
  createGeofence,
  updateGeofenceSettings,
  deleteGeofence,
  listTimingLines,
  createTimingLine,
  generateTimingSplitCourse,
  updateTimingLine,
  deleteTimingLine,
  deleteTimingCourseGroup,
  getActiveRegattaMessage,
  listActiveRegattaMessages,
  setRegattaMessage,
  broadcastRegattaMessage,
  clearRegattaMessage,
};
