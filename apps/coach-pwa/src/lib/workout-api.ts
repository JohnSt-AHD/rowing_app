import { authHeaders, type CoachSettings } from './settings';
import { isDemoMode } from './demo-mode';
import {
  formatClock,
  formatRemainDistance,
  mergeRemoteWorkouts,
  saveWorkoutLibrary,
  workoutSummary,
  type SavedWorkout,
  type WorkoutAssignment,
  type WorkoutPieceResult,
  type WorkoutProgress,
} from './workouts';

let demoAssignment: WorkoutAssignment | null = null;

function apiBase(settings: CoachSettings): string {
  return String(settings.apiBaseUrl ?? '').replace(/\/$/, '');
}

export async function fetchRemoteWorkouts(settings: CoachSettings): Promise<SavedWorkout[]> {
  if (isDemoMode()) return [];
  const res = await fetch(`${apiBase(settings)}/api/workouts`, {
    headers: authHeaders(settings),
  });
  if (!res.ok) throw new Error(`Workouts ${res.status}`);
  const data = (await res.json()) as { workouts?: SavedWorkout[] };
  return Array.isArray(data.workouts) ? data.workouts : [];
}

export async function uploadWorkoutLibrary(
  settings: CoachSettings,
  workouts: SavedWorkout[],
): Promise<SavedWorkout[]> {
  if (isDemoMode()) {
    saveWorkoutLibrary(workouts);
    return workouts;
  }
  const res = await fetch(`${apiBase(settings)}/api/workouts`, {
    method: 'POST',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workouts }),
  });
  if (!res.ok) throw new Error(`Upload workouts ${res.status}`);
  const data = (await res.json()) as { workouts?: SavedWorkout[] };
  const remote = Array.isArray(data.workouts) ? data.workouts : workouts;
  return mergeRemoteWorkouts(remote);
}

export async function syncWorkoutLibrary(settings: CoachSettings): Promise<SavedWorkout[]> {
  try {
    const remote = await fetchRemoteWorkouts(settings);
    if (remote.length) return mergeRemoteWorkouts(remote);
  } catch {
    /* keep local */
  }
  return [];
}

export async function fetchAssignment(settings: CoachSettings): Promise<WorkoutAssignment | null> {
  if (isDemoMode()) {
    return demoAssignment ? withDemoProgress(demoAssignment) : null;
  }
  const res = await fetch(`${apiBase(settings)}/api/workouts?assignment=1`, {
    headers: authHeaders(settings),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { assignment?: WorkoutAssignment | null };
  return data.assignment || null;
}

export async function assignWorkout(
  settings: CoachSettings,
  input: {
    workout: SavedWorkout;
    deviceIds: string[];
    startClock: string;
    startAtMs: number;
    coachName: string;
  },
): Promise<WorkoutAssignment> {
  if (isDemoMode()) {
    demoAssignment = {
      id: `asg-${Date.now().toString(36)}`,
      workout: input.workout,
      deviceIds: input.deviceIds.slice(),
      startAtMs: input.startAtMs,
      startClock: input.startClock,
      tz: 'Pacific/Auckland',
      coachName: input.coachName,
      sentAt: Date.now(),
      progress: {},
    };
    return withDemoProgress(demoAssignment);
  }
  const res = await fetch(`${apiBase(settings)}/api/workouts`, {
    method: 'POST',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'assign', ...input, tz: 'Pacific/Auckland' }),
  });
  if (!res.ok) throw new Error(`Assign workout ${res.status}`);
  const data = (await res.json()) as { assignment?: WorkoutAssignment };
  if (!data.assignment) throw new Error('Assign workout failed');
  return data.assignment;
}

export async function clearAssignment(settings: CoachSettings): Promise<void> {
  if (isDemoMode()) {
    demoAssignment = null;
    return;
  }
  await fetch(`${apiBase(settings)}/api/workouts`, {
    method: 'POST',
    headers: { ...authHeaders(settings), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'clear' }),
  });
}

function deviceJitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 17) - 8;
}

