import { parseBoatClass, reference2kSec } from '@rowing/rowing-pace';
import type {
  LiveDeviceState,
  ParsedCourse,
  PollPosition,
  PosSample,
  RollingStartState,
  TracePoint,
} from './course-types';
import {
  avgSpeedInSegment,
  prognosticPercentForDevice,
} from './course-stats';
import {
  effectiveAlong,
  haversineM,
  parseCourse,
  segmentsCrossDirected,
  crossingTimeForLine,
  timingStartLine,
  type TimingLine,
} from './course-geo';

const REST_SPEED_MPS = 0.5;
const ROLLING_START_DIST_M = 200;
const ROLLING_PROGNOSTIC_PCT = 50;
const TELEMETRY_STALE_SEC = 30;
/** Cap implausible speeds (bad GPS jumps inflate prognostic). */
const MAX_ROW_SPEED_MPS = 7.5;
const MAX_JUMP_SPEED_MPS = 12;
const GPS_JUMP_DROPOUT_M = 60;
const FROZEN_POLLS_DROPOUT = 3;

type PathTrackState = {
  pathDistM: number;
  chartDistM: number;
  baselinePathM: number;
  baselineCourseM: number;
  dropoutActive: boolean;
  frozenPolls: number;
};

export const DEVICE_COLORS = [
  '#00e5ff',
  '#4ade80',
  '#a78bfa',
  '#fbbf24',
  '#fb7185',
  '#38bdf8',
  '#f97316',
  '#86efac',
  '#c084fc',
  '#34d399',
];

export function colorForDevice(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DEVICE_COLORS[h % DEVICE_COLORS.length];
}

function posFromRecord(p: PollPosition) {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return null;
  return { lat: p.latitude, lon: p.longitude };
}

function rowingSpeedMps(
  p: PollPosition,
  prev: PosSample | undefined,
  dtSec: number,
): number | null {
  const phone = p.speed;
  let computed: number | null = null;
  if (prev && dtSec > 0) {
    const cur = posFromRecord(p);
    if (cur) {
      const d = haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
      if (d >= 0.5) computed = d / dtSec;
    }
  }
  if (phone != null && Number.isFinite(phone) && phone > 0 && phone <= MAX_ROW_SPEED_MPS) {
    return phone;
  }
  if (computed != null && computed <= MAX_JUMP_SPEED_MPS) {
    return Math.min(computed, MAX_ROW_SPEED_MPS);
  }
  if (phone != null && Number.isFinite(phone) && phone > 0) {
    return Math.min(phone, MAX_ROW_SPEED_MPS);
  }
  return null;
}

function prognosticThresholdMps(deviceId: string, athleteId?: string | null) {
  const boat = parseBoatClass(deviceId, athleteId ?? undefined);
  const refSec = reference2kSec(boat);
  if (!refSec) return null;
  return 2000 / (refSec / (ROLLING_PROGNOSTIC_PCT / 100));
}

export class CourseRaceEngine {
  lines: TimingLine[] = [];
  selectedCourse = '';
  courseReversed = false;
  rollingStartEnabled = true;
  hiddenDevices = new Set<string>();

  private lastPosByDevice = new Map<string, PosSample>();
  private crossingsByDevice = new Map<string, Map<number, number>>();
  private tracesByDevice = new Map<string, TracePoint[]>();
  private liveByDevice = new Map<string, LiveDeviceState>();
  private raceStartByDevice = new Map<string, RollingStartState>();
  private pathByDevice = new Map<string, PathTrackState>();

  setLines(lines: TimingLine[]) {
    this.lines = lines.filter((l) => l.enabled !== false);
  }

  setCourseGroup(group: string) {
    this.selectedCourse = group;
  }

  resetSession() {
    this.lastPosByDevice.clear();
    this.crossingsByDevice.clear();
    this.tracesByDevice.clear();
    this.liveByDevice.clear();
    this.raceStartByDevice.clear();
    this.pathByDevice.clear();
    this.hiddenDevices.clear();
  }

  getCourse(): ParsedCourse | null {
    if (!this.selectedCourse) return null;
    return parseCourse(this.lines, this.selectedCourse);
  }

  visibleDeviceIds(extra: string[] = []) {
    const ids = new Set([
      ...this.tracesByDevice.keys(),
      ...this.crossingsByDevice.keys(),
      ...extra,
    ]);
    return [...ids].filter((id) => !this.hiddenDevices.has(id));
  }

