/** Manager / coach-launch devices published from the Manager APK. */

export const COACH_BOAT_CLASS = 'Coach';
export const MANAGER_SOURCE = 'manager';

export function managerDeviceId(coachName: string): string {
  const name = String(coachName || '').trim();
  return name ? `Coach ${name}` : '';
}

export function isCoachDevice(d: {
  source?: string | null;
  role?: string | null;
  boatClass?: string | null;
  deviceId?: string | null;
  name?: string | null;
}): boolean {
  const src = String(d.source ?? '').trim().toLowerCase();
  if (src === 'manager' || src === 'coach') return true;
  if (String(d.role ?? '').trim().toLowerCase() === 'coach') return true;
  if (String(d.boatClass ?? '').trim().toLowerCase() === 'coach') return true;
  return /^coach\s/i.test(String(d.deviceId || d.name || '').trim());
}
