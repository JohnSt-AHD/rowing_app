/** Overnight monitoring pause — 6pm–6am Pacific/Auckland. */
export const QUIET_HOURS_TIMEZONE = 'Pacific/Auckland';
export const QUIET_HOURS_START = 18;
export const QUIET_HOURS_END = 6;
export const QUIET_HOURS_MESSAGE = 'Monitoring paused overnight';

function hourInTz(date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: QUIET_HOURS_TIMEZONE,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date);
  const raw = Number(parts.find((p) => p.type === 'hour')?.value);
  if (!Number.isFinite(raw)) return date.getHours();
  return raw === 24 ? 0 : raw;
}

export function isQuietHours(date = new Date()): boolean {
  const h = hourInTz(date);
  return h >= QUIET_HOURS_START || h < QUIET_HOURS_END;
}

export function onQuietHoursChange(callback: (paused: boolean) => void): () => void {
  let last = isQuietHours();
  callback(last);
  const id = setInterval(() => {
    const now = isQuietHours();
    if (now !== last) {
      last = now;
      callback(now);
    }
  }, 30_000);
  return () => clearInterval(id);
}
