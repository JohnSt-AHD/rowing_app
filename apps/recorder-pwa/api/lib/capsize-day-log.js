/**
 * Shared NZ-day capsize log for Manager + RowSafe (org-scoped).
 * Postgres when available; otherwise in-memory for local/dev.
 */

const db = require('./db');

const ACK_REARM_MS = 60_000;

/** @type {Map<string, { day: string, events: object[] }>} */
const memoryByOrg = globalThis.__rnzCapsizeDayLogMem ?? new Map();
globalThis.__rnzCapsizeDayLogMem = memoryByOrg;

function nzDayKey(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function orgKey(orgId) {
  return String(orgId ?? '');
}

function normalizeSource(source) {
  const s = String(source || '').trim().toLowerCase();
  if (s === 'manager' || s === 'rowsafe' || s === 'remote') return s;
  return 'remote';
}

function trimAckedBy(value, fallback) {
  const s = String(value || '').trim();
  return s || fallback;
}

function cloneEvent(e) {
  return { ...e };
}

function loadMemory(orgId) {
  const today = nzDayKey();
  const key = orgKey(orgId);
  const prev = memoryByOrg.get(key);
  if (!prev || prev.day !== today || !Array.isArray(prev.events)) {
    const next = { day: today, events: [] };
    memoryByOrg.set(key, next);
    return next;
  }
  return prev;
}

function saveMemory(orgId, store) {
  memoryByOrg.set(orgKey(orgId), store);
}

function memoryList(orgId) {
  return loadMemory(orgId)
    .events.slice()
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .map(cloneEvent);
}

function memoryUpsertActive(orgId, input) {
  const deviceId = String(input.deviceId || '').trim();
  if (!deviceId) return null;
  const store = loadMemory(orgId);
  const now = Date.now();
  const recentAck = store.events.find(
    (e) =>
      e.deviceId === deviceId &&
      e.status !== 'active' &&
      e.ackedAt != null &&
      now - e.ackedAt < ACK_REARM_MS,
  );
  if (recentAck) return cloneEvent(recentAck);
  const existing = store.events.find((e) => e.deviceId === deviceId && e.status === 'active');
  if (existing) {
    if (input.name) existing.name = String(input.name);
    if (input.lat != null && Number.isFinite(Number(input.lat))) existing.lat = Number(input.lat);
    if (input.lon != null && Number.isFinite(Number(input.lon))) existing.lon = Number(input.lon);
    saveMemory(orgId, store);
    return cloneEvent(existing);
  }
  const startedAt =
    input.startedAt != null && Number.isFinite(Number(input.startedAt))
      ? Number(input.startedAt)
      : now;
  const entry = {
    id: `${nzDayKey(startedAt)}:${deviceId}:${startedAt}`,
    deviceId,
    name: String(input.name || deviceId).trim() || deviceId,
    lat: input.lat != null && Number.isFinite(Number(input.lat)) ? Number(input.lat) : null,
    lon: input.lon != null && Number.isFinite(Number(input.lon)) ? Number(input.lon) : null,
    startedAt,
    status: 'active',
  };
  store.events.unshift(entry);
  saveMemory(orgId, store);
  return cloneEvent(entry);
}

function memorySetStatus(orgId, deviceIds, status, ackedBy, ackSource) {
  const store = loadMemory(orgId);
  const now = Date.now();
  const ids = deviceIds ? new Set(deviceIds.map((id) => String(id))) : null;
  let changed = 0;
  for (const e of store.events) {
    if (e.status !== 'active') continue;
    if (ids && !ids.has(e.deviceId)) continue;
    e.status = status;
    e.ackedAt = now;
    e.ackedBy = ackedBy;
    e.ackSource = ackSource;
    changed += 1;
  }
  if (changed) saveMemory(orgId, store);
  return changed;
}

async function listDayLog(orgId) {
  const day = nzDayKey();
  if (db.hasDb()) {
    try {
      return {
        day,
        events: await db.listCapsizeDayLog(orgId, day),
        persisted: true,
        storage: 'postgres',
      };
    } catch (err) {
      console.error('[capsize-day-log] list DB failed, using memory:', err);
    }
  }
  return { day, events: memoryList(orgId), persisted: false, storage: 'memory' };
}

async function upsertActive(orgId, input) {
  if (db.hasDb()) {
    try {
      const row = await db.upsertCapsizeDayLogActive(orgId, input);
      if (row) return row;
    } catch (err) {
      console.error('[capsize-day-log] upsert DB failed, using memory:', err);
    }
  }
  return memoryUpsertActive(orgId, input);
}

async function acknowledge(orgId, deviceIds, ackedBy, ackSource) {
  const who = trimAckedBy(ackedBy, ackSource === 'rowsafe' ? 'RowSafe' : 'CrewSight Manager');
  const source = normalizeSource(ackSource || 'manager');
  if (db.hasDb()) {
    try {
      await db.acknowledgeCapsizeDayLog(orgId, deviceIds, who, source);
    } catch (err) {
      console.error('[capsize-day-log] ack DB failed, using memory:', err);
      memorySetStatus(orgId, deviceIds, 'acknowledged', who, source);
    }
    return;
  }
  memorySetStatus(orgId, deviceIds, 'acknowledged', who, source);
}

async function markCleared(orgId, deviceIds, ackedBy, ackSource) {
  const who = trimAckedBy(ackedBy, 'RowSafe or another Manager');
  const source = normalizeSource(ackSource || 'remote');
  if (db.hasDb()) {
    try {
      await db.markCapsizeDayLogCleared(orgId, deviceIds, who, source);
    } catch (err) {
      console.error('[capsize-day-log] clear DB failed, using memory:', err);
      memorySetStatus(orgId, deviceIds, 'cleared', who, source);
    }
    return;
  }
  memorySetStatus(orgId, deviceIds, 'cleared', who, source);
}

module.exports = {
  nzDayKey,
  listDayLog,
  upsertActive,
  acknowledge,
  markCleared,
};
