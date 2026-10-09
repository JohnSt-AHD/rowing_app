import type { HistorySelection } from './history-track';

export type TimelineBounds = {
  tMin: number;
  tMax: number;
  totalDistM: number;
};

type TimelineCallbacks = {
  onChange: (sel: HistorySelection) => void;
};

/** Dual-handle time crop + optional draggable distance window. */
export class HistoryTimeline {
  private root: HTMLElement;
  private trackEl: HTMLElement;
  private rangeEl: HTMLElement;
  private handleStart: HTMLElement;
  private handleEnd: HTMLElement;
  private distTrackEl: HTMLElement;
  private distRangeEl: HTMLElement;
  private distHandle: HTMLElement;
  private cb: TimelineCallbacks;
  private bounds: TimelineBounds = { tMin: 0, tMax: 1, totalDistM: 0 };
  private sel: HistorySelection = {
    t0: 0,
    t1: 1,
    distanceMode: false,
    distStartM: 0,
    distWindowM: 500,
  };
  private drag: null | 'start' | 'end' | 'dist' = null;

  constructor(container: HTMLElement, cb: TimelineCallbacks) {
    this.cb = cb;
    container.innerHTML = `
      <div class="history-timeline">
        <div class="history-timeline__header">
          <span class="history-timeline__title">Selection</span>
          <span class="history-timeline__times" data-time-label>—</span>
        </div>
        <div class="history-timeline__track" data-time-track>
          <div class="history-timeline__shade history-timeline__shade--left"></div>
          <div class="history-timeline__range" data-time-range></div>
          <div class="history-timeline__shade history-timeline__shade--right"></div>
          <button type="button" class="history-timeline__handle history-timeline__handle--start" data-handle-start aria-label="Selection start"></button>
          <button type="button" class="history-timeline__handle history-timeline__handle--end" data-handle-end aria-label="Selection end"></button>
        </div>
        <div class="history-timeline__controls">
          <label class="history-timeline__check">
            <input type="checkbox" data-dist-mode /> Distance window
          </label>
          <label class="history-timeline__dist-input">
            Window
            <input type="number" data-dist-m min="50" step="50" value="500" /> m
          </label>
        </div>
        <div class="history-timeline__dist-row" data-dist-row hidden>
          <span class="history-timeline__dist-label" data-dist-label>0 – 500 m</span>
          <div class="history-timeline__track history-timeline__track--dist" data-dist-track>
            <div class="history-timeline__dist-range" data-dist-range></div>
            <button type="button" class="history-timeline__handle history-timeline__handle--dist" data-dist-handle aria-label="Move distance window"></button>
          </div>
        </div>
      </div>`;

    this.root = container.querySelector('.history-timeline') as HTMLElement;
    this.trackEl = container.querySelector('[data-time-track]') as HTMLElement;
    this.rangeEl = container.querySelector('[data-time-range]') as HTMLElement;
    this.handleStart = container.querySelector('[data-handle-start]') as HTMLElement;
    this.handleEnd = container.querySelector('[data-handle-end]') as HTMLElement;
    this.distTrackEl = container.querySelector('[data-dist-track]') as HTMLElement;
    this.distRangeEl = container.querySelector('[data-dist-range]') as HTMLElement;
    this.distHandle = container.querySelector('[data-dist-handle]') as HTMLElement;

    this.bindDrag(this.handleStart, 'start');
    this.bindDrag(this.handleEnd, 'end');
    this.bindDrag(this.distHandle, 'dist');

    container.querySelector('[data-dist-mode]')?.addEventListener('change', (e) => {
      this.sel.distanceMode = (e.target as HTMLInputElement).checked;
      const row = container.querySelector('[data-dist-row]') as HTMLElement;
      row.hidden = !this.sel.distanceMode;
      this.paint();
      this.cb.onChange({ ...this.sel });
    });

    container.querySelector('[data-dist-m]')?.addEventListener('change', (e) => {
      const v = Number((e.target as HTMLInputElement).value);
      this.sel.distWindowM = Number.isFinite(v) ? Math.max(50, v) : 500;
      this.clampDist();
      this.paint();
      this.cb.onChange({ ...this.sel });
    });
  }

