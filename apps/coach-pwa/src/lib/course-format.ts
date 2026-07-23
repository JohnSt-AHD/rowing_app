import { formatPaceWithPrognostic, formatSplit500m } from '@rowing/rowing-pace';

export function formatClock(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatElapsed(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const sec = ms / 1000;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}

export function formatSplit500(mps: number | null | undefined) {
  return formatSplit500m(mps ?? null) ?? '—';
}

export function formatSpeedDisplay(
  mps: number | null | undefined,
  deviceId: string,
  athleteId?: string | null,
) {
  if (mps == null || !Number.isFinite(mps) || mps <= 0) return '—';
  return formatPaceWithPrognostic(mps, deviceId, athleteId ?? undefined, { suffix: true });
}