  visibleDeviceIdsByProg(extra: string[] = []) {
    const course = this.getCourse();
    const ids = this.visibleDeviceIds(extra);
    if (!course) {
      return [...ids].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      );
    }
    return ids.sort((a, b) => {
      const liveA = this.liveByDevice.get(a);
      const liveB = this.liveByDevice.get(b);
      const progA =
        this.courseProgNum(a, course, liveA?.athleteId) ?? -1;
      const progB =
        this.courseProgNum(b, course, liveB?.athleteId) ?? -1;
      if (progB !== progA) return progB - progA;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
  }

  private courseProgNum(
    deviceId: string,
    course: ParsedCourse,
    athleteId?: string | null,
  ) {
    const trace = this.getTrace(deviceId);
    const avgMps = avgSpeedInSegment(trace, 0, course.totalDist);
    return prognosticPercentForDevice(avgMps, deviceId, athleteId);
  }

  hasFinishedCourse(deviceId: string, course: ParsedCourse) {
    const crossed = this.crossingsByDevice.get(deviceId);
    if (!crossed || !course.finish) return false;
    return (
      crossed.has(course.finish.id) ||
      crossingTimeForLine(crossed, course.finish, course) != null
    );
  }

  usesRollingStartGate(deviceId: string, athleteId?: string | null) {
    return this.rollingStartEnabled && prognosticThresholdMps(deviceId, athleteId) != null;
  }

  hideDevice(deviceId: string) {
    this.hiddenDevices.add(deviceId);
  }

  getEffectiveStartMs(deviceId: string, course: ParsedCourse) {
    const rolling = this.raceStartByDevice.get(deviceId);
    if (rolling?.confirmed && rolling.tMs != null) return rolling.tMs;
    const startLine = timingStartLine(course, this.courseReversed);
    const t = crossingTimeForLine(this.crossingsByDevice.get(deviceId), startLine, course);
    if (t != null && Number.isFinite(t)) {
      if (this.rollingStartEnabled && prognosticThresholdMps(deviceId) != null) return null;
      return t;
    }
    return null;
  }

  processPoll(positions: PollPosition[], nowMs: number) {
    const course = this.getCourse();
    if (!course) return;

    for (const p of positions) {
      const deviceId = p.deviceId;
      if (!deviceId) continue;
      const cur = posFromRecord(p);
      if (!cur) continue;

      const prev = this.lastPosByDevice.get(deviceId);
      const dtSec = prev ? Math.max(0.05, (nowMs - prev.t) / 1000) : 0;
      this.lastPosByDevice.set(deviceId, { ...cur, t: nowMs });

      const spd = rowingSpeedMps(p, prev, dtSec);
      const receiveAgo = p.lastSeenAgoSec ?? null;
      const stale =
        p.telemetryStale === true ||
        (receiveAgo != null && receiveAgo > TELEMETRY_STALE_SEC);

      let pathStepM = 0;
      if (prev) {
        pathStepM = haversineM(prev.lat, prev.lon, cur.lat, cur.lon);
      }
      const pathState = this.pathByDevice.get(deviceId) ?? {
        pathDistM: 0,
        chartDistM: 0,
        baselinePathM: 0,
        baselineCourseM: 0,
        dropoutActive: false,
        frozenPolls: 0,
      };
      if (pathStepM >= 0.5) {
        pathState.pathDistM += pathStepM;
      }
      pathState.frozenPolls =
        pathStepM < 0.5 ? pathState.frozenPolls + 1 : 0;
      this.pathByDevice.set(deviceId, pathState);
      const strokeRate =
        !stale
          ? (p.displayStrokeRate ?? (p.strokeRateValid && p.strokeRate != null ? p.strokeRate : null))
          : null;
      this.liveByDevice.set(deviceId, {
        speedMps: stale ? null : spd,
        strokeRate,
        athleteId: p.athleteId ?? null,
        stale,
        lastSeenAgoSec: receiveAgo,
      });

      const effAlong = effectiveAlong(cur.lat, cur.lon, course, this.courseReversed);
      this.updateRollingStart(deviceId, {
        spd,
        along: effAlong,
        nowMs,
        athleteId: p.athleteId,
      });

      if (!this.crossingsByDevice.has(deviceId)) {
        this.crossingsByDevice.set(deviceId, new Map());
      }
      const crossed = this.crossingsByDevice.get(deviceId)!;
      if (prev) {
        for (const line of course.lines) {
          if (crossed.has(line.id)) continue;
          if (!segmentsCrossDirected(prev, cur, line, course, this.courseReversed)) continue;
          crossed.set(line.id, nowMs);
        }
      }

      if (effAlong == null) continue;
      const tStart = this.getEffectiveStartMs(deviceId, course);
      const onCourse = tStart || (effAlong >= -20 && effAlong <= course.totalDist + 40);
      if (!onCourse) continue;
      if (spd == null || !Number.isFinite(spd) || spd <= 0) continue;

      const courseDist = Math.max(0, Math.min(course.totalDist, effAlong));
      const dropout =
        stale ||
        pathState.frozenPolls >= FROZEN_POLLS_DROPOUT ||
        pathStepM >= GPS_JUMP_DROPOUT_M;
      const distM = this.resolveChartDist(
        pathState,
        course,
        courseDist,
        dropout,
      );
      this.pathByDevice.set(deviceId, pathState);

      if (!this.tracesByDevice.has(deviceId)) this.tracesByDevice.set(deviceId, []);
      const trace = this.tracesByDevice.get(deviceId)!;
      const last = trace[trace.length - 1];
      if (
        !last ||
        Math.abs(last.distM - distM) > 2 ||
        Math.abs(last.speedMps - spd) > 0.15
      ) {
        trace.push({
          distM,
          speedMps: spd,
          strokeRate:
            strokeRate != null && Number.isFinite(strokeRate) && strokeRate > 0
              ? strokeRate
              : null,
        });
        if (trace.length > 800) trace.shift();
      }
    }
  }

  /** Course projection normally; monotonic GPS path distance while dropout active. */
  private resolveChartDist(
    state: PathTrackState,
    course: ParsedCourse,
    courseDist: number,
    dropout: boolean,
  ): number {
    let distM: number;
    if (!dropout) {
      state.baselinePathM = state.pathDistM;
      state.baselineCourseM = courseDist;
      state.dropoutActive = false;
      distM = courseDist;
    } else {
      if (!state.dropoutActive) state.dropoutActive = true;
      distM =
        state.baselineCourseM +
        Math.max(0, state.pathDistM - state.baselinePathM);
    }
    distM = Math.max(0, Math.min(course.totalDist, distM));
    state.chartDistM = Math.max(state.chartDistM, distM);
    return state.chartDistM;
  }

  private updateRollingStart(
    deviceId: string,
    opts: {
      spd: number | null;
      along: number | null;
      nowMs: number;
      athleteId?: string | null;
    },
  ) {
    if (!this.rollingStartEnabled) return;
    const threshold = prognosticThresholdMps(deviceId, opts.athleteId);
    if (threshold == null) return;

    let st = this.raceStartByDevice.get(deviceId);
    if (!st) {
      st = { confirmed: false, pendingDistM: 0 };
      this.raceStartByDevice.set(deviceId, st);
    }
    if (st.confirmed) return;

    const isFast = opts.spd != null && Number.isFinite(opts.spd) && opts.spd >= threshold;
    const isRest = opts.spd == null || !Number.isFinite(opts.spd) || opts.spd < REST_SPEED_MPS;

    if (isFast && opts.along != null) {
      if (st.pendingStartT == null) {
        st.pendingStartT = opts.nowMs;
        st.pendingStartAlong = opts.along;
        st.pendingDistM = 0;
      } else if (st.lastAlong != null && Number.isFinite(st.lastAlong)) {
        st.pendingDistM += Math.max(0, opts.along - st.lastAlong);
      }
      if (st.pendingDistM >= ROLLING_START_DIST_M) {
        st.confirmed = true;
        st.tMs = st.pendingStartT;
        st.distM = st.pendingStartAlong;
        st.source = 'rolling';
      }
    } else if (isRest) {
      st.pendingStartT = undefined;
      st.pendingDistM = 0;
      st.pendingStartAlong = undefined;
    }
    if (opts.along != null) st.lastAlong = opts.along;
  }

  getCrossings(deviceId: string) {
    return this.crossingsByDevice.get(deviceId) ?? new Map<number, number>();
  }

  getLive(deviceId: string) {
    return this.liveByDevice.get(deviceId);
  }

  getTrace(deviceId: string) {
    return this.tracesByDevice.get(deviceId) ?? [];
  }

  getRollingStart(deviceId: string) {
    return this.raceStartByDevice.get(deviceId);
  }

  getTraces() {
    return this.tracesByDevice;
  }
}
