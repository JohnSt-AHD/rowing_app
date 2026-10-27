/** NZ-day log of active / responding / crew-safe capsize alerts on this Manager. */

export type CapsizeLogStatus = 'active' | 'responding' | 'acknowledged' | 'cleared';

export type CapsizeLogEntry = {
  id: string;
  deviceId: string;
  name: string;
  lat: number | null;
  lon: number | null;
  startedAt: number;
  status: CapsizeLogStatus;
  ackedAt?: number;
  ackedBy?: string;
  ackSource?: 'manager' | 'rowsafe' | 'remote' | 'athlete';
  respondingAt?: number;
  respondingBy?: string;
  respondingSource?: 'manager' | 'rowsafe' | 'remote' | 'athlete';
};

export function isOpenCapsizeStatus(status?: string | null): boolean {
  return status === 'active' || status === 'responding' || status === 'acknowledged';
}

export function isRespondingCapsizeStatus(status?: string | null): boolean {
  return status === 'responding' || status === 'acknowledged';
}

export function onTheWayLine(name?: string | null): string {
  const who = String(name || '').trim();
  return who ? `${who} is on the way` : 'A coach is on the way';
}

export function crewSafeLine(name?: string | null): string {
  const who = String(name || '').trim();
  return who ? `Crew safe · ${who}` : 'Crew safe';
}

const LS_KEY = 'crewsight_capsize_day_log_v1';

function nzDayKey(ms = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

type Store = { day: string; events: CapsizeLogEntry[] };

function loadStore(): Store {
  const today = nzDayKey();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { day: today, events: [] };
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || parsed.day !== today || !Array.isArray(parsed.events)) {
      return { day: today, events: [] };
    }
    return parsed;
  } catch {
    return { day: today, events: [] };
  }
}

function saveStore(store: Store): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
}

export function listCapsizeDayLog(): CapsizeLogEntry[] {
  return loadStore().events.slice().sort((a, b) => b.startedAt - a.startedAt);
}

export function upsertActiveCapsize(input: {
  deviceId: string;
  name: string;
  lat?: number | null;
  lon?: number | null;
}): CapsizeLogEntry {
  const store = loadStore();
  const existing = store.events.find(
    (e) => e.deviceId === input.deviceId && isOpenCapsizeStatus(e.status),
  );
  const recentAck = store.events.find(
    (e) =>
      e.deviceId === input.deviceId &&
      e.status === 'cleared' &&
      e.ackedAt != null &&
      Date.now() - e.ackedAt < 60_000,
  );
  if (recentAck) return recentAck;
  if (existing) {
    if (input.name) existing.name = input.name;
    if (input.lat != null && Number.isFinite(input.lat)) existing.lat = input.lat;
    if (input.lon != null && Number.isFinite(input.lon)) existing.lon = input.lon;
    saveStore(store);
    return existing;
  }
  const entry: CapsizeLogEntry = {
    id: `${input.deviceId}-${Date.now()}`,
    deviceId: input.deviceId,
    name: input.name || input.deviceId,
    lat: input.lat != null && Number.isFinite(input.lat) ? input.lat : null,
    lon: input.lon != null && Number.isFinite(input.lon) ? input.lon : null,
    startedAt: Date.now(),
    status: 'active',
  };
  store.events.unshift(entry);
  saveStore(store);
  return entry;
}

export function acknowledgeCapsizeLog(
  deviceIds: string[] | null,
  ackedBy: string,
  source: CapsizeLogEntry['ackSource'] = 'manager',
): void {
  const store = loadStore();
  const now = Date.now();
  const ids = deviceIds ? new Set(deviceIds) : null;
  for (const e of store.events) {
    if (!isOpenCapsizeStatus(e.status)) continue;
    if (ids && !ids.has(e.deviceId)) continue;
    e.status = 'responding';
    e.ackedAt = now;
    e.ackedBy = ackedBy;
    e.ackSource = source;
    if (e.respondingAt == null) e.respondingAt = now;
    e.respondingBy = ackedBy;
    e.respondingSource = source;
  }
  saveStore(store);
}

export function markCapsizeLogSafe(
  deviceIds: string[] | null,
  ackedBy: string,
  source: CapsizeLogEntry['ackSource'] = 'manager',
): void {
  const store = loadStore();
  const now = Date.now();
  const ids = deviceIds ? new Set(deviceIds) : null;
  for (const e of store.events) {
    if (!isOpenCapsizeStatus(e.status)) continue;
    if (ids && !ids.has(e.deviceId)) continue;
    e.status = 'cleared';
    e.ackedAt = now;
    e.ackedBy = ackedBy;
    e.ackSource = source;
  }
  saveStore(store);
}

/** If a tip vanished without a local Acknowledge, mark it cleared remotely. */
export function markMissingCapsizesClearedRemote(stillActiveIds: string[]): void {
  const store = loadStore();
  const live = new Set(stillActiveIds);
  let changed = false;
  for (const e of store.events) {
    if (!isOpenCapsizeStatus(e.status)) continue;
    if (live.has(e.deviceId)) continue;
    e.status = 'cleared';
    e.ackedAt = Date.now();
    e.ackedBy = 'RowSafe or another Manager';
    e.ackSource = 'remote';
    changed = true;
  }
  if (changed) saveStore(store);
}

export function replaceCapsizeDayLogForDemo(events: CapsizeLogEntry[]): void {
  saveStore({ day: nzDayKey(), events });
}

export function replaceCapsizeDayLogFromServer(events: CapsizeLogEntry[]): void {
  if (!Array.isArray(events)) return;
  const today = nzDayKey();
  const local = loadStore();
  const serverIds = new Set(events.map((e) => e.id));
  const serverDevices = new Set(events.map((e) => e.deviceId));
  const keepLocal = local.events.filter((e) => {
    if (serverIds.has(e.id) || serverDevices.has(e.deviceId)) return false;
    return isOpenCapsizeStatus(e.status) && Date.now() - e.startedAt < 30_000;
  });
  saveStore({ day: today, events: [...events, ...keepLocal] });
}

export function formatNzTime(ms: number): string {
  return new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

export function formatCapsizeAckLine(e: CapsizeLogEntry): string {
  if (isRespondingCapsizeStatus(e.status)) {
    const when = e.respondingAt || e.ackedAt ? formatNzTime(e.respondingAt || e.ackedAt || 0) : '';
    const who =
      e.respondingBy ||
      e.ackedBy ||
      (e.respondingSource === 'rowsafe' || e.ackSource === 'rowsafe' ? 'A coach' : '');
    const via =
      e.respondingSource === 'rowsafe' || e.ackSource === 'rowsafe'
        ? ' (RowSafe)'
        : e.respondingSource === 'manager' || e.ackSource === 'manager'
          ? ' (Manager)'
          : '';
    return `${onTheWayLine(who)} ${when}${via}`.replace(/\s+/g, ' ').trim();
  }
  if (e.status === 'cleared') {
    const when = e.ackedAt ? formatNzTime(e.ackedAt) : '';
    const who =
      e.ackedBy ||
      (e.ackSource === 'athlete'
        ? 'Athlete'
        : e.ackSource === 'rowsafe'
          ? 'RowSafe'
          : 'CrewSight Manager');
    return `${crewSafeLine(who)} ${when}`.replace(/\s+/g, ' ').trim();
  }
  return 'Active — not acknowledged';
}
