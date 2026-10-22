import { registerPlugin } from '@capacitor/core';
import {
  ensureCoachLocationSession,
  setCoachLocationNativeOwned,
} from './coach-location';
import { clampLocationIntervalMs, type CoachSettings } from './settings';

export type CoachMonitorStatus = {
  active: boolean;
  serviceRunning: boolean;
  shareLocation?: boolean;
};

export interface CoachMonitorPlugin {
  startMonitoring(options: {
    apiBaseUrl: string;
    ingestToken?: string;
    pollIntervalMs?: number;
    shareLocation?: boolean;
    coachName?: string;
    locationIntervalMs?: number;
    sessionId?: string;
  }): Promise<void>;
  stopMonitoring(): Promise<void>;
  getStatus(): Promise<CoachMonitorStatus>;
}

export const CoachMonitor = registerPlugin<CoachMonitorPlugin>('CoachMonitor');

export const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

export async function startNativeMonitoring(settings: CoachSettings): Promise<void> {
  if (!IS_NATIVE) return;
  const coachName = settings.coachName.trim();
  const share = Boolean(settings.shareLocation && coachName);
  const sessionId = share ? ensureCoachLocationSession(coachName) : null;
  await CoachMonitor.startMonitoring({
    apiBaseUrl: settings.apiBaseUrl,
    ingestToken: settings.ingestToken,
    pollIntervalMs: 3000,
    shareLocation: share,
    coachName,
    locationIntervalMs: clampLocationIntervalMs(settings.locationIntervalMs),
    sessionId: sessionId || undefined,
  });
  setCoachLocationNativeOwned(share);
}

export async function stopNativeMonitoring(): Promise<void> {
  if (!IS_NATIVE) return;
  await CoachMonitor.stopMonitoring();
  setCoachLocationNativeOwned(false);
}

export async function getNativeMonitoringStatus(): Promise<CoachMonitorStatus> {
  if (!IS_NATIVE) return { active: false, serviceRunning: false };
  return CoachMonitor.getStatus();
}
