import { loadSettings } from './settings';
import { fetchCoachAssignment, reportWorkoutProgress } from './workout-api';
import { armWorkoutAt, setWorkout } from './workout-engine';
import type { WorkoutHud } from './workout-engine';
import type { WorkoutAssignment } from './workouts';

let lastAssignmentId = '';
let lastProgressAt = 0;
let lastPollAt = 0;
let pollInFlight = false;

export function resetCoachWorkoutPoll(): void {
  lastAssignmentId = '';
  lastProgressAt = 0;
  lastPollAt = 0;
}

export async function pollCoachWorkout(distanceM: number): Promise<WorkoutAssignment | null> {
  const now = Date.now();
  if (pollInFlight || now - lastPollAt < 2500) return null;
  lastPollAt = now;
  pollInFlight = true;
  try {
    const deviceId = loadSettings().deviceId.trim();
    if (!deviceId) return null;
    const assignment = await fetchCoachAssignment(deviceId);
    if (!assignment?.id || assignment.id === lastAssignmentId) return null;
    lastAssignmentId = assignment.id;
    setWorkout({
      ...assignment.workout,
      startMode: assignment.workout.startMode === 'moving' ? 'moving' : 'clock',
    });
    armWorkoutAt(Number(assignment.startAtMs) || Date.now(), Date.now(), distanceM);
    return assignment;
  } catch {
    return null;
  } finally {
    pollInFlight = false;
  }
}

export function maybeReportWorkoutProgress(hud: WorkoutHud, now = Date.now()): void {
  if (hud.phase === 'idle') return;
  if (now - lastProgressAt < 2000) return;
  const deviceId = loadSettings().deviceId.trim();
  if (!deviceId) return;
  lastProgressAt = now;
  void reportWorkoutProgress({
    deviceId,
    name: loadSettings().deviceId,
    phase: hud.phase,
    remainLabel: hud.remainLabel,
    remainText: hud.remainText,
    intervalText: hud.intervalText,
    liveSplit: hud.liveSplit,
    liveProg: hud.liveProg,
    avgSplit: hud.avgSplit,
    avgProg: hud.avgProg,
    hrText: hud.hrText,
    updatedAt: now,
  });
}
