import {
  formatPrognostic,
  parseBoatClass,
  prognosticPercent,
} from '@rowing/rowing-pace';
import type { ParsedCourse, TimingLine, TracePoint } from './course-types';
import { formatSplit500 } from './course-format';

export type CourseSegment = {
  line: TimingLine;
  from: number;
  to: number;
};

export type CourseStats = {
  avgMps: number | null;
  avgSpm: number | null;
  avgProg: string | null;
  progNum: number | null;
};

export function markerAlongM(
  line: TimingLine,
  course: ParsedCourse,
  reversed: boolean,
): number | null {
  if (line.distanceM == null || !Number.isFinite(line.distanceM)) return null;
  return reversed
    ? (course.finishDist ?? 0) - line.distanceM
    : line.distanceM - (course.startDist ?? 0);
}

export function courseSegments(
  course: ParsedCourse,
  reversed: boolean,
): CourseSegment[] {
  const ordered = [...course.markers].sort(
    (a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0),
  );
  const splitLines = ordered.filter((l) => l.lineType !== 'start');
  let prevAlong = 0;
  return splitLines.map((line) => {
    const along = markerAlongM(line, course, reversed);
    const seg = { line, from: prevAlong, to: along ?? prevAlong };
    if (along != null) prevAlong = along;
    return seg;
  });
}

export function avgSpeedInSegment(
  trace: TracePoint[],
  distFrom: number,
  distTo: number,
): number | null {
  if (!trace.length) return null;
  const lo = Math.min(distFrom, distTo);
  const hi = Math.max(distFrom, distTo);
  const samples = trace.filter(
    (p) =>
      p.speedMps > 0 &&
      Number.isFinite(p.distM) &&
      p.distM >= lo - 0.5 &&
      p.distM <= hi + 0.5,
  );
  if (!samples.length) return null;
  return samples.reduce((sum, p) => sum + p.speedMps, 0) / samples.length;
}

export function avgStrokeInSegment(
  trace: TracePoint[],
  distFrom: number,
  distTo: number,
): number | null {
  if (!trace.length) return null;
  const lo = Math.min(distFrom, distTo);
  const hi = Math.max(distFrom, distTo);
  const samples = trace.filter(
    (p) =>
      (p.strokeRate ?? 0) > 0 &&
      Number.isFinite(p.distM) &&
      p.distM >= lo - 0.5 &&
      p.distM <= hi + 0.5,
  );
  if (!samples.length) return null;
  return samples.reduce((sum, p) => sum + (p.strokeRate ?? 0), 0) / samples.length;
}

export function formatPrognosticForDevice(
  mps: number | null | undefined,
  deviceId: string,
  athleteId?: string | null,
): string | null {
  if (mps == null || !Number.isFinite(mps) || mps <= 0) return null;
  const boat = parseBoatClass(deviceId, athleteId ?? undefined);
  if (!boat) return null;
  return formatPrognostic(mps, boat);
}

export function prognosticPercentForDevice(
  mps: number | null | undefined,
  deviceId: string,
  athleteId?: string | null,
): number | null {
  if (mps == null || !Number.isFinite(mps) || mps <= 0) return null;
  const boat = parseBoatClass(deviceId, athleteId ?? undefined);
  if (!boat) return null;
  return prognosticPercent(mps, boat);
}

export function computeCourseStats(
  trace: TracePoint[],
  course: ParsedCourse,
  deviceId: string,
  athleteId?: string | null,
): CourseStats {
  const avgMps = avgSpeedInSegment(trace, 0, course.totalDist);
  const avgSpm = avgStrokeInSegment(trace, 0, course.totalDist);
  return {
    avgMps,
    avgSpm,
    avgProg: formatPrognosticForDevice(avgMps, deviceId, athleteId),
    progNum: prognosticPercentForDevice(avgMps, deviceId, athleteId),
  };
}

export function formatPaceCell(
  mps: number | null | undefined,
  deviceId: string,
  athleteId?: string | null,
): string {
  if (mps == null || !Number.isFinite(mps) || mps <= 0) return '—';
  const split = formatSplit500(mps);
  const prog = formatPrognosticForDevice(mps, deviceId, athleteId);
  return prog ? `${split} · ${prog}` : split;
}

export function hasFinishedCourse(
  crossed: Map<number, number>,
  course: ParsedCourse,
): boolean {
  if (!course.finish) return false;
  return crossed.has(course.finish.id);
}
