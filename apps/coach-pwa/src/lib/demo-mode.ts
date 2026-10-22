/**
 * Isolated Manager demo seed. Active only when `?demo=1` is on the page URL.
 * Never reads or writes production ingest-token / API settings.
 */

import type {
  DashboardHistoryPayload,
  FleetDevice,
  HistoryDevice,
  HistoryPoint,
  LogbookPayload,
  MapPosition,
  SessionSummary,
  TimingLine,
  TimingLinesPayload,
} from './api';

const DEMO_QUERY = 'demo';

export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search);
    const v = (q.get(DEMO_QUERY) || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  } catch {
    return false;
  }
}

const COURSE_START = { lat: -37.9428, lon: 175.5575 };
const COURSE_BEARING = 348;
const EARTH_M = 6_371_000;

type CrewSpec = {
  deviceId: string;
  athleteId: string;
  coach: string;
  boatClass: string;
  boatName: string;
  onWater: boolean;
  laneM: number;
  seedM: number;
  speedMps: number;
  spm: number;
  lastSeenAgoSec: number;
  capsize?: boolean;
  source?: string;
};

const CREWS: CrewSpec[] = [
  {
    deviceId: 'W1x Emma',
    athleteId: 'Emma',
    coach: 'Mike',
    boatClass: 'W1x',
    boatName: 'Ruawai',
    onWater: true,
    laneM: -18,
    seedM: 420,
    speedMps: 4.72,
    spm: 28,
    lastSeenAgoSec: 2,
  },
  {
    deviceId: 'W1x EH',
    athleteId: 'EH',
    coach: 'Tom',
    boatClass: 'W1x',
    boatName: 'Karapiro',
    onWater: true,
    laneM: 0,
    seedM: 610,
    speedMps: 4.81,
    spm: 29,
    lastSeenAgoSec: 3,
  },
  {
    deviceId: 'W1x KG',
    athleteId: 'KG',
    coach: 'James',
    boatClass: 'W1x',
    boatName: 'Pupuke',
    onWater: true,
    laneM: 18,
    seedM: 280,
    speedMps: 4.58,
    spm: 27,
    lastSeenAgoSec: 4,
    capsize: true,
  },
  {
    deviceId: 'Coach Tom',
    athleteId: 'Tom',
    coach: 'Tom',
    boatClass: 'Coach',
    boatName: '',
    onWater: true,
    laneM: 72,
    seedM: 540,
    speedMps: 3.1,
    spm: 0,
    lastSeenAgoSec: 2,
    source: 'manager',
  },
  {
    deviceId: 'W1x VW',
    athleteId: 'VW',
    coach: 'Mike',
    boatClass: 'W1x',
    boatName: 'Hawea',
    onWater: false,
    laneM: 0,
    seedM: 0,
    speedMps: 0,
    spm: 0,
    lastSeenAgoSec: 46 * 60,
  },
  {
    deviceId: 'W1x LS',
    athleteId: 'LS',
    coach: 'Nick',
    boatClass: 'W1x',
    boatName: 'Rotorua',
    onWater: false,
    laneM: 0,
    seedM: 0,
    speedMps: 0,
    spm: 0,
    lastSeenAgoSec: 2 * 3600,
  },
  {
    deviceId: 'M1x TM',
    athleteId: 'TM',
    coach: 'James',
    boatClass: 'M1x',
    boatName: 'Waihi',
    onWater: false,
    laneM: 0,
    seedM: 0,
    speedMps: 0,
    spm: 0,
    lastSeenAgoSec: 18 * 3600,
  },
];

function dest(
  lat: number,
  lon: number,
  bearingDeg: number,
  distM: number,
): { lat: number; lon: number } {
  const br = (bearingDeg * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const δ = distM / EARTH_M;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(br) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: (φ2 * 180) / Math.PI, lon: (λ2 * 180) / Math.PI };
}

function pointAlong(distM: number, laneM: number): { lat: number; lon: number } {
  const center = dest(COURSE_START.lat, COURSE_START.lon, COURSE_BEARING, distM);
  if (!laneM) return center;
  return dest(center.lat, center.lon, COURSE_BEARING + 90, laneM);
}

function liveAlongM(crew: CrewSpec, nowMs = Date.now()): number {
  const tSec = nowMs / 1000;
  return (crew.seedM + tSec * crew.speedMps) % 1950;
}

