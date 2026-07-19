import type { ActiveRecording } from './background-session';
import type { NativeActiveSession } from './native-capsize-monitor';

/** Max wall-clock span for one session (overnight rows start fresh). */
export const SESSION_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/** Without a live background service, do not resume after this idle gap. */
export const RESUME_MAX_IDLE_MS = 6 * 60 * 60 * 1000;

export type ResumeCandidate = {
  sessionId: string;
  deviceId: string;
  startedAt?: number;
  athleteId?: string;
  serviceRunning: boolean;
};

export type SessionResumeContext = {
  endedAt?: number;
  startedAt?: number;
};

export type ResumeDecision =
  | { action: 'none' }
  | { action: 'mismatch'; savedDeviceId: string; settingsDeviceId: string }
  | { action: 'stale'; reason: string; sessionId: string; deviceId: string }
  | { action: 'resume'; candidate: ResumeCandidate };

/** Whether persisted or native state indicates an interrupted recording. */
export function canAutoResume(
  native: NativeActiveSession | null,
  persisted: ActiveRecording | null,
): boolean {
  return (
    Boolean(native?.active && native.sessionId && native.deviceId) ||
    Boolean(persisted?.sessionId && persisted.deviceId)
  );
}

export function isSessionTooOldToResume(
  startedAt: number | undefined,
  serviceRunning: boolean,
  now = Date.now(),
): boolean {
  if (!startedAt || !Number.isFinite(startedAt)) return false;
  if (now - startedAt > SESSION_MAX_AGE_MS) return true;
  if (!serviceRunning && now - startedAt > RESUME_MAX_IDLE_MS) return true;
  return false;
}

/** Pick session metadata for auto-resume; null when nothing to restore. */
export function resolveResumeCandidate(
  native: NativeActiveSession | null,
  persisted: ActiveRecording | null,
  settingsDeviceId: string,
  stored?: SessionResumeContext | null,
  now = Date.now(),
): ResumeDecision {
  if (!canAutoResume(native, persisted)) {
    return { action: 'none' };
  }

  const useNative = Boolean(native?.active && native.sessionId && native.deviceId);
  const sessionId = useNative ? native!.sessionId! : persisted!.sessionId;
  const deviceId = useNative ? native!.deviceId! : persisted!.deviceId;

  if (settingsDeviceId.trim() !== deviceId.trim()) {
    return { action: 'mismatch', savedDeviceId: deviceId, settingsDeviceId };
  }

  if (stored?.endedAt) {
    return {
      action: 'stale',
      reason: 'previous session was stopped',
      sessionId,
      deviceId,
    };
  }

  const startedAt = stored?.startedAt ?? native?.startedAt ?? persisted?.startedAt;
  const serviceRunning = Boolean(native?.serviceRunning);
  if (isSessionTooOldToResume(startedAt, serviceRunning, now)) {
    return {
      action: 'stale',
      reason: serviceRunning
        ? 'session exceeded maximum length'
        : 'session idle too long',
      sessionId,
      deviceId,
    };
  }

  return {
    action: 'resume',
    candidate: {
      sessionId,
      deviceId,
      startedAt,
      athleteId: native?.athleteId,
      serviceRunning,
    },
  };
}
