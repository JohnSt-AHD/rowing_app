import { DEFAULT_INGEST_URL } from '@rowing/telemetry-types';
import { isDemoMode } from './demo-mode';
import { loadSettings } from './settings';
import {
  mergeRemoteWorkouts,
  type SavedWorkout,
  type WorkoutAssignment,
  type WorkoutProgress,
  saveWorkoutLibrary,
} from './workouts';

function apiBase(): string {
  const ingest = String(loadSettings().ingestUrl || DEFAULT_INGEST_URL).trim();
  return ingest.replace(/\/api\/ingest\/?$/i, '').replace(/\/$/, '');
}

function authHeaders(): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = loadSettings().ingestToken.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchRemoteWorkouts(): Promise<SavedWorkout[]> {
  if (isDemoMode()) return [];
  const res = await fetch(`${apiBase()}/api/workouts`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Workouts ${res.status}`);
  const data = (await res.json()) as { workouts?: SavedWorkout[] };
  return Array.isArray(data.workouts) ? data.workouts : [];
}

export async function uploadWorkoutLibrary(workouts: SavedWorkout[]): Promise<SavedWorkout[]> {
  if (isDemoMode()) {
    saveWorkoutLibrary(workouts);
    return workouts;
  }
  const res = await fetch(`${apiBase()}/api/workouts`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ workouts }),
  });
  if (!res.ok) throw new Error(`Upload workouts ${res.status}`);
  const data = (await res.json()) as { workouts?: SavedWorkout[] };
  const remote = Array.isArray(data.workouts) ? data.workouts : workouts;
  return mergeRemoteWorkouts(remote);
}

export async function syncWorkoutLibrary(): Promise<SavedWorkout[]> {
  try {
    const remote = await fetchRemoteWorkouts();
    if (remote.length) return mergeRemoteWorkouts(remote);
  } catch {
    /* keep local */
  }
  return [];
}

export async function fetchCoachAssignment(deviceId: string): Promise<WorkoutAssignment | null> {
  if (isDemoMode() || !deviceId) return null;
  const res = await fetch(
    `${apiBase()}/api/workouts?deviceId=${encodeURIComponent(deviceId)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { assignment?: WorkoutAssignment | null };
  return data.assignment || null;
}

export async function reportWorkoutProgress(progress: WorkoutProgress): Promise<void> {
  if (isDemoMode() || !progress.deviceId) return;
  await fetch(`${apiBase()}/api/workouts`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'progress', ...progress }),
  }).catch(() => {});
}