function nzOffsetMs(date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT+13';
  const m = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(raw);
  if (!m) return 13 * 3600 * 1000;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 3600 + Number(m[3] || 0) * 60) * 1000;
}

function nzLocalIso(daysAgo: number, hour: number, minute: number): string {
  const now = new Date();
  const offset = nzOffsetMs(now);
  const nz = new Date(now.getTime() + offset);
  const utcMs = Date.UTC(
    nz.getUTCFullYear(),
    nz.getUTCMonth(),
    nz.getUTCDate() - daysAgo,
    hour,
    minute,
    0,
  );
  return new Date(utcMs - offset).toISOString();
}

export function demoDevices(): FleetDevice[] {
  return CREWS.map((c) => {
    const live = c.onWater;
    return {
      deviceId: c.deviceId,
      name: c.deviceId,
      athleteId: c.athleteId,
      coach: c.coach,
      boatClass: c.boatClass,
      boatName: c.boatName,
      source: c.source || null,
      role: c.source === 'manager' ? 'coach' : null,
      online: live,
      lastSeenAgoSec: c.lastSeenAgoSec,
      gps: live
        ? { ageSec: 2, present: true, displayAgeSec: 2, ingestAgoSec: 2 }
        : { ageSec: c.lastSeenAgoSec, present: false, displayAgeSec: c.lastSeenAgoSec },
      gpsAgeSec: live ? 2 : c.lastSeenAgoSec,
      rowing: live
        ? { strokeRate: c.spm, strokeRateValid: true, capsize: Boolean(c.capsize) }
        : { strokeRate: null, strokeRateValid: false, capsize: false },
      displayStrokeRate: live ? c.spm : null,
    };
  });
}

export function demoMapPositions(nowMs = Date.now()): MapPosition[] {
  return CREWS.filter((c) => c.onWater).map((c) => {
    const along = liveAlongM(c, nowMs);
    const wobble = Math.sin(nowMs / 1800 + c.seedM) * 0.12;
    const pos = pointAlong(along, c.laneM);
    const speed = c.speedMps + wobble;
    const spm = c.spm + Math.round(Math.sin(nowMs / 2400 + c.laneM) * 1.2);
    return {
      deviceId: c.deviceId,
      latitude: pos.lat,
      longitude: pos.lon,
      smoothLatitude: pos.lat,
      smoothLongitude: pos.lon,
      speed,
      course: COURSE_BEARING,
      strokeRate: spm,
      strokeRateValid: true,
      capsize: Boolean(c.capsize),
      fixAgeSec: 2,
      fixMs: nowMs,
      lastSeenAgoSec: c.lastSeenAgoSec,
      telemetryStale: false,
      online: true,
      athleteId: c.athleteId,
      source: c.source || null,
      role: c.source === 'manager' ? 'coach' : null,
      boatClass: c.boatClass,
      accuracy: 4,
      displaySpeedMps: speed,
      displayStrokeRate: spm,
      strokeRateMedian: c.spm,
      pathSpeedMps: speed,
      recentPathSpeedMps: speed,
    };
  });
}

function lineAt(distM: number): Pick<TimingLine, 'lat1' | 'lon1' | 'lat2' | 'lon2'> {
  const center = dest(COURSE_START.lat, COURSE_START.lon, COURSE_BEARING, distM);
  const left = dest(center.lat, center.lon, COURSE_BEARING - 90, 42);
  const right = dest(center.lat, center.lon, COURSE_BEARING + 90, 42);
  return { lat1: left.lat, lon1: left.lon, lat2: right.lat, lon2: right.lon };
}

export function demoTimingLines(): TimingLinesPayload {
  const marks: Array<{ id: number; name: string; type: TimingLine['lineType']; dist: number }> = [
    { id: 1, name: 'Start', type: 'start', dist: 0 },
    { id: 2, name: '500 m', type: 'split', dist: 500 },
    { id: 3, name: '1000 m', type: 'split', dist: 1000 },
    { id: 4, name: '1500 m', type: 'split', dist: 1500 },
    { id: 5, name: 'Finish', type: 'finish', dist: 2000 },
  ];
  const lines: TimingLine[] = marks.map((m, i) => ({
    id: m.id,
    name: m.name,
    lineType: m.type,
    ...lineAt(m.dist),
    distanceM: m.dist,
    sortOrder: i,
    courseGroup: 'Karapiro 2000',
    courseBearingDeg: COURSE_BEARING,
    enabled: true,
  }));
  return { ok: true, org: 'demo', persisted: false, lines };
}

