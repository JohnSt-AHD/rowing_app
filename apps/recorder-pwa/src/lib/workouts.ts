/** Saved CrewSight pieces / intervals (this phone + optional org upload). */

export type WorkoutUnit = 'time' | 'distance';
export type WorkoutStartMode = 'countdown' | 'moving';
export type WorkoutKind = 'single' | 'interval';

export type SavedWorkout = {
  id: string;
  name: string;
  kind: WorkoutKind;
  /** Single-piece unit (ignored for intervals). */
  unit: WorkoutUnit;
  /** Seconds or metres for a single piece. */
  target: number;
  startMode: WorkoutStartMode;
  countdownSec: number;
  /** Speed that counts as “the boat has started”. */
  moveSpeedMps: number;
  repeats: number;
  workUnit: WorkoutUnit;
  /** Seconds or metres of work. */
  workValue: number;
  /** Rest is always time (seconds). */
  restSec: number;
  updatedAt: number;
};

const LS_LIB = 'crewsight_workouts_v1';
const LS_ACTIVE = 'crewsight_workout_active_id';

export const DEFAULT_MOVE_SPEED_MPS = 1.8;
export const DEFAULT_COUNTDOWN_SEC = 5;

export function newWorkoutId(): string {
  return `wo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function defaultWorkout(): SavedWorkout {
  return {
    id: newWorkoutId(),
    name: '20 min',
    kind: 'single',
    unit: 'time',
    target: 20 * 60,
    startMode: 'countdown',
    countdownSec: DEFAULT_COUNTDOWN_SEC,
    moveSpeedMps: DEFAULT_MOVE_SPEED_MPS,
    repeats: 8,
    workUnit: 'time',
    workValue: 60,
    restSec: 60,
    updatedAt: Date.now(),
  };
}

export function defaultPresets(): SavedWorkout[] {
  const now = Date.now();
  return [
    { ...defaultWorkout(), id: 'preset-20min', name: '20 min', updatedAt: now },
    {
      ...defaultWorkout(),
      id: 'preset-2k',
      name: '2 km',
      unit: 'distance',
      target: 2000,
      updatedAt: now,
    },
    {
      ...defaultWorkout(),
      id: 'preset-8x1',
      name: '8 × 1:00 / 1:00',
      kind: 'interval',
      workUnit: 'time',
      workValue: 60,
      restSec: 60,
      repeats: 8,
      updatedAt: now,
    },
    {
      ...defaultWorkout(),
      id: 'preset-6x500',
      name: '6 × 500 m / 1:00',
      kind: 'interval',
      workUnit: 'distance',
      workValue: 500,
      restSec: 60,
      repeats: 6,
      updatedAt: now,
    },
  ];
}

function normalizeWorkout(raw: Partial<SavedWorkout> | null | undefined): SavedWorkout | null {
  if (!raw || typeof raw !== 'object') return null;
  const base = defaultWorkout();
  const id = String(raw.id || '').trim() || newWorkoutId();
  const kind: WorkoutKind = raw.kind === 'interval' ? 'interval' : 'single';
  const unit: WorkoutUnit = raw.unit === 'distance' ? 'distance' : 'time';
  const workUnit: WorkoutUnit = raw.workUnit === 'distance' ? 'distance' : 'time';
  const startMode: WorkoutStartMode = raw.startMode === 'moving' ? 'moving' : 'countdown';
  const target = Number(raw.target);
  const workValue = Number(raw.workValue);
  const restSec = Number(raw.restSec);
  const repeats = Number(raw.repeats);
  const countdownSec = Number(raw.countdownSec);
  const moveSpeedMps = Number(raw.moveSpeedMps);
  return {
    id,
    name: String(raw.name || '').trim() || (kind === 'interval' ? 'Intervals' : 'Piece'),
    kind,
    unit,
    target: Number.isFinite(target) && target > 0 ? target : base.target,
    startMode,
    countdownSec:
      Number.isFinite(countdownSec) && countdownSec >= 0
        ? Math.min(30, Math.round(countdownSec))
        : DEFAULT_COUNTDOWN_SEC,
    moveSpeedMps:
      Number.isFinite(moveSpeedMps) && moveSpeedMps > 0.5
        ? Math.min(6, moveSpeedMps)
        : DEFAULT_MOVE_SPEED_MPS,
    repeats: Number.isFinite(repeats) && repeats > 0 ? Math.min(40, Math.round(repeats)) : 8,
    workUnit,
    workValue: Number.isFinite(workValue) && workValue > 0 ? workValue : 60,
    restSec: Number.isFinite(restSec) && restSec >= 0 ? restSec : 60,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export function loadWorkoutLibrary(): SavedWorkout[] {
  try {
    const raw = localStorage.getItem(LS_LIB);
    if (!raw) return defaultPresets();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultPresets();
    const list = parsed.map((w) => normalizeWorkout(w)).filter((w): w is SavedWorkout => Boolean(w));
    return list.length ? list : defaultPresets();
  } catch {
    return defaultPresets();
  }
}

export function saveWorkoutLibrary(list: SavedWorkout[]): void {
  try {
    localStorage.setItem(LS_LIB, JSON.stringify(list));
  } catch {
    /* quota */
  }
}

export function upsertSavedWorkout(workout: SavedWorkout): SavedWorkout[] {
  const next = normalizeWorkout({ ...workout, updatedAt: Date.now() })!;
  const list = loadWorkoutLibrary().filter((w) => w.id !== next.id);
  list.unshift(next);
  saveWorkoutLibrary(list);
  setActiveWorkoutId(next.id);
  return list;
}

export function deleteSavedWorkout(id: string): SavedWorkout[] {
  const list = loadWorkoutLibrary().filter((w) => w.id !== id);
  saveWorkoutLibrary(list);
  if (loadActiveWorkoutId() === id) setActiveWorkoutId(list[0]?.id || '');
  return list;
}

export function loadActiveWorkoutId(): string {
  try {
    return String(localStorage.getItem(LS_ACTIVE) || '');
  } catch {
    return '';
  }
}

export function setActiveWorkoutId(id: string): void {
  try {
    if (id) localStorage.setItem(LS_ACTIVE, id);
    else localStorage.removeItem(LS_ACTIVE);
  } catch {
    /* ignore */
  }
}

export function loadActiveWorkout(): SavedWorkout {
  const list = loadWorkoutLibrary();
  const id = loadActiveWorkoutId();
  return list.find((w) => w.id === id) || list[0] || defaultWorkout();
}

export function mergeRemoteWorkouts(remote: SavedWorkout[]): SavedWorkout[] {
  const local = loadWorkoutLibrary();
  const byId = new Map<string, SavedWorkout>();
  for (const w of local) byId.set(w.id, w);
  for (const raw of remote) {
    const w = normalizeWorkout(raw);
    if (!w) continue;
    const prev = byId.get(w.id);
    if (!prev || w.updatedAt >= prev.updatedAt) byId.set(w.id, w);
  }
  const list = [...byId.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  saveWorkoutLibrary(list);
  return list;
}

export function formatClock(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatRemainDistance(metres: number): string {
  const m = Math.max(0, metres);
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

export function workoutSummary(w: SavedWorkout): string {
  if (w.kind === 'interval') {
    const work =
      w.workUnit === 'distance' ? formatRemainDistance(w.workValue) : formatClock(w.workValue);
    return `${w.repeats} × ${work} / ${formatClock(w.restSec)}`;
  }
  return w.unit === 'distance' ? formatRemainDistance(w.target) : formatClock(w.target);
}
