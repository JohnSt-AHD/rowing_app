import type { LatLon, ParsedCourse, TimingLine } from './course-types';

const EARTH_R = 6371000;

function toRad(d: number) {
  return (d * Math.PI) / 180;
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function lineMidpoint(line: TimingLine) {
  return { lat: (line.lat1 + line.lat2) / 2, lon: (line.lon1 + line.lon2) / 2 };
}

export function linesForCourse(lines: TimingLine[], group: string) {
  return lines
    .filter((l) => l.enabled !== false && (l.courseGroup || 'Other') === group)
    .sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        (a.distanceM ?? 0) - (b.distanceM ?? 0),
    );
}

export function courseGroupsFromLines(lines: TimingLine[]): string[] {
  const groups = new Set<string>();
  for (const line of lines) {
    if (line.enabled === false) continue;
    groups.add(line.courseGroup || 'Other');
  }
  return [...groups].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export function parseCourse(lines: TimingLine[], group: string): ParsedCourse | null {
  const courseLines = linesForCourse(lines, group);
  if (!courseLines.length) return null;
  const start = courseLines.find((l) => l.lineType === 'start') || courseLines[0];
  const finish =
    [...courseLines].reverse().find((l) => l.lineType === 'finish') ||
    courseLines[courseLines.length - 1];
  let bearing = start?.courseBearingDeg ?? NaN;
  if (!Number.isFinite(bearing) && start) {
    bearing = (bearingDeg(start.lat1, start.lon1, start.lat2, start.lon2) + 90 + 360) % 360;
  }
  const startDist = start?.distanceM ?? 0;
  let finishDist = finish?.distanceM ?? NaN;
  if (!Number.isFinite(finishDist)) {
    finishDist = Math.max(...courseLines.map((l) => l.distanceM ?? 0).filter(Number.isFinite));
  }
  if (!Number.isFinite(finishDist) || finishDist <= startDist) {
    finishDist = startDist + 2000;
  }
  const totalDist = finishDist - startDist;
  const markers = courseLines.filter(
    (l) => l.lineType === 'start' || l.lineType === 'finish' || l.lineType === 'split',
  );
  return {
    group,
    start,
    finish,
    lines: courseLines,
    markers,
    bearing,
    startDist,
    finishDist,
    totalDist,
  };
}

export function distanceAlongCourse(lat: number, lon: number, course: ParsedCourse) {
  if (!course?.start || !Number.isFinite(course.bearing)) return null;
  const mid = lineMidpoint(course.start);
  const dist = haversineM(mid.lat, mid.lon, lat, lon);
  const brg = bearingDeg(mid.lat, mid.lon, lat, lon);
  return dist * Math.cos(toRad(brg - course.bearing));
}

export function effectiveAlong(
  lat: number,
  lon: number,
  course: ParsedCourse,
  reversed: boolean,
) {
  const along = distanceAlongCourse(lat, lon, course);
  if (along == null || !Number.isFinite(along)) return null;
  return reversed ? course.totalDist - along : along;
}

export function timingStartLine(course: ParsedCourse, reversed: boolean) {
  return reversed && course.finish ? course.finish : course.start;
}

function ccw(a: LatLon, b: LatLon, c: LatLon) {
  return (c.lat - a.lat) * (b.lon - a.lon) > (b.lat - a.lat) * (c.lon - a.lon);
}

function segmentsCross(a: LatLon, b: LatLon, c: LatLon, d: LatLon) {
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

export function segmentsCrossDirected(
  prev: LatLon,
  cur: LatLon,
  line: TimingLine,
  course: ParsedCourse,
  reversed: boolean,
) {
  if (
    !segmentsCross(prev, cur, { lat: line.lat1, lon: line.lon1 }, { lat: line.lat2, lon: line.lon2 })
  ) {
    return false;
  }
  const alongPrev = effectiveAlong(prev.lat, prev.lon, course, reversed);
  const alongCur = effectiveAlong(cur.lat, cur.lon, course, reversed);
  if (alongPrev == null || alongCur == null) return false;
  return alongCur - alongPrev > 0.3;
}

export function courseBounds(course: ParsedCourse): [number, number][] {
  const pts: [number, number][] = [];
  for (const l of course.lines) {
    pts.push([l.lat1, l.lon1], [l.lat2, l.lon2]);
  }
  return pts;
}

export function markerLabelM(
  line: TimingLine,
  course: ParsedCourse,
  reversed: boolean,
): string {
  if (line.distanceM == null) return line.name;
  const m = Math.round(
    reversed ? (course.finishDist ?? 0) - line.distanceM : line.distanceM - course.startDist,
  );
  return `${m}m`;
}
