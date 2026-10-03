import { speedMpsForPrognostic } from '@rowing/rowing-pace';
import type { ChartSeries } from './history-track';

export type ChartOptions = {
  title: string;
  xLabel: string;
  yLabel: string;
  yFormat?: (v: number) => string;
  /** Optional note under the title (e.g. missing boat class). */
  subtitle?: string;
  /** Dark CrewSight recorder theme (prognostic bands + segment colours). */
  theme?: 'light' | 'recorder';
  /** Horizontal prognostic band lines (y in chart units, usually km/h). */
  prognosticBands?: Array<{ pct: number; y: number }>;
  /** When set with bands, colour each series segment by prognostic zone. */
  colorByPrognostic?: boolean;
};

type Rgba = { r: number; g: number; b: number };

function parseHexColor(hex: string): Rgba {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function rgba(c: Rgba, a: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

export type PaceBandId = 'idle' | 'blue' | 'green' | 'yellow' | 'orange' | 'red';

export function paceBandFromPrognostic(pct: number | null | undefined): PaceBandId {
  if (pct == null || !Number.isFinite(pct)) return 'idle';
  if (pct < 60) return 'blue';
  if (pct < 70) return 'green';
  if (pct < 80) return 'yellow';
  if (pct < 90) return 'orange';
  return 'red';
}

/** Line/fill colour for a prognostic % band (recorder palette). */
export function speedChartColorForPrognostic(pct: number | null | undefined): string {
  switch (paceBandFromPrognostic(pct)) {
    case 'blue':
      return '#00e5ff';
    case 'green':
      return '#34d399';
    case 'yellow':
      return '#fbbf24';
    case 'orange':
      return '#f97316';
    case 'red':
      return '#ef4444';
    default:
      return '#00e5ff';
  }
}

export function speedChartColorForY(
  y: number,
  bands: Array<{ pct: number; y: number }>,
): string {
  if (!bands.length || !Number.isFinite(y)) return speedChartColorForPrognostic(null);
  const sorted = [...bands].sort((a, b) => a.y - b.y);
  let floorPct = 0;
  for (const b of sorted) {
    if (y >= b.y) floorPct = b.pct;
    else break;
  }
  return speedChartColorForPrognostic(floorPct);
}

/** Build 60/70/80/90% horizontal band y-values (km/h) for a boat class. */
export function prognosticBandsKmh(
  boatClass: string | null,
): Array<{ pct: number; y: number }> {
  if (!boatClass) return [];
  return [60, 70, 80, 90]
    .map((pct) => {
      const mps = speedMpsForPrognostic(pct, boatClass);
      return mps != null && Number.isFinite(mps) ? { pct, y: mps * 3.6 } : null;
    })
    .filter((b): b is { pct: number; y: number } => b != null);
}

function segmentPolylineByBands(
  points: Array<{ x: number; y: number }>,
  bands: Array<{ pct: number; y: number }>,
): Array<{ color: string; points: Array<{ x: number; y: number }> }> {
  if (points.length < 2) return [];
  const thresholds = [...new Set(bands.map((b) => b.y))]
    .filter((y) => Number.isFinite(y) && y > 0)
    .sort((a, b) => a - b);

  const colorAt = (y: number) => speedChartColorForY(y, bands);
  const path: Array<{ x: number; y: number }> = [{ ...points[0] }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (thresholds.length && Number.isFinite(a.y) && Number.isFinite(b.y) && a.y !== b.y) {
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      const crossings: Array<{ x: number; y: number }> = [];
      for (const ty of thresholds) {
        if (ty <= lo || ty >= hi) continue;
        const t = (ty - a.y) / (b.y - a.y);
        if (t > 0 && t < 1) crossings.push({ x: a.x + t * (b.x - a.x), y: ty });
      }
      crossings.sort((p, q) => (a.y < b.y ? p.y - q.y : q.y - p.y));
      for (const c of crossings) path.push(c);
    }
    path.push({ ...b });
  }

  const out: Array<{ color: string; points: Array<{ x: number; y: number }> }> = [];
  let curColor = colorAt(path[0].y);
  let curPts: Array<{ x: number; y: number }> = [path[0]];

  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const next = path[i];
    const rising = next.y >= prev.y;
    const sampleY = thresholds.some((ty) => Math.abs(next.y - ty) < 1e-9)
      ? next.y + (rising ? 1e-6 : -1e-6)
      : next.y;
    const nextColor = colorAt(sampleY);

    if (nextColor !== curColor) {
      curPts.push(next);
      if (curPts.length >= 2) out.push({ color: curColor, points: curPts });
      curColor = nextColor;
      curPts = [next];
    } else {
      curPts.push(next);
    }
  }
  if (curPts.length >= 2) out.push({ color: curColor, points: curPts });
  return out;
}

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

export function drawMultiSeriesChart(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  opts: ChartOptions,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const theme = opts.theme ?? 'light';
  const isRecorder = theme === 'recorder';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 200;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = cssW;
  const h = cssH;
  const bands = (opts.prognosticBands || []).filter((b) => Number.isFinite(b.y) && b.y > 0);
  const compact = h < 180;
  const padL = compact ? 36 : 44;
  const padR = bands.length && isRecorder ? (compact ? 28 : 36) : 12;
  const padT = opts.subtitle ? (compact ? 34 : 44) : compact ? 24 : 36;
  // Leave room for axis ticks + legend so they do not collide
  const padB = compact ? 38 : 36;
  const axisY = h - (compact ? 8 : 10);
  const legendY = h - (compact ? 22 : 24);
  const plotW = w - padL - padR;
  const plotH = Math.max(24, h - padT - padB);

  ctx.clearRect(0, 0, w, h);

  if (isRecorder) {
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(12, 28, 52, 0.98)');
    bg.addColorStop(1, 'rgba(10, 22, 40, 0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.fillStyle = '#e8f4fc';
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(51, 49, 50, 0.12)';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.fillStyle = '#1a1b1d';
  }

  ctx.font = compact ? '600 11px system-ui, sans-serif' : '600 13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(opts.title, padL, compact ? 14 : 20);
  if (opts.subtitle) {
    ctx.font = compact ? '500 9px system-ui, sans-serif' : '500 10px system-ui, sans-serif';
    ctx.fillStyle = isRecorder ? '#94a3b8' : '#3f4349';
    ctx.fillText(opts.subtitle, padL, compact ? 26 : 34);
    ctx.fillStyle = isRecorder ? '#e8f4fc' : '#1a1b1d';
  }

  const plotted = series.filter((s) => s.points.length >= 2);
  const allPts = plotted.flatMap((s) => s.points);
  if (allPts.length < 2) {
    ctx.fillStyle = isRecorder ? '#94a3b8' : '#3f4349';
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
  for (const b of bands) {
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y);
  }
  if (maxX - minX < 1e-6) maxX = minX + 1;
  if (maxY - minY < 1e-6) {
    minY = Math.max(0, minY - 1);
    maxY = maxY + 1;
  }
  minY = Math.max(0, minY - (maxY - minY) * (isRecorder ? 0.1 : 0.08));
  maxY += (maxY - minY) * (isRecorder ? 0.12 : 0.08);

  const sx = (x: number) => padL + ((x - minX) / (maxX - minX)) * plotW;
  const sy = (y: number) => padT + plotH - ((y - minY) / (maxY - minY)) * plotH;

  ctx.strokeStyle = isRecorder ? 'rgba(148, 163, 184, 0.14)' : 'rgba(51, 49, 50, 0.1)';
  ctx.lineWidth = 1;
  const tickFill = isRecorder ? '#94a3b8' : '#3f4349';
  for (const ty of niceTicks(minY, maxY, 4)) {
    const py = sy(ty);
    ctx.beginPath();
    ctx.moveTo(padL, py);
    ctx.lineTo(padL + plotW, py);
    ctx.stroke();
    ctx.fillStyle = tickFill;
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
    ctx.fillStyle = tickFill;
    ctx.textAlign = 'center';
    ctx.fillText(String(Math.round(tx * 10) / 10), px, axisY);
  }

  if (isRecorder && bands.length) {
    for (const band of bands) {
      const py = sy(band.y);
      if (py < padT || py > padT + plotH) continue;
      const bandColor = speedChartColorForPrognostic(band.pct);
      const bandRgb = parseHexColor(bandColor);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = rgba(bandRgb, 0.55);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = rgba(bandRgb, 0.9);
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${band.pct}%`, padL + plotW + 4, py + 3);
    }
  }

  const useBandColors = Boolean(opts.colorByPrognostic && bands.length);

  for (const s of plotted) {
    if (s.points.length < 2) continue;
    const end = s.points[s.points.length - 1];
    const endColor = useBandColors ? speedChartColorForY(end.y, bands) : s.color;
    const rgb = parseHexColor(endColor);

    if (isRecorder) {
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const px = sx(p.x);
        const py = sy(p.y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.lineTo(sx(s.points[s.points.length - 1].x), padT + plotH);
      ctx.lineTo(sx(s.points[0].x), padT + plotH);
      ctx.closePath();
      const area = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      area.addColorStop(0, rgba(rgb, 0.28));
      area.addColorStop(1, rgba(rgb, 0.02));
      ctx.fillStyle = area;
      ctx.fill();
    }

    ctx.lineWidth = isRecorder ? 2.5 : 2.25;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (useBandColors) {
      const segs = segmentPolylineByBands(s.points, bands);
      for (const seg of segs) {
        if (seg.points.length < 2) continue;
        const segRgb = parseHexColor(seg.color);
        ctx.beginPath();
        seg.points.forEach((p, i) => {
          const px = sx(p.x);
          const py = sy(p.y);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.strokeStyle = seg.color;
        if (isRecorder) {
          ctx.shadowColor = rgba(segRgb, 0.45);
          ctx.shadowBlur = 8;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    } else {
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const px = sx(p.x);
        const py = sy(p.y);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = s.color;
      if (isRecorder) {
        ctx.shadowColor = rgba(rgb, 0.45);
        ctx.shadowBlur = 8;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (!isRecorder) {
        ctx.lineTo(sx(s.points[s.points.length - 1].x), padT + plotH);
        ctx.lineTo(sx(s.points[0].x), padT + plotH);
        ctx.closePath();
        ctx.fillStyle = s.color + '22';
        ctx.fill();
      }
    }

    if (isRecorder) {
      ctx.beginPath();
      ctx.arc(sx(end.x), sy(end.y), 4, 0, Math.PI * 2);
      ctx.fillStyle = endColor;
      ctx.fill();
      ctx.strokeStyle = '#0a1628';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // Legend sits above x-axis ticks to avoid label collisions in short panes
  let lx = padL;
  ctx.font = compact ? '10px system-ui' : '11px system-ui';
  ctx.textAlign = 'left';
  for (const s of plotted) {
    if (!s.points.length) continue;
    const swatch = useBandColors
      ? speedChartColorForY(s.points[s.points.length - 1].y, bands)
      : s.color;
    ctx.fillStyle = swatch;
    ctx.fillRect(lx, legendY - 8, 9, 9);
    ctx.fillStyle = isRecorder ? '#e8f4fc' : '#1a1b1d';
    ctx.fillText(s.label, lx + 12, legendY);
    lx += ctx.measureText(s.label).width + 24;
  }

  ctx.fillStyle = tickFill;
  ctx.textAlign = 'right';
  ctx.fillText(opts.xLabel, w - padR, axisY);
}
