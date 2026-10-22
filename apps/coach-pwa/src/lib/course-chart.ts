import { formatSplit500m, speedMpsForPrognostic } from '@rowing/rowing-pace';
import type { ParsedCourse } from './course-types';
import { colorForDevice, type CourseRaceEngine } from './course-race-engine';

export type CoursePrognosticBand = { pct: number; y: number };

export function coursePrognosticBandsMps(
  boatClass: string | null | undefined,
): CoursePrognosticBand[] {
  if (!boatClass) return [];
  return [60, 70, 80, 90]
    .map((pct) => {
      const mps = speedMpsForPrognostic(pct, boatClass);
      return mps != null && Number.isFinite(mps) ? { pct, y: mps } : null;
    })
    .filter((b): b is CoursePrognosticBand => b != null);
}

export function drawPaceDistanceChart(
  canvas: HTMLCanvasElement,
  engine: CourseRaceEngine,
  course: ParsedCourse,
  options?: { prognosticBands?: CoursePrognosticBand[]; bandLabel?: string },
) {
  const wrap = canvas.parentElement;
  const w = wrap?.clientWidth || 360;
  const h = Math.max(140, wrap?.clientHeight || 180);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = { l: 44, r: 10, t: 14, b: 32 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(51, 49, 50, 0.12)';
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  const maxDist = course.totalDist;
  let maxSpeed = 6;
  for (const trace of engine.getTraces().values()) {
    for (const pt of trace) {
      if (pt.speedMps > maxSpeed) maxSpeed = pt.speedMps;
    }
  }
  for (const band of options?.prognosticBands ?? []) {
    if (band.y > maxSpeed) maxSpeed = band.y;
  }
  maxSpeed = Math.ceil(maxSpeed * 1.15 * 10) / 10;

  const xAt = (distM: number) => pad.l + (distM / maxDist) * plotW;
  const yAt = (spd: number) => pad.t + plotH - (spd / maxSpeed) * plotH;

  ctx.strokeStyle = 'rgba(51, 49, 50, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
  }

  const bands = (options?.prognosticBands ?? []).filter(
    (b) => b.y > 0 && b.y <= maxSpeed,
  );
  for (const band of bands) {
    const y = yAt(band.y);
    ctx.strokeStyle =
      band.pct >= 90
        ? 'rgba(239, 68, 68, 0.55)'
        : band.pct >= 80
          ? 'rgba(249, 115, 22, 0.5)'
          : band.pct >= 70
            ? 'rgba(234, 179, 8, 0.5)'
            : 'rgba(13, 148, 136, 0.45)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#3f4349';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${band.pct}%`, pad.l + 4, y - 3);
  }

  for (const line of course.markers) {
    if (line.lineType === 'start' || line.distanceM == null) continue;
    const dist = engine.courseReversed
      ? (course.finishDist ?? 0) - line.distanceM
      : line.distanceM - course.startDist;
    if (dist <= 0 || dist >= maxDist) continue;
    const x = xAt(dist);
    ctx.strokeStyle =
      line.lineType === 'finish' ? 'rgba(180, 35, 24, 0.65)' : 'rgba(37, 99, 235, 0.55)';
    ctx.setLineDash(line.lineType === 'split' ? [4, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = 'rgba(17, 17, 17, 0.28)';
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);

  ctx.fillStyle = '#3f4349';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  const bandNote = options?.bandLabel ? ` · ${options.bandLabel}` : '';
  ctx.fillText(`Distance (m)${bandNote}`, pad.l + plotW / 2, h - 6);

  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const spd = (maxSpeed * i) / 4;
    ctx.fillText(formatSplit500m(spd) ?? '—', pad.l - 4, yAt(spd) + 3);
  }

  for (const [deviceId, trace] of engine.getTraces()) {
    if (engine.hiddenDevices.has(deviceId)) continue;
    if (trace.length < 2) continue;
    ctx.strokeStyle = colorForDevice(deviceId);
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (const pt of trace) {
      if (pt.distM < 0 || pt.distM > maxDist) continue;
      const x = xAt(pt.distM);
      const y = yAt(Math.min(pt.speedMps, maxSpeed));
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();
  }
}
