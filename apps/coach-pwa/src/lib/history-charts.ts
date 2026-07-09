import type { ChartSeries } from './history-track';

export type ChartOptions = {
  title: string;
  xLabel: string;
  yLabel: string;
  yFormat?: (v: number) => string;
};

function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min) return [min];
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / count)));
  const err = span / step / count;
  let tickStep = step;
  if (err >= 7.5) tickStep = step * 10;
  else if (err >= 3.5) tickStep = step * 5;
  else if (err >= 1.5) tickStep = step * 2;
  const start = Math.ceil(min / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let v = start; v <= max + tickStep * 0.01; v += tickStep) ticks.push(v);
  return ticks.length ? ticks : [min, max];
}

export function drawMultiSeriesChart(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  opts: ChartOptions,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 200;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = cssW;
  const h = cssH;
  const padL = 44;
  const padR = 12;
  const padT = 36;
  const padB = 32;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);

  // Background
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#0f172a');
  bg.addColorStop(1, '#1e293b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillText(opts.title, padL, 20);

  const plotted = series.filter((s) => s.points.length >= 2);
  const allPts = plotted.flatMap((s) => s.points);
  if (allPts.length < 2) {
    ctx.fillStyle = '#64748b';
    ctx.font = '12px system-ui';
    ctx.fillText(
      series.length > 1 ? 'No data in selection for selected devices' : 'No data in selection',
      padL,
      padT + 24,
    );
    return;
  }

  const xs = allPts.map((p) => p.x);
  const ys = allPts.map((p) => p.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  if (maxX - minX < 1e-6) maxX = minX + 1;
  if (maxY - minY < 1e-6) {
    minY -= 1;
    maxY += 1;
  }
  minY = Math.max(0, minY - (maxY - minY) * 0.08);
  maxY += (maxY - minY) * 0.08;

  const sx = (x: number) => padL + ((x - minX) / (maxX - minX)) * plotW;
  const sy = (y: number) => padT + plotH - ((y - minY) / (maxY - minY)) * plotH;

  // Grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)';
  ctx.lineWidth = 1;
  for (const ty of niceTicks(minY, maxY, 4)) {
    const py = sy(ty);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    const label = opts.yFormat ? opts.yFormat(ty) : ty.toFixed(1);
    ctx.fillText(label, padL - 6, py + 3);
  }
  for (const tx of niceTicks(minX, maxX, 5)) {
    const px = sx(tx);
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(tx * 10) / 10), px, h - 10);
  }

  // Series lines + area
  for (const s of plotted) {
    if (s.points.length < 2) continue;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const px = sx(p.x);
      const py = sy(p.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.lineTo(sx(s.points[s.points.length - 1].x), padT + plotH);
    ctx.lineTo(sx(s.points[0].x), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = s.color + '22';
    ctx.fill();
  }

  // Legend
  let lx = padL;
  const ly = h - 6;
  ctx.font = '11px system-ui';
  ctx.textAlign = 'left';
  for (const s of plotted) {
    if (!s.points.length) continue;
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, ly - 9, 10, 10);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(s.label, lx + 14, ly);
    lx += ctx.measureText(s.label).width + 28;
  }

  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';
  ctx.fillText(opts.xLabel, w - padR, h - 10);
}
