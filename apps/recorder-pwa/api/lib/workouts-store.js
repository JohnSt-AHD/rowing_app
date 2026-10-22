/**
 * Org-scoped saved workout library (Manager/recorder recall).
 * Postgres when available; memory for local/dev.
 */

const db = require('./db');

/** @type {Map<string, { workouts: object[], updatedAt: number }>} */
const memory = globalThis.__rnzWorkoutLibrary ?? new Map();
globalThis.__rnzWorkoutLibrary = memory;

function orgKey(orgId) {
  return String(orgId ?? '');
}

async function listWorkouts(orgId) {
  if (db.hasDb() && typeof db.listWorkoutLibrary === 'function') {
    try {
      return { workouts: await db.listWorkoutLibrary(orgId), persisted: true, storage: 'postgres' };
    } catch (err) {
      console.error('[workouts] list DB failed, using memory:', err);
    }
  }
  const row = memory.get(orgKey(orgId));
  return { workouts: row?.workouts || [], persisted: false, storage: 'memory' };
}

async function saveWorkouts(orgId, workouts) {
  const list = Array.isArray(workouts) ? workouts : [];
  if (db.hasDb() && typeof db.saveWorkoutLibrary === 'function') {
    try {
      await db.saveWorkoutLibrary(orgId, list);
      return { workouts: list, persisted: true, storage: 'postgres' };
    } catch (err) {
      console.error('[workouts] save DB failed, using memory:', err);
    }
  }
  memory.set(orgKey(orgId), { workouts: list, updatedAt: Date.now() });
  return { workouts: list, persisted: false, storage: 'memory' };
}

module.exports = { listWorkouts, saveWorkouts };