type DemoSession = SessionSummary & {
  uniqueId: string;
  track: HistoryPoint[];
};

function buildPieceTrack(
  startedAtMs: number,
  durationMs: number,
  laneM: number,
  baseSpeed: number,
  baseSpm: number,
  hr0: number,
): HistoryPoint[] {
  const step = 2000;
  const points: HistoryPoint[] = [];
  let dist = 40;
  for (let t = 0; t <= durationMs; t += step) {
    const prog = t / durationMs;
    const surge = 0.18 * Math.sin((t / 1000) * (baseSpm / 60) * Math.PI * 2);
    const piece = prog < 0.08 ? 0.82 : prog > 0.92 ? 0.9 : 1;
    const speed = baseSpeed * piece + surge;
    dist += speed * (step / 1000);
    const pos = pointAlong(Math.min(dist, 1980), laneM + Math.sin(t / 9000) * 2);
    points.push({
      t: startedAtMs + t,
      lat: pos.lat,
      lon: pos.lon,
      speed,
      hr: Math.round(hr0 + 12 * prog + Math.sin(t / 20000) * 3),
      strokeRate: Math.round(baseSpm + (prog > 0.85 ? 2 : 0) + Math.sin(t / 15000)),
      capsize: false,
    });
  }
  return points;
}

const SESSIONS: DemoSession[] = (() => {
  const emmaAmStart = Date.parse(nzLocalIso(0, 6, 12));
  const emmaPmStart = Date.parse(nzLocalIso(1, 16, 40));
  const ehStart = Date.parse(nzLocalIso(0, 6, 18));
  const kgStart = Date.parse(nzLocalIso(0, 6, 15));
  const vwStart = Date.parse(nzLocalIso(1, 6, 5));
  return [
    {
      session_id: 'demo-sess-emma-am',
      unique_id: 'W1x Emma',
      uniqueId: 'W1x Emma',
      started_at: new Date(emmaAmStart).toISOString(),
      ended_at: new Date(emmaAmStart + 18 * 60 * 1000).toISOString(),
      sample_count: 540,
      boat_class: 'W1x',
      boatClass: 'W1x',
      athlete_id: 'Emma',
      athleteId: 'Emma',
      track: buildPieceTrack(emmaAmStart, 18 * 60 * 1000, -18, 4.7, 28, 152),
    },
    {
      session_id: 'demo-sess-emma-pm',
      unique_id: 'W1x Emma',
      uniqueId: 'W1x Emma',
      started_at: new Date(emmaPmStart).toISOString(),
      ended_at: new Date(emmaPmStart + 22 * 60 * 1000).toISOString(),
      sample_count: 660,
      boat_class: 'W1x',
      boatClass: 'W1x',
      athlete_id: 'Emma',
      athleteId: 'Emma',
      track: buildPieceTrack(emmaPmStart, 22 * 60 * 1000, -12, 4.55, 27, 148),
    },
    {
      session_id: 'demo-sess-eh',
      unique_id: 'W1x EH',
      uniqueId: 'W1x EH',
      started_at: new Date(ehStart).toISOString(),
      ended_at: new Date(ehStart + 16 * 60 * 1000).toISOString(),
      sample_count: 480,
      boat_class: 'W1x',
      boatClass: 'W1x',
      athlete_id: 'EH',
      athleteId: 'EH',
      track: buildPieceTrack(ehStart, 16 * 60 * 1000, 0, 4.82, 29, 156),
    },
    {
      session_id: 'demo-sess-kg',
      unique_id: 'W1x KG',
      uniqueId: 'W1x KG',
      started_at: new Date(kgStart).toISOString(),
      ended_at: new Date(kgStart + 17 * 60 * 1000).toISOString(),
      sample_count: 510,
      boat_class: 'W1x',
      boatClass: 'W1x',
      athlete_id: 'KG',
      athleteId: 'KG',
      track: buildPieceTrack(kgStart, 17 * 60 * 1000, 18, 4.6, 27, 150),
    },
    {
      session_id: 'demo-sess-vw',
      unique_id: 'W1x VW',
      uniqueId: 'W1x VW',
      started_at: new Date(vwStart).toISOString(),
      ended_at: new Date(vwStart + 14 * 60 * 1000).toISOString(),
      sample_count: 420,
      boat_class: 'W1x',
      boatClass: 'W1x',
      athlete_id: 'VW',
      athleteId: 'VW',
      track: buildPieceTrack(vwStart, 14 * 60 * 1000, 8, 4.5, 26, 146),
    },
  ];
})();