function splitFromMps(mps: number): string {
  if (!Number.isFinite(mps) || mps < 0.35) return '—';
  const sec = 500 / mps;
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function progFromMps(mps: number): string {
  if (!Number.isFinite(mps) || mps < 0.35) return '—';
  return `${Math.round((mps / 4.8) * 100)}%`;
}

function demoPieces(
  workout: SavedWorkout,
  completed: number,
  speed: number,
  jitter: number,
): WorkoutPieceResult[] {
  const out: WorkoutPieceResult[] = [];
  for (let i = 1; i <= completed; i++) {
    const mps = speed - 0.02 + ((i + Math.abs(jitter)) % 4) * 0.018;
    const workSec =
      workout.kind === 'interval'
        ? workout.workUnit === 'distance'
          ? workout.workValue / Math.max(0.8, mps)
          : workout.workValue
        : workout.unit === 'distance'
          ? workout.target / Math.max(0.8, mps)
          : workout.target;
    const workM =
      workout.kind === 'interval'
        ? workout.workUnit === 'distance'
          ? workout.workValue
          : mps * workSec
        : workout.unit === 'distance'
          ? workout.target
          : mps * workSec;
    out.push({
      index: i,
      finishedAt: Date.now(),
      workSec,
      workM,
      avgSplit: splitFromMps(mps),
      avgProg: progFromMps(mps),
      hrText: String(156 + (Math.abs(jitter + i) % 16)),
    });
  }
  return out;
}

function synthesizeProgress(
  deviceId: string,
  workout: SavedWorkout,
  startAtMs: number,
  now: number,
): WorkoutProgress {
  const jitter = deviceJitter(deviceId);
  const speed = 4.55 + jitter * 0.02;
  const remainToStart = (startAtMs - now) / 1000;
  const base: WorkoutProgress = {
    deviceId,
    name: deviceId,
    phase: 'countdown',
    remainLabel: 'Starts in',
    remainText: formatClock(remainToStart),
    intervalText: workoutSummary(workout),
    liveSplit: '—',
    liveProg: '—',
    avgSplit: '—',
    avgProg: '—',
    hrText: '—',
    pieceIndex: 0,
    pieces: [],
    updatedAt: now,
  };
  if (remainToStart > 0.4) return base;

  const elapsed = Math.max(0, (now - startAtMs) / 1000);
  const live = {
    liveSplit: splitFromMps(speed),
    liveProg: progFromMps(speed),
    avgSplit: splitFromMps(speed - 0.04),
    avgProg: progFromMps(speed - 0.04),
    hrText: String(158 + (Math.abs(jitter) % 18)),
  };

  const withPieces = (next: WorkoutProgress, completed: number): WorkoutProgress => ({
    ...next,
    pieces: demoPieces(workout, completed, speed, jitter),
  });

  if (workout.kind === 'single') {
    if (workout.unit === 'distance') {
      const doneM = elapsed * speed;
      const remain = Math.max(0, workout.target - doneM);
      if (remain <= 0) {
        return withPieces(
          {
            ...base,
            ...live,
            phase: 'done',
            remainLabel: 'Finished',
            remainText: '0 m',
            hrText: '—',
            pieceIndex: 1,
          },
          1,
        );
      }
      return withPieces(
        {
          ...base,
          ...live,
          phase: 'work',
          remainLabel: 'Distance to go',
          remainText: formatRemainDistance(remain),
          pieceIndex: 1,
        },
        0,
      );
    }
    const remain = Math.max(0, workout.target - elapsed);
    if (remain <= 0) {
      return withPieces(
        {
          ...base,
          ...live,
          phase: 'done',
          remainLabel: 'Finished',
          remainText: '0:00',
          hrText: '—',
          pieceIndex: 1,
        },
        1,
      );
    }
    return withPieces(
      {
        ...base,
        ...live,
        phase: 'work',
        remainLabel: 'Time to go',
        remainText: formatClock(remain),
        pieceIndex: 1,
      },
      0,
    );
  }

  const workSec =
    workout.workUnit === 'distance' ? workout.workValue / Math.max(0.8, speed) : workout.workValue;
  const cycle = workSec + Math.max(0, workout.restSec);
  const idx = cycle > 0 ? Math.floor(elapsed / cycle) : workout.repeats;
  if (idx >= workout.repeats) {
    return withPieces(
      {
        ...base,
        ...live,
        phase: 'done',
        remainLabel: 'Finished',
        remainText: '0:00',
        intervalText: `${workout.repeats}/${workout.repeats} done`,
        hrText: '—',
        pieceIndex: workout.repeats,
      },
      workout.repeats,
    );
  }
  const inCycle = cycle > 0 ? elapsed % cycle : 0;
  if (inCycle < workSec) {
    const remainWork = workSec - inCycle;
    return withPieces(
      {
        ...base,
        ...live,
        phase: 'work',
        remainLabel: workout.workUnit === 'distance' ? 'Distance to go' : 'Time to go',
        remainText:
          workout.workUnit === 'distance'
            ? formatRemainDistance(remainWork * speed)
            : formatClock(remainWork),
        intervalText: `Work ${idx + 1}/${workout.repeats}`,
        pieceIndex: idx + 1,
      },
      idx,
    );
  }
  return withPieces(
    {
      ...base,
      phase: 'rest',
      remainLabel: 'Rest',
      remainText: formatClock(cycle - inCycle),
      intervalText: `Rest after ${idx + 1}/${workout.repeats}`,
      liveSplit: '—',
      liveProg: '—',
      avgSplit: live.avgSplit,
      avgProg: live.avgProg,
      hrText: String(142 + (Math.abs(jitter) % 10)),
      pieceIndex: idx + 1,
    },
    idx + 1,
  );
}

function withDemoProgress(assignment: WorkoutAssignment): WorkoutAssignment {
  const now = Date.now();
  const progress: Record<string, WorkoutProgress> = { ...assignment.progress };
  for (const id of assignment.deviceIds) {
    progress[id] = synthesizeProgress(id, assignment.workout, assignment.startAtMs, now);
  }
  return { ...assignment, progress };
}
