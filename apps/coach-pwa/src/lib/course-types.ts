export type TimingLineType = 'start' | 'finish' | 'split';

export type TimingLine = {
  id: number;
  name: string;
  lineType: TimingLineType;
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
  distanceM: number | null;
  sortOrder: number;
  courseGroup: string | null;
  courseBearingDeg: number | null;
  enabled: boolean;
};

export type ParsedCourse = {
  group: string;
  start: TimingLine;
  finish: TimingLine;
  lines: TimingLine[];
  markers: TimingLine[];
  bearing: number;
  startDist: number;
  finishDist: number;
  totalDist: number;
};

export type LatLon = { lat: number; lon: number };

export type PosSample = LatLon & { t: number };

export type TracePoint = { distM: number; speedMps: number };

export type LiveDeviceState = {
  speedMps: number | null;
  strokeRate: number | null;
  athleteId: string | null;
  stale: boolean;
  lastSeenAgoSec: number | null;
};

export type RollingStartState = {
  confirmed: boolean;
  tMs?: number;
  distM?: number;
  lat?: number;
  lon?: number;
  pendingDistM: number;
  pendingStartT?: number;
  pendingStartAlong?: number;
  pendingStartLat?: number;
  pendingStartLon?: number;
  lastAlong?: number;
  source?: string;
};

export type PollPosition = {
  deviceId: string;
  latitude: number;
  longitude: number;
  speed?: number | null;
  strokeRate?: number | null;
  strokeRateValid?: boolean;
  athleteId?: string | null;
  lastSeenAgoSec?: number | null;
  telemetryStale?: boolean;
  online?: boolean;
};