export function demoHistoryDevices(): HistoryDevice[] {
  const ids = [...new Set(SESSIONS.map((s) => s.uniqueId))];
  return ids.map((id) => ({
    uniqueId: id,
    unique_id: id,
    deviceId: id,
    name: id,
    sampleCount: SESSIONS.filter((s) => s.uniqueId === id).reduce(
      (n, s) => n + (s.sample_count || 0),
      0,
    ),
  }));
}

export function demoSessionsFor(deviceId: string): SessionSummary[] {
  return SESSIONS.filter((s) => s.uniqueId === deviceId).map(
    ({ track: _track, uniqueId: _u, ...summary }) => summary,
  );
}

function payloadFor(session: DemoSession): DashboardHistoryPayload {
  return {
    track: session.track,
    from: session.started_at,
    to: session.ended_at ?? undefined,
    uniqueId: session.uniqueId,
    athleteId: session.athleteId,
    boatClass: session.boatClass,
    boat_class: session.boatClass,
    athlete_id: session.athleteId,
  };
}

export function demoSessionDashboard(sessionId: string): DashboardHistoryPayload {
  const session = SESSIONS.find((s) => s.session_id === sessionId);
  if (!session) return { track: [] };
  return payloadFor(session);
}

export function demoDeviceHistoryRange(
  deviceId: string,
  fromIso: string,
  toIso: string,
): DashboardHistoryPayload {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const matches = SESSIONS.filter((s) => {
    if (s.uniqueId !== deviceId) return false;
    const start = Date.parse(s.started_at);
    const end = Date.parse(s.ended_at || s.started_at);
    return start <= to && end >= from;
  });
  const track = matches.flatMap((s) =>
    s.track.filter((p) => p.t >= from && p.t <= to),
  );
  const first = matches[0];
  return {
    track,
    from: fromIso,
    to: toIso,
    uniqueId: deviceId,
    athleteId: first?.athleteId,
    boatClass: first?.boatClass,
  };
}

function pathDistanceM(track: HistoryPoint[]): number {
  let d = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) continue;
    const p1 = dest(a.lat, a.lon, 0, 0);
    const R = EARTH_M;
    const φ1 = (a.lat * Math.PI) / 180;
    const φ2 = (b.lat * Math.PI) / 180;
    const dφ = φ2 - φ1;
    const dλ = ((b.lon - a.lon) * Math.PI) / 180;
    const h =
      Math.sin(dφ / 2) ** 2 +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    d += 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    void p1;
  }
  return d;
}

function nzYmdFromIso(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function demoLogbook(): LogbookPayload {
  const byDay = new Map<
    string,
    {
      date: string;
      sessionCount: number;
      capsizeCount: number;
      distanceM: number;
      onWaterMs: number;
      sessions: Array<{
        sessionId: string;
        uniqueId: string;
        crew: string;
        athleteId?: string | null;
        rowerName?: string | null;
        source?: string | null;
        noGps?: boolean;
        startedAt: string;
        endedAt: string;
        capsize: boolean;
        distanceM: number;
        onWaterMs: number;
      }>;
    }
  >();
  for (const s of SESSIONS) {
    const date = nzYmdFromIso(s.started_at);
    const start = Date.parse(s.started_at);
    const end = Date.parse(s.ended_at || s.started_at);
    const distanceM = Math.round(pathDistanceM(s.track));
    const onWaterMs = Math.max(0, end - start);
    const row = {
      sessionId: s.session_id,
      uniqueId: s.uniqueId,
      crew: s.uniqueId,
      athleteId: s.athleteId,
      rowerName: s.athleteId,
      source: 'demo',
      noGps: false,
      startedAt: s.started_at,
      endedAt: s.ended_at || s.started_at,
      capsize: false,
      distanceM,
      onWaterMs,
    };
    const day = byDay.get(date) || {
      date,
      sessionCount: 0,
      capsizeCount: 0,
      distanceM: 0,
      onWaterMs: 0,
      sessions: [] as typeof row[],
    };
    day.sessionCount += 1;
    day.distanceM += distanceM;
    day.onWaterMs += onWaterMs;
    day.sessions.push(row);
    byDay.set(date, day);
  }
  const days = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
  return { ok: true, timeZone: 'Pacific/Auckland', days };
}
