import { formatSplit500m } from '@rowing/rowing-pace';
import type { ParsedCourse } from './course-types';
import { colorForDevice, type CourseRaceEngine } from './course-race-engine';

export function drawPaceDistanceChart(
  canvas: HTMLCanvasElement,
  engine: CourseRaceEngine,
  course: ParsedCourse,
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

  ctx.fillStyle = '#0c1220';
  ctx.fillRect(0, 0, w, h);

  const maxDist = course.totalDist;
  let maxSpeed = 6;
  for (const trace of engine.getTraces().values()) {
    for (const pt of trace) {
      if (pt.speedMps > maxSpeed) maxSpeed = pt.speedMps;
    }
  }
  maxSpeed = Math.ceil(maxSpeed * 1.15 * 10) / 10;

  const xAt = (distM: number) => pad.l + (distM / maxDist) * plotW;
  const yAt = (spd: number) => pad.t + plotH - (spd / maxSpeed) * plotH;

  ctx.strokeStyle = 'rgba(0, 229, 255, 0.12)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
  }

  for (const line of course.markers) {
    if (line.lineType === 'start' || line.distanceM == null) continue;
    const dist = engine.courseReversed
      ? (course.finishDist ?? 0) - line.distanceM
      : line.distanceM - course.startDist;
    if (dist <= 0 || dist >= maxDist) continue;
    const x = xAt(dist);
    ctx.strokeStyle =
      line.lineType === 'finish' ? 'rgba(239, 68, 68, 0.55)' : 'rgba(59, 130, 246, 0.45)';
    ctx.setLineDash(line.lineType === 'split' ? [4, 4] : []);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
  ctx.strokeRect(pad.l, pad.t, plotW, plotH);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Distance (m)', pad.l + plotW / 2, h - 6);

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
