/**
 * Org-scoped workout library + one active coach assignment.
 * Postgres when available; memory for local/dev.
 */

const db = require('./db');

/** @type {Map<string, { workouts: object[], updatedAt: number }>} */
const memory = globalThis.__rnzWorkoutLibrary ?? new Map();
globalThis.__rnzWorkoutLibrary = memory;

/** @type {Map<string, object|null>} */
const assignMem = globalThis.__rnzWorkoutAssignment ?? new Map();
globalThis.__rnzWorkoutAssignment = assignMem;

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

async function getAssignment(orgId) {
  if (db.hasDb() && typeof db.getWorkoutAssignment === 'function') {
    try {
      return await db.getWorkoutAssignment(orgId);
    } catch (err) {
      console.error('[workouts] get assignment DB failed:', err);
    }
  }
  return assignMem.get(orgKey(orgId)) || null;
}

function assignmentForDevice(assignment, deviceId) {
  if (!assignment) return null;
  const id = String(deviceId || '').trim();
  if (!id) return assignment;
  const ids = Array.isArray(assignment.deviceIds) ? assignment.deviceIds.map(String) : [];
  if (!ids.length || ids.includes(id)) return assignment;
  return null;
}

async function saveAssignment(orgId, assignment) {
  if (db.hasDb() && typeof db.saveWorkoutAssignment === 'function') {
    try {
      await db.saveWorkoutAssignment(orgId, assignment);
    } catch (err) {
      console.error('[workouts] save assignment DB failed:', err);
    }
  }
  assignMem.set(orgKey(orgId), assignment);
  return assignment;
}

async function clearAssignment(orgId) {
  return saveAssignment(orgId, null);
}

async function mergeProgress(orgId, deviceId, progress) {
  const current = (await getAssignment(orgId)) || null;
  if (!current) return null;
  const id = String(deviceId || '').trim();
  if (!id) return current;
  const next = {
    ...current,
    progress: {
      ...(current.progress && typeof current.progress === 'object' ? current.progress : {}),
      [id]: { ...progress, deviceId: id, updatedAt: Date.now() },
    },
  };
  return saveAssignment(orgId, next);
}

module.exports = {
  listWorkouts,
  saveWorkouts,
  getAssignment,
  assignmentForDevice,
  saveAssignment,
  clearAssignment,
  mergeProgress,
};
