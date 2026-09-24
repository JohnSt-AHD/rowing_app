/** Dark-theme canvas speed-vs-time chart for recorder fullscreen. */

export type SpeedChartPoint = { x: number; y: number };

export type SpeedChartOptions = {
  title?: string;
  yLabel?: string;
  xLabel?: string;
  color?: string;
};

function niceTicks(min: number, max: number, count: number): number[] {
  if (max <= min) return [min];
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span / Math.max(count, 1))));
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

export function drawSpeedTimeChart(
  canvas: HTMLCanvasElement,
  points: SpeedChartPoint[],
  opts: SpeedChartOptions = {},
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
  const padL = 42;
  const padR = 14;
  const padT = 36;
  const padB = 28;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const lineColor = opts.color || '#00e5ff';
  const title = opts.title || 'Speed vs time (last 8 min)';

  ctx.clearRect(0, 0, w, h);

  // Panel background (matches CrewSight cards)
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, 'rgba(12, 28, 52, 0.98)');
  bg.addColorStop(1, 'rgba(10, 22, 40, 0.98)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  ctx.fillStyle = '#e8f4fc';
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, padL, 22);

  if (points.length < 2) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui';
    ctx.fillText('Waiting for GPS speed…', padL, padT + 24);
    return;
  }

  let minX = Math.min(...points.map((p) => p.x));
  let maxX = Math.max(...points.map((p) => p.x));
  let minY = Math.min(...points.map((p) => p.y));
  let maxY = Math.max(...points.map((p) => p.y));
  if (maxX - minX < 1e-6) maxX = minX + 1;
  if (maxY - minY < 1e-6) {
    minY = Math.max(0, minY - 1);
    maxY = maxY + 1;
  }
  minY = Math.max(0, minY - (maxY - minY) * 0.1);
  maxY += (maxY - minY) * 0.12;

  const sx = (x: number) => padL + ((x - minX) / (maxX - minX)) * plotW;
  const sy = (y: number) => padT + plotH - ((y - minY) / (maxY - minY)) * plotH;

  // Grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
  ctx.lineWidth = 1;
  for (const ty of niceTicks(minY, maxY, 4)) {
    const py = sy(ty);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(ty.toFixed(1), padL - 6, py + 3);
  }
  for (const tx of niceTicks(minX, maxX, 5)) {
    const px = sx(tx);
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(tx * 10) / 10), px, h - 9);
  }

  // Area under curve
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = sx(p.x);
    const py = sy(p.y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  const last = points[points.length - 1];
  const first = points[0];
  ctx.lineTo(sx(last.x), padT + plotH);
  ctx.lineTo(sx(first.x), padT + plotH);
  ctx.closePath();
  const area = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  area.addColorStop(0, 'rgba(0, 229, 255, 0.28)');
  area.addColorStop(1, 'rgba(0, 229, 255, 0.02)');
  ctx.fillStyle = area;
  ctx.fill();

  // Line
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = sx(p.x);
    const py = sy(p.y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0, 229, 255, 0.45)';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // End marker
  const end = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(sx(end.x), sy(end.y), 4, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
  ctx.strokeStyle = '#0a1628';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px system-ui';
  ctx.textAlign = 'left';
  ctx.fillText(opts.yLabel || 'km/h', 8, padT + 10);
  ctx.textAlign = 'right';
  ctx.fillText(opts.xLabel || 'min', w - 8, h - 8);
}
