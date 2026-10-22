import { formatPrognostic, formatSplit500m, prognosticPercent } from '@rowing/rowing-pace';
import {
  formatClock,
  formatRemainDistance,
  loadActiveWorkout,
  type SavedWorkout,
  type WorkoutUnit,
} from './workouts';

export type WorkoutPhase = 'idle' | 'countdown' | 'waiting' | 'work' | 'rest' | 'done';

export type WorkoutTickInput = {
  now: number;
  speedMps: number | null;
  distanceM: number;
  hr: number | null;
  boatClass: string | null;
};

export type WorkoutHud = {
  phase: WorkoutPhase;
  title: string;
  remainLabel: string;
  remainText: string;
  intervalText: string;
  liveSplit: string;
  liveProg: string;
  avgSplit: string;
  avgProg: string;
  hrText: string;
  setupOpen: boolean;
};

export type WorkoutResult = {
  workoutId: string;
  name: string;
  finishedAt: number;
  workSec: number;
  workM: number;
  avgMps: number | null;
  avgPrognosticPct: number | null;
  intervalsDone: number;
};

type EngineState = {
  workout: SavedWorkout;
  phase: WorkoutPhase;
  setupOpen: boolean;
  countdownEndsAt: number;
  moveSince: number | null;
  workStartedAt: number;
  workStartDistance: number;
  restEndsAt: number;
  intervalIndex: number;
  speedSum: number;
  speedN: number;
  workMs: number;
  workM: number;
  lastResult: WorkoutResult | null;
};

let state: EngineState | null = null;
let onFinished: ((result: WorkoutResult) => void) | null = null;

export function setWorkoutFinishedHandler(fn: ((result: WorkoutResult) => void) | null): void {
  onFinished = fn;
}

function ensureState(): EngineState {
  if (!state) {
    state = {
      workout: loadActiveWorkout(),
      phase: 'idle',
      setupOpen: false,
      countdownEndsAt: 0,
      moveSince: null,
      workStartedAt: 0,
      workStartDistance: 0,
      restEndsAt: 0,
      intervalIndex: 0,
      speedSum: 0,
      speedN: 0,
      workMs: 0,
      workM: 0,
      lastResult: null,
    };
  }
  return state;
}

export function getWorkout(): SavedWorkout {
  return ensureState().workout;
}

export function setWorkout(workout: SavedWorkout): void {
  const s = ensureState();
  s.workout = workout;
  if (s.phase === 'idle' || s.phase === 'done') {
    s.phase = 'idle';
    s.intervalIndex = 0;
  }
}

export function isWorkoutSetupOpen(): boolean {
  return ensureState().setupOpen;
}

export function setWorkoutSetupOpen(open: boolean): void {
  ensureState().setupOpen = open;
}

export function resetWorkoutEngine(): void {
  const prev = state?.workout;
  state = null;
  if (prev) ensureState().workout = prev;
}

function workTarget(w: SavedWorkout): { unit: WorkoutUnit; value: number } {
  if (w.kind === 'interval') return { unit: w.workUnit, value: w.workValue };
  return { unit: w.unit, value: w.target };
}

function beginWork(s: EngineState, now: number, distanceM: number): void {
  s.phase = 'work';
  s.workStartedAt = now;
  s.workStartDistance = distanceM;
  s.moveSince = null;
}

function finishWorkInterval(s: EngineState, now: number, distanceM: number): void {
  s.workMs += Math.max(0, now - s.workStartedAt);
  s.workM += Math.max(0, distanceM - s.workStartDistance);
  const w = s.workout;
  if (w.kind === 'interval' && s.intervalIndex + 1 < w.repeats) {
    if (w.restSec <= 0) {
      s.intervalIndex += 1;
      beginWork(s, now, distanceM);
      return;
    }
    s.phase = 'rest';
    s.restEndsAt = now + w.restSec * 1000;
    return;
  }
  completeWorkout(s, now);
}

function completeWorkout(s: EngineState, now: number): void {
  s.phase = 'done';
  const avgMps = s.speedN > 0 ? s.speedSum / s.speedN : null;
  const result: WorkoutResult = {
    workoutId: s.workout.id,
    name: s.workout.name,
    finishedAt: now,
    workSec: s.workMs / 1000,
    workM: s.workM,
    avgMps,
    avgPrognosticPct: null,
    intervalsDone: s.workout.kind === 'interval' ? s.intervalIndex + 1 : 1,
  };
  s.lastResult = result;
  onFinished?.(result);
}

function resetPiece(s: EngineState): void {
  s.setupOpen = false;
  s.intervalIndex = 0;
  s.speedSum = 0;
  s.speedN = 0;
  s.workMs = 0;
  s.workM = 0;
  s.lastResult = null;
  s.moveSince = null;
}

export function armWorkout(now: number, distanceM: number): void {
  const s = ensureState();
  resetPiece(s);
  if (s.workout.startMode === 'countdown' && s.workout.countdownSec > 0) {
    s.phase = 'countdown';
    s.countdownEndsAt = now + s.workout.countdownSec * 1000;
    return;
  }
  if (s.workout.startMode === 'moving') {
    s.phase = 'waiting';
    return;
  }
  beginWork(s, now, distanceM);
}

