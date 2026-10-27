/**
 * Isolated recorder demo seed. Active only when `?demo=1` is on the page URL.
 * Does not write production settings, session, or outbox keys.
 */

import type { RecorderSettings } from '@rowing/telemetry-types';
import type { RecorderController, RecorderStats } from '../session/recorder';
import type {
  DashboardHistoryPayload,
  HistoryPoint,
  SessionSummary,
  SessionsListResult,
} from './history-api';
import { pushSessionSpeedSample, clearSessionSpeedBuffer } from './session-speed-buffer';

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

export const DEMO_DEVICE_ID = 'W1x Emma';

export function demoRecorderSettings(base: RecorderSettings): RecorderSettings {
  return {
    ...base,
    deviceId: DEMO_DEVICE_ID,
    athleteId: 'Mike',
    coachId: 'coach-1',
    coachIds: ['coach-1'],
    boatId: 'boat-2',
    boatClass: 'W1x',
    ingestToken: 'demo',
    enableGps: true,
    enableMotion: true,
    enableHr: true,
    geofenceSessionControl: false,
  };
}

const COURSE_START = { lat: -37.9428, lon: 175.5575 };
const COURSE_BEARING = 348;
const EARTH_M = 6_371_000;
const LIVE_STARTED_OFFSET_MS = 12 * 60 * 1000;
const LIVE_SPEED = 4.72;
const LIVE_SPM = 28;
const LIVE_LANE = -18;

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

export function demoLiveSample(nowMs = Date.now()): {
  lat: number;
  lon: number;
  speedMps: number;
  spm: number;
  hr: number;
  distanceM: number;
} {
  const elapsed = LIVE_STARTED_OFFSET_MS + (nowMs % 1000);
  const along = Math.min(1950, 80 + (elapsed / 1000) * LIVE_SPEED);
  const wobble = 0.16 * Math.sin(nowMs / 28000) + 0.05 * Math.sin(nowMs / 9000);
  const pos = pointAlong(along, LIVE_LANE);
  return {
    lat: pos.lat,
    lon: pos.lon,
    speedMps: LIVE_SPEED + wobble,
    spm: LIVE_SPM + Math.round(Math.sin(nowMs / 18000)),
    hr: 154 + Math.round(Math.sin(nowMs / 8000) * 4),
    distanceM: along,
  };
}

export function seedDemoSpeedBuffer(nowMs = Date.now()): void {
  clearSessionSpeedBuffer();
  const windowMs = 8 * 60 * 1000;
  for (let t = nowMs - windowMs; t <= nowMs; t += 1000) {
    const sample = demoLiveSample(t);
    pushSessionSpeedSample(
      {
        t,
        speedMps: sample.speedMps,
        lat: sample.lat,
        lon: sample.lon,
        strokeRateSpm: sample.spm,
      },
      nowMs,
    );
  }
}

export function createDemoController(): RecorderController {
  return {
    sessionId: 'demo-live-w1x-emma',
    stop: async () => {},
    stopForGeofenceStandby: async () => {},
    getStats: (): RecorderStats => {
      const sample = demoLiveSample();
      return {
        gpsCount: 720,
        motionCount: 14000,
        hrCount: 720,
        lastHr: sample.hr,
        lastGps: {
          t: Date.now(),
          lat: sample.lat,
          lon: sample.lon,
          spd: sample.speedMps,
        },
        speedMps: sample.speedMps,
        distanceM: sample.distanceM,
        pendingOutbox: 0,
        strokeRate: sample.spm,
        tiltDeg: 4,
        capsize: false,
        motionCalibrated: true,
        inBoatPark: false,
        boatParkName: null,
        restrictionKind: null,
        recordingSuppressed: false,
        regattaMessage: null,
        inHazardZone: false,
        hazardWarning: null,
      };
    },
    flush: async () => {},
    connectHr: async () => {},
    dismissRegattaMessage: async () => {},
    recallCapsize: async () => {},
  };
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

type DemoSession = SessionSummary & { uniqueId: string; track: HistoryPoint[] };

const SESSIONS: DemoSession[] = (() => {
  const am = Date.parse(nzLocalIso(0, 6, 12));
  const yesterday = Date.parse(nzLocalIso(1, 16, 40));
  return [
    {
      session_id: 'demo-sess-emma-am',
      unique_id: DEMO_DEVICE_ID,
      uniqueId: DEMO_DEVICE_ID,
      started_at: new Date(am).toISOString(),
      ended_at: new Date(am + 18 * 60 * 1000).toISOString(),
      sample_count: 540,
      boat_class: 'W1x',
      boatClass: 'W1x',
      athlete_id: 'Emma',
      athleteId: 'Emma',
      track: buildPieceTrack(am, 18 * 60 * 1000, -18, 4.7, 28, 152),
    },
    {
      session_id: 'demo-sess-emma-pm',
      unique_id: DEMO_DEVICE_ID,
      uniqueId: DEMO_DEVICE_ID,
      started_at: new Date(yesterday).toISOString(),
      ended_at: new Date(yesterday + 22 * 60 * 1000).toISOString(),
      sample_count: 660,
      boat_class: 'W1x',
      boatClass: 'W1x',
      athlete_id: 'Emma',
      athleteId: 'Emma',
      track: buildPieceTrack(yesterday, 22 * 60 * 1000, -12, 4.55, 27, 148),
    },
  ];
})();

export function demoSessionsList(deviceId: string): SessionsListResult {
  const id = deviceId.trim() || DEMO_DEVICE_ID;
  return {
    sessions: SESSIONS.filter((s) => s.uniqueId === id || id === DEMO_DEVICE_ID).map(
      ({ track: _t, uniqueId: _u, ...summary }) => summary,
    ),
    persisted: true,
  };
}

export function demoSessionDashboard(sessionId: string): DashboardHistoryPayload {
  const session = SESSIONS.find((s) => s.session_id === sessionId) || SESSIONS[0];
  if (!session) return { track: [] };
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

export function demoSessionStartedAt(nowMs = Date.now()): number {
  return nowMs - LIVE_STARTED_OFFSET_MS;
}