  setSelection(sel: HistorySelection, bounds: TimelineBounds): void {
    this.bounds = bounds;
    this.sel = { ...sel };
    const mode = this.root.querySelector('[data-dist-mode]') as HTMLInputElement;
    const distM = this.root.querySelector('[data-dist-m]') as HTMLInputElement;
    const row = this.root.querySelector('[data-dist-row]') as HTMLElement;
    if (mode) mode.checked = sel.distanceMode;
    if (distM) distM.value = String(Math.round(sel.distWindowM));
    if (row) row.hidden = !sel.distanceMode;
    this.clampDist();
    this.paint();
  }

  getSelection(): HistorySelection {
    return { ...this.sel };
  }

  private bindDrag(el: HTMLElement, kind: 'start' | 'end' | 'dist'): void {
    const onMove = (clientX: number) => {
      const track = kind === 'dist' ? this.distTrackEl : this.trackEl;
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (kind === 'start') {
        const t = this.fracToT(frac);
        this.sel.t0 = Math.min(t, this.sel.t1 - 1000);
      } else if (kind === 'end') {
        const t = this.fracToT(frac);
        this.sel.t1 = Math.max(t, this.sel.t0 + 1000);
      } else {
        const maxStart = Math.max(0, this.bounds.totalDistM - this.sel.distWindowM);
        this.sel.distStartM = frac * maxStart;
      }
      this.paint();
      this.cb.onChange({ ...this.sel });
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.drag = kind;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.drag !== kind) return;
      onMove(e.clientX);
    });
    el.addEventListener('pointerup', () => {
      this.drag = null;
    });
  }

  private fracToT(frac: number): number {
    const { tMin, tMax } = this.bounds;
    return tMin + frac * (tMax - tMin);
  }

  private tToFrac(t: number): number {
    const { tMin, tMax } = this.bounds;
    if (tMax <= tMin) return 0;
    return (t - tMin) / (tMax - tMin);
  }

  private clampDist(): void {
    const maxStart = Math.max(0, this.bounds.totalDistM - this.sel.distWindowM);
    this.sel.distStartM = Math.max(0, Math.min(this.sel.distStartM, maxStart));
  }

  private paint(): void {
    const f0 = this.tToFrac(this.sel.t0);
    const f1 = this.tToFrac(this.sel.t1);
    this.rangeEl.style.left = `${f0 * 100}%`;
    this.rangeEl.style.width = `${(f1 - f0) * 100}%`;
    this.handleStart.style.left = `${f0 * 100}%`;
    this.handleEnd.style.left = `${f1 * 100}%`;

    const shades = this.trackEl.querySelectorAll('.history-timeline__shade');
    const left = shades[0] as HTMLElement;
    const right = shades[1] as HTMLElement;
    if (left) left.style.width = `${f0 * 100}%`;
    if (right) {
      right.style.left = `${f1 * 100}%`;
      right.style.width = `${(1 - f1) * 100}%`;
    }

    const label = this.root.querySelector('[data-time-label]');
    if (label) {
      const dur = (this.sel.t1 - this.sel.t0) / 1000;
      label.textContent = `${formatClock(this.sel.t0)} – ${formatClock(this.sel.t1)} (${Math.round(dur)}s)`;
    }

    if (this.sel.distanceMode && this.bounds.totalDistM > 0) {
      const maxStart = Math.max(0, this.bounds.totalDistM - this.sel.distWindowM);
      const df = maxStart > 0 ? this.sel.distStartM / maxStart : 0;
      const dw = this.sel.distWindowM / this.bounds.totalDistM;
      this.distRangeEl.style.left = `${(this.sel.distStartM / this.bounds.totalDistM) * 100}%`;
      this.distRangeEl.style.width = `${Math.min(100, dw * 100)}%`;
      this.distHandle.style.left = `${df * 100}%`;
      const dl = this.root.querySelector('[data-dist-label]');
      if (dl) {
        const end = this.sel.distStartM + this.sel.distWindowM;
        dl.textContent = `${Math.round(this.sel.distStartM)} – ${Math.round(end)} m`;
      }
    }
  }
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