/** Start every boat at the same wall-clock instant (device time of day). */
export function armWorkoutAt(startAtMs: number, now: number, distanceM: number): void {
  const s = ensureState();
  resetPiece(s);
  if (Number.isFinite(startAtMs) && startAtMs - now > 400) {
    s.phase = 'countdown';
    s.countdownEndsAt = startAtMs;
    return;
  }
  if (s.workout.startMode === 'moving') {
    s.phase = 'waiting';
    return;
  }
  beginWork(s, now, distanceM);
}

export function stopWorkoutPiece(): void {
  const s = ensureState();
  s.phase = 'idle';
  s.moveSince = null;
  s.setupOpen = false;
}

export function skipWorkoutRest(now: number, distanceM: number): void {
  const s = ensureState();
  if (s.phase !== 'rest') return;
  s.intervalIndex += 1;
  beginWork(s, now, distanceM);
}

export function tickWorkout(input: WorkoutTickInput): WorkoutHud {
  const s = ensureState();
  const { now, speedMps, distanceM, hr, boatClass } = input;
  const moving = speedMps != null && speedMps >= s.workout.moveSpeedMps;

  if (s.phase === 'countdown' && now >= s.countdownEndsAt) {
    beginWork(s, now, distanceM);
  }
  if (s.phase === 'waiting') {
    if (moving) {
      if (s.moveSince == null) s.moveSince = now;
      else if (now - s.moveSince >= 1200) beginWork(s, now, distanceM);
    } else {
      s.moveSince = null;
    }
  }
  if (s.phase === 'rest' && now >= s.restEndsAt) {
    s.intervalIndex += 1;
    beginWork(s, now, distanceM);
  }
  if (s.phase === 'work') {
    if (speedMps != null && speedMps >= 0.4) {
      s.speedSum += speedMps;
      s.speedN += 1;
    }
    const target = workTarget(s.workout);
    if (target.unit === 'time') {
      if (now - s.workStartedAt >= target.value * 1000) finishWorkInterval(s, now, distanceM);
    } else if (distanceM - s.workStartDistance >= target.value) {
      finishWorkInterval(s, now, distanceM);
    }
  }

  const avgMps = s.speedN > 0 ? s.speedSum / s.speedN : null;
  const liveMps = speedMps != null && speedMps >= 0.4 ? speedMps : null;
  const target = workTarget(s.workout);
  let remainLabel = target.unit === 'distance' ? 'Distance to go' : 'Time to go';
  let remainText = '—';
  let title = s.workout.name;
  let intervalText = s.workout.kind === 'interval' ? `Work 0 / ${s.workout.repeats}` : 'Piece';

  if (s.phase === 'countdown') {
    remainLabel = 'Countdown';
    remainText = formatClock((s.countdownEndsAt - now) / 1000);
    title = 'Get ready';
  } else if (s.phase === 'waiting') {
    remainLabel = 'Waiting for speed';
    remainText = 'Row';
    title = 'Start when moving';
  } else if (s.phase === 'rest') {
    remainLabel = 'Rest';
    remainText = formatClock((s.restEndsAt - now) / 1000);
    intervalText = `Rest ${s.intervalIndex + 1} / ${s.workout.repeats}`;
    title = 'Rest';
  } else if (s.phase === 'work') {
    intervalText =
      s.workout.kind === 'interval'
        ? `Work ${s.intervalIndex + 1} / ${s.workout.repeats}`
        : 'Piece';
    if (target.unit === 'distance') {
      remainText = formatRemainDistance(target.value - (distanceM - s.workStartDistance));
    } else {
      remainText = formatClock(target.value - (now - s.workStartedAt) / 1000);
    }
  } else if (s.phase === 'done') {
    remainLabel = 'Finished';
    remainText = 'Done';
    intervalText = s.lastResult
      ? `${s.lastResult.intervalsDone} interval${s.lastResult.intervalsDone === 1 ? '' : 's'}`
      : 'Done';
  } else {
    remainText = workoutRemainPreview(s.workout);
  }

  return {
    phase: s.phase,
    title,
    remainLabel,
    remainText,
    intervalText,
    liveSplit: formatSplit500m(liveMps),
    liveProg: liveMps != null && boatClass ? formatPrognostic(liveMps, boatClass) ?? '—' : '—',
    avgSplit: formatSplit500m(avgMps),
    avgProg: avgMps != null && boatClass ? formatPrognostic(avgMps, boatClass) ?? '—' : '—',
    hrText: hr != null && hr > 0 ? String(hr) : '—',
    setupOpen: s.setupOpen,
  };
}

function workoutRemainPreview(w: SavedWorkout): string {
  const t = workTarget(w);
  return t.unit === 'distance' ? formatRemainDistance(t.value) : formatClock(t.value);
}

export function workoutAvgPrognostic(boatClass: string | null): number | null {
  const s = state;
  if (!s || s.speedN <= 0 || !boatClass) return null;
  return prognosticPercent(s.speedSum / s.speedN, boatClass);
}

export function lastWorkoutResult(): WorkoutResult | null {
  return state?.lastResult ?? null;
}
