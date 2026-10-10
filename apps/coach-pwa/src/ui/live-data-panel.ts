import L from 'leaflet';
import {
  fetchTimingLines,
  listSessions,
  loadDeviceHistoryRange,
  loadSessionDashboard,
  type HistoryPoint,
  type MapPosition,
  type TimingLine,
} from '../lib/api';
import { drawMultiSeriesChart, prognosticBandsKmh } from '../lib/history-charts';
import {
  buildDeviceTrack,
  colorForDevice,
  computeDeviceStats,
  defaultSelection,
  filterTracks,
  formatDuration,
  formatPrognosticPct,
  formatSpeedKmh,
  formatSplitSec,
  hrVsTimeSeries,
  resolveTrackBoatClass,
  speedVsDistanceSeries,
  speedVsTimeSeries,
  strokeRateSeries,
  type DeviceTrack,
  type HistorySelection,
} from '../lib/history-track';
import type { ParsedCourse } from '../lib/course-types';
import {
  formatClock,
  formatElapsed,
  formatSpeedDisplay,
} from '../lib/course-format';
import {
  avgSpeedInSegment,
  computeCourseStats,
  courseSegments,
  formatPaceCell,
  formatPrognosticForDevice,
} from '../lib/course-stats';
import {
  courseBounds,
  courseGroupsFromLines,
  crossingTimeForLine,
  effectiveAlong,
  markerLabelM,
  parseCourse,
} from '../lib/course-geo';
import { colorForDevice as courseColorForDevice, CourseRaceEngine } from '../lib/course-race-engine';
import { resolveSpeedMps } from '../lib/map-smooth';
import type { CoachSettings } from '../lib/settings';
import { liveDeviceColor, registerLiveDevice } from '../lib/live-speed-buffer';

const LS_COURSE = 'coach_race_course';
const LS_REVERSE = 'coach_race_reverse';
const LS_ROLLING = 'coach_race_rolling';
const LS_LIVE_DEVICE = 'coach_live_device';
const HISTORY_POLL_MS = 8000;
const MAX_LIVE_POINTS = 12000;

type StatusFn = (msg: string, err?: boolean) => void;

const PANES = [
  { id: 'metrics', label: 'Metrics' },
  { id: 'map', label: 'Map' },
  { id: 'speed-time', label: 'Speed / time' },
  { id: 'speed-dist', label: 'Speed / dist' },
  { id: 'spm', label: 'Stroke rate' },
  { id: 'hr', label: 'HR' },
] as const;

type PaneId = (typeof PANES)[number]['id'];

function esc(s: unknown) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function positionToHistoryPoint(p: MapPosition, nowMs: number): HistoryPoint | null {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return null;
  const speed = resolveSpeedMps(p);
  const stroke =
    p.displayStrokeRate ??
    (p.strokeRateValid !== false ? p.strokeRate : null) ??
    null;
  return {
    t: p.fixMs ?? nowMs,
    lat: p.latitude,
    lon: p.longitude,
    speed: speed ?? undefined,
    strokeRate: stroke != null && stroke > 0 ? stroke : undefined,
    capsize: Boolean(p.capsize),
  };
}

/** Merge history/API points with newer live map samples (by time). */
function mergePoints(base: HistoryPoint[], live: HistoryPoint[]): HistoryPoint[] {
  if (!base.length) return live.slice();
  if (!live.length) return base.slice();
  const byT = new Map<number, HistoryPoint>();
  for (const p of base) byT.set(p.t, { ...p });
  for (const p of live) {
    const prev = byT.get(p.t);
    if (!prev) {
      byT.set(p.t, { ...p });
      continue;
    }
    byT.set(p.t, {
      ...prev,
      ...p,
      hr: p.hr ?? prev.hr,
      strokeRate: p.strokeRate ?? prev.strokeRate,
      speed: p.speed ?? prev.speed,
    });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

const PANEL_HTML = `
  <div class="live-data-panel history-review" data-live-review>
    <div class="history-select-bar" data-select-bar>
      <div class="history-select-bar__row">
        <label class="history-select-bar__field history-select-bar__field--device">
          <span>Device</span>
          <select data-live-device aria-label="Live device">
            <option value="">Waiting for devices…</option>
          </select>
        </label>
        <button type="button" class="coach-btn coach-btn--ghost history-select-bar__more" data-course-toggle aria-expanded="false" title="Course options">Course</button>
      </div>
      <div class="live-course-extra" data-course-extra hidden>
        <div class="race-toolbar race-toolbar--live">
          <label class="race-field">
            <span class="race-field__label">Course</span>
            <select class="race-select" data-race-course aria-label="Timing course"></select>
          </label>
          <div class="race-toolbar__row">
            <label class="race-check"><input type="checkbox" data-race-reverse /> Reverse</label>
            <label class="race-check"><input type="checkbox" data-race-rolling checked /> Rolling start</label>
            <button type="button" class="coach-btn coach-btn--ghost" data-race-reset>Reset</button>
          </div>
        </div>
        <p class="race-meta" data-race-meta>Load timing lines using your ingest token.</p>
        <p class="poll-line" data-race-status hidden></p>
        <div class="race-splits" data-race-splits></div>
      </div>
      <p class="history-select-bar__status" data-live-status aria-live="polite"></p>
    </div>

    <div class="history-review__body" data-review-body>
      <p class="poll-line history-main__hint" data-track-hint>Select a device to follow live metrics, map, and charts.</p>
      <div class="history-swipe" data-swipe hidden>
        <div class="history-swipe__track" data-swipe-track>
          <section class="history-pane" data-pane="metrics" aria-label="Metrics">
            <div class="history-stats" data-history-stats></div>
          </section>
          <section class="history-pane" data-pane="map" aria-label="Map">
            <div class="history-map-wrap">
              <div class="history-map" data-live-map></div>
            </div>
          </section>
          <section class="history-pane" data-pane="speed-time" aria-label="Speed versus time">
            <canvas class="history-chart history-chart--fill" data-chart-speed-time></canvas>
          </section>
          <section class="history-pane" data-pane="speed-dist" aria-label="Speed versus distance">
            <canvas class="history-chart history-chart--fill" data-chart-speed-dist></canvas>
          </section>
          <section class="history-pane" data-pane="spm" aria-label="Stroke rate versus time">
            <canvas class="history-chart history-chart--fill" data-chart-spm></canvas>
          </section>
          <section class="history-pane" data-pane="hr" aria-label="Heart rate versus time">
            <canvas class="history-chart history-chart--fill" data-chart-hr></canvas>
          </section>
        </div>
      </div>
      <div class="history-swipe__footer" data-swipe-footer hidden>
        <div class="history-swipe__nav">
          <button type="button" class="history-swipe__nav-btn" data-pane-prev aria-label="Previous view">←</button>
          <div class="history-swipe__dots" data-swipe-dots role="tablist" aria-label="Live displays">
            ${PANES.map(
              (p, i) =>
                `<button type="button" class="history-swipe__dot${i === 0 ? ' is-active' : ''}" data-dot="${p.id}" role="tab" aria-selected="${i === 0 ? 'true' : 'false'}" aria-label="${p.label}"></button>`,
            ).join('')}
          </div>
          <button type="button" class="history-swipe__nav-btn" data-pane-next aria-label="Next view">→</button>
        </div>
        <p class="history-swipe__label" data-pane-label>Metrics</p>
      </div>
    </div>
  </div>`;

export class LiveDataPanel {
  private root: HTMLElement | null = null;
  private engine = new CourseRaceEngine();
  private map: L.Map | null = null;
  private trackLayer: L.LayerGroup | null = null;
  private lineLayer: L.LayerGroup | null = null;
  private deviceLayer: L.LayerGroup | null = null;
  private trackLine: L.Polyline | null = null;
  private deviceMarkers = new Map<string, L.Marker>();
  private orgSlug = '';
  private linesLoaded = false;
  private lastPositions: MapPosition[] = [];
  private selectedDeviceId = '';
  private livePoints = new Map<string, HistoryPoint[]>();
  private historyPoints: HistoryPoint[] = [];
  private historyMeta: { boatClass: string | null; athleteId: string | null } = {
    boatClass: null,
    athleteId: null,
  };
  private openSessionId = '';
  private sessionFromIso = '';
  private track: DeviceTrack | null = null;
  private selection: HistorySelection | null = null;
  private swipeEl: HTMLElement | null = null;
  private activePane: PaneId = 'metrics';
  private chartResizeObserver: ResizeObserver | null = null;
  private refreshScheduled = false;
  private historyPollTimer: ReturnType<typeof setInterval> | null = null;
  private historyInFlight = false;
  private visible = false;

  constructor(
    private getSettings: () => CoachSettings,
    private setStatus: StatusFn,
  ) {}

  prepareForRender(nextTab: string) {
    if (nextTab !== 'live') {
      this.visible = false;
      this.stopHistoryPoll();
      this.teardownMap();
      this.teardownChartObserver();
      this.swipeEl = null;
      this.root = null;
    }
  }

  mount(container: HTMLElement) {
    this.root = container;
    const needsDomSetup = !container.querySelector('[data-live-review]');
    if (needsDomSetup) {
      container.innerHTML = PANEL_HTML;
      this.loadPrefs();
      this.bind();
      void this.reloadLines();
    }
    this.swipeEl = this.q<HTMLElement>('[data-swipe]');
    this.bindChartResizeObserver();
    this.syncDeviceSelect(this.lastPositions);
    this.syncSwipeUi();
    this.updateTrackHint();
  }

  onTabShown() {
    this.visible = true;
    this.ensureMap();
    this.refreshCourseView();
    this.rebuildTrackAndViews();
    this.startHistoryPoll();
    void this.refreshHistoryFromApi();
    setTimeout(() => this.map?.invalidateSize(), 150);
  }

  processPositions(positions: MapPosition[], nowMs = Date.now()) {
    this.lastPositions = positions;
    this.syncDeviceSelect(positions);

    for (const p of positions) {
      const pt = positionToHistoryPoint(p, nowMs);
      if (!pt || !p.deviceId) continue;
      const arr = this.livePoints.get(p.deviceId) ?? [];
      const prev = arr[arr.length - 1];
      if (prev && Math.abs(pt.t - prev.t) < 80) {
        arr[arr.length - 1] = { ...prev, ...pt, hr: prev.hr ?? pt.hr };
      } else {
        arr.push(pt);
      }
      if (arr.length > MAX_LIVE_POINTS) arr.splice(0, arr.length - MAX_LIVE_POINTS);
      this.livePoints.set(p.deviceId, arr);
    }

    if (this.linesLoaded && this.engine.selectedCourse) {
      this.engine.processPoll(
        positions.map((p) => ({
          deviceId: p.deviceId,
          latitude: p.latitude,
          longitude: p.longitude,
          speed: p.speed,
          strokeRate: p.strokeRate,
          strokeRateValid: p.strokeRateValid,
          displayStrokeRate: p.displayStrokeRate,
          athleteId: p.athleteId,
          lastSeenAgoSec: p.lastSeenAgoSec,
          telemetryStale: p.telemetryStale,
          online: p.online,
        })),
        nowMs,
      );
    }

    if (this.visible) {
      this.refreshCourseView();
      this.rebuildTrackAndViews();
    }
  }

  async reloadLines() {
    const settings = this.getSettings();
    if (!settings.ingestToken) {
      this.setRaceMeta('Set ingest token in Settings to load timing lines.');
      this.populateCourseSelect([]);
      return;
    }
    try {
      const data = await fetchTimingLines(settings);
      this.orgSlug = data.org ?? '';
      const lines = (data.lines ?? []) as TimingLine[];
      this.engine.setLines(lines);
      this.linesLoaded = true;
      const groups = courseGroupsFromLines(lines);
      this.pickDefaultCourse(groups);
      this.populateCourseSelect(groups);
      const persisted = data.persisted ? '' : ' (memory only — lines may be empty without Postgres)';
      this.setRaceMeta(
        groups.length
          ? `Org ${this.orgSlug || '—'} · ${groups.length} course(s) · ${lines.length} line(s)${persisted}`
          : `Org ${this.orgSlug || '—'} · no timing lines yet${persisted}`,
      );
      this.refreshCourseView();
    } catch (e) {
      this.linesLoaded = false;
      this.setRaceMeta(e instanceof Error ? e.message : 'Failed to load timing lines', true);
    }
  }

  private q<T extends Element>(sel: string): T | null {
    return (this.root?.querySelector(sel) ?? null) as T | null;
  }

  private bind() {
    if (!this.root) return;

    this.root.querySelector('[data-live-device]')?.addEventListener('change', (ev) => {
      const id = (ev.target as HTMLSelectElement).value;
      this.selectDevice(id);
    });

    this.root.querySelector('[data-course-toggle]')?.addEventListener('click', () => {
      const extra = this.q<HTMLElement>('[data-course-extra]');
      const btn = this.q<HTMLButtonElement>('[data-course-toggle]');
      if (!extra || !btn) return;
      const open = extra.hasAttribute('hidden');
      extra.toggleAttribute('hidden', !open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('coach-btn--active', open);
    });

    this.root.querySelector('[data-race-course]')?.addEventListener('change', (ev) => {
      const v = (ev.target as HTMLSelectElement).value;
      this.engine.setCourseGroup(v);
      localStorage.setItem(LS_COURSE, v);
      this.engine.resetSession();
      this.refreshCourseView();
      this.renderMap();
    });
    this.root.querySelector('[data-race-reverse]')?.addEventListener('change', (ev) => {
      this.engine.courseReversed = (ev.target as HTMLInputElement).checked;
      localStorage.setItem(LS_REVERSE, this.engine.courseReversed ? '1' : '0');
      this.engine.resetSession();
      this.refreshCourseView();
      this.renderMap();
    });
    this.root.querySelector('[data-race-rolling]')?.addEventListener('change', (ev) => {
      this.engine.rollingStartEnabled = (ev.target as HTMLInputElement).checked;
      localStorage.setItem(LS_ROLLING, this.engine.rollingStartEnabled ? '1' : '0');
    });
    this.root.querySelector('[data-race-reset]')?.addEventListener('click', () => {
      this.engine.resetSession();
      this.refreshCourseView();
      this.setRaceStatus('Race timing reset.');
    });
    this.root.querySelector('[data-race-splits]')?.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest('[data-hide-device]') as HTMLElement | null;
      if (!btn) return;
      const id = btn.getAttribute('data-hide-device');
      if (!id) return;
      this.engine.hideDevice(id);
      this.refreshCourseView();
    });

    this.swipeEl = this.q<HTMLElement>('[data-swipe]');
    this.swipeEl?.addEventListener('scroll', () => this.onSwipeScroll(), { passive: true });

    this.root.querySelectorAll<HTMLButtonElement>('[data-dot]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.scrollToPane(btn.dataset.dot as PaneId);
      });
    });
    this.root.querySelector('[data-pane-prev]')?.addEventListener('click', () => this.stepPane(-1));
    this.root.querySelector('[data-pane-next]')?.addEventListener('click', () => this.stepPane(1));

    this.root.tabIndex = 0;
    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      this.stepPane(e.key === 'ArrowRight' ? 1 : -1);
    });
  }

  private loadPrefs() {
    try {
      this.engine.courseReversed = localStorage.getItem(LS_REVERSE) === '1';
      this.engine.rollingStartEnabled = localStorage.getItem(LS_ROLLING) !== '0';
      this.engine.selectedCourse = localStorage.getItem(LS_COURSE) || '';
      this.selectedDeviceId = localStorage.getItem(LS_LIVE_DEVICE) || '';
    } catch {
      /* ignore */
    }
    const rev = this.root?.querySelector('[data-race-reverse]') as HTMLInputElement | null;
    const roll = this.root?.querySelector('[data-race-rolling]') as HTMLInputElement | null;
    if (rev) rev.checked = this.engine.courseReversed;
    if (roll) roll.checked = this.engine.rollingStartEnabled;
  }

  private selectDevice(id: string) {
    const changed = id !== this.selectedDeviceId;
    this.selectedDeviceId = id;
    try {
      if (id) localStorage.setItem(LS_LIVE_DEVICE, id);
    } catch {
      /* ignore */
    }
    if (!changed) {
      this.rebuildTrackAndViews();
      return;
    }
    this.historyPoints = [];
    this.openSessionId = '';
    this.sessionFromIso = '';
    this.historyMeta = { boatClass: null, athleteId: null };
    this.setLiveStatus(id ? `Following ${id}…` : '');
    void this.refreshHistoryFromApi();
    this.rebuildTrackAndViews();
  }

  private syncDeviceSelect(positions: MapPosition[]) {
    const sel = this.q<HTMLSelectElement>('[data-live-device]');
    if (!sel) return;
    const ids = [
      ...new Set(
        positions
          .map((p) => p.deviceId)
          .filter(Boolean)
          .concat(this.selectedDeviceId ? [this.selectedDeviceId] : []),
      ),
    ].sort();
    const prev = sel.value || this.selectedDeviceId;
    if (!ids.length) {
      sel.innerHTML = '<option value="">Waiting for devices…</option>';
      return;
    }
    sel.innerHTML = ids
      .map((id) => {
        const pos = positions.find((p) => p.deviceId === id);
        const label = String(pos?.athleteId ?? id).trim() || id;
        const show = label !== id ? `${label} (${id})` : id;
        return `<option value="${esc(id)}"${id === prev ? ' selected' : ''}>${esc(show)}</option>`;
      })
      .join('');
    if (!this.selectedDeviceId || !ids.includes(this.selectedDeviceId)) {
      this.selectDevice(ids.includes(prev) ? prev : ids[0]);
    } else if (sel.value !== this.selectedDeviceId) {
      sel.value = this.selectedDeviceId;
    }
  }

  private startHistoryPoll() {
    this.stopHistoryPoll();
    this.historyPollTimer = setInterval(() => void this.refreshHistoryFromApi(), HISTORY_POLL_MS);
  }

  private stopHistoryPoll() {
    if (this.historyPollTimer) clearInterval(this.historyPollTimer);
    this.historyPollTimer = null;
  }

  private async refreshHistoryFromApi() {
    if (!this.visible || !this.selectedDeviceId || this.historyInFlight) return;
    const settings = this.getSettings();
    if (!settings.apiBaseUrl || !settings.ingestToken) return;

    this.historyInFlight = true;
    try {
      if (!this.openSessionId) {
        try {
          const sessions = await listSessions(settings, this.selectedDeviceId);
          const open = sessions.find((s) => !s.ended_at) ?? sessions[0];
          if (open?.session_id) {
            this.openSessionId = open.session_id;
            this.sessionFromIso = open.started_at;
            this.historyMeta = {
              boatClass: open.boat_class ?? open.boatClass ?? null,
              athleteId: open.athlete_id ?? open.athleteId ?? null,
            };
          }
        } catch {
          /* history list optional when no Postgres */
        }
      }

      let payload = null;
      if (this.openSessionId) {
        try {
          payload = await loadSessionDashboard(settings, this.openSessionId);
        } catch {
          payload = null;
        }
      }

      if (!payload) {
        const to = new Date().toISOString();
        const from =
          this.sessionFromIso ||
          new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        try {
          payload = await loadDeviceHistoryRange(
            settings,
            this.selectedDeviceId,
            from,
            to,
          );
        } catch {
          payload = null;
        }
      }

      if (payload?.track?.length) {
        this.historyPoints = payload.track;
        this.historyMeta = {
          boatClass: payload.boatClass ?? this.historyMeta.boatClass,
          athleteId: payload.athleteId ?? this.historyMeta.athleteId,
        };
        if (payload.from) this.sessionFromIso = payload.from;
        this.setLiveStatus(
          `Live · ${this.selectedDeviceId} · ${payload.track.length} history pts`,
        );
        this.rebuildTrackAndViews();
      } else {
        const liveN = this.livePoints.get(this.selectedDeviceId)?.length ?? 0;
        this.setLiveStatus(
          liveN
            ? `Live · ${this.selectedDeviceId} · streaming map GPS (${liveN} pts)`
            : `Live · ${this.selectedDeviceId} · waiting for GPS…`,
        );
      }
    } finally {
      this.historyInFlight = false;
    }
  }

  private rebuildTrackAndViews() {
    if (!this.selectedDeviceId) {
      this.track = null;
      this.selection = null;
      this.updateTrackHint();
      return;
    }
    const live = this.livePoints.get(this.selectedDeviceId) ?? [];
    const merged = mergePoints(this.historyPoints, live);
    if (!merged.length) {
      this.track = null;
      this.selection = null;
      this.updateTrackHint();
      return;
    }
    const idx = registerLiveDevice(this.selectedDeviceId);
    this.track = buildDeviceTrack(
      this.selectedDeviceId,
      liveDeviceColor(this.selectedDeviceId) || colorForDevice(idx),
      merged,
      {
        boatClass: this.historyMeta.boatClass,
        athleteId: this.historyMeta.athleteId,
      },
    );
    this.selection = defaultSelection([this.track]);
    this.updateTrackHint();
    this.scheduleRefreshViews();
  }

  private updateTrackHint() {
    const hint = this.q<HTMLElement>('[data-track-hint]');
    const has = Boolean(this.track?.points.length);
    if (hint) hint.hidden = has;
    this.q('[data-swipe]')?.toggleAttribute('hidden', !has);
    this.q('[data-swipe-footer]')?.toggleAttribute('hidden', !has);
  }

  private setLiveStatus(msg: string) {
    const el = this.q<HTMLElement>('[data-live-status]');
    if (el) el.textContent = msg;
  }

  private scheduleRefreshViews() {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.refreshScheduled = false;
        this.refreshViews();
      });
    });
  }

  private refreshViews() {
    if (!this.selection || !this.track) return;
    this.renderStats();
    this.renderMap();
    this.renderCharts();
  }

  private renderStats() {
    const host = this.q<HTMLElement>('[data-history-stats]');
    if (!host || !this.selection || !this.track) return;
    const stats = computeDeviceStats([this.track], this.selection);
    if (!stats.length) {
      host.innerHTML = '';
      return;
    }
    const s = stats[0];
    const pos = this.lastPositions.find((p) => p.deviceId === this.selectedDeviceId);
    const liveSpeed = pos ? resolveSpeedMps(pos) : null;
    const liveSpm = pos?.displayStrokeRate ?? pos?.strokeRate ?? null;

    host.innerHTML = `
      <div class="history-stats__bar">
        <h2 class="history-stats__title">Live stats</h2>
        <span class="history-stats__range">outing so far · ${esc(formatDuration(s.durationSec))}</span>
      </div>
      <div class="history-stats__grid">
        <article class="history-stats__card" style="--device-color: ${esc(s.color)}; border-left-color: ${esc(s.color)}">
          <h3 class="history-stats__device">${esc(s.deviceId)}${s.boatClass ? ` <span class="history-hint">${esc(s.boatClass)}</span>` : ''}</h3>
          <dl class="history-stats__dl">
            <div><dt>Live speed</dt><dd>${liveSpeed != null ? esc(formatSpeedKmh(liveSpeed)) : '—'}</dd></div>
            <div><dt>Live rate</dt><dd>${liveSpm != null && liveSpm > 0 ? `${Math.round(liveSpm)} spm` : '—'}</dd></div>
            <div><dt>Distance</dt><dd>${esc(Math.round(s.distanceM))} m</dd></div>
            <div><dt>Avg speed</dt><dd>${esc(formatSpeedKmh(s.avgSpeedMps))}</dd></div>
            <div><dt>Avg split</dt><dd>${esc(formatSplitSec(s.avgSplitSec))}</dd></div>
            <div><dt>Best split</dt><dd>${esc(formatSplitSec(s.bestSplitSec))}</dd></div>
            <div><dt>Max speed</dt><dd>${esc(formatSpeedKmh(s.maxSpeedMps))}</dd></div>
            <div><dt>Avg prognostic</dt><dd>${esc(formatPrognosticPct(s.avgPrognosticPct))}</dd></div>
            <div><dt>Avg stroke</dt><dd>${s.avgStrokeRate != null ? `${s.avgStrokeRate.toFixed(1)} spm` : '—'}</dd></div>
            <div><dt>Avg HR</dt><dd>${s.avgHrBpm != null ? `${Math.round(s.avgHrBpm)} bpm` : '—'}</dd></div>
            <div><dt>GPS points</dt><dd>${s.pointCount}</dd></div>
          </dl>
        </article>
      </div>`;
  }

  private renderCharts() {
    if (!this.selection || !this.track) return;
    const sel = this.selection;
    const tracks = [this.track];
    const boatClass = resolveTrackBoatClass(this.track);
    const bands = prognosticBandsKmh(boatClass);
    const bandNote = bands.length
      ? undefined
      : boatClass
        ? `No prognostic bands for ${boatClass}`
        : 'No boat class — prognostic bands unavailable';

    const speedTime = this.q<HTMLCanvasElement>('[data-chart-speed-time]');
    const speedDist = this.q<HTMLCanvasElement>('[data-chart-speed-dist]');
    const spm = this.q<HTMLCanvasElement>('[data-chart-spm]');
    const hr = this.q<HTMLCanvasElement>('[data-chart-hr]');

    if (speedTime) {
      drawMultiSeriesChart(speedTime, speedVsTimeSeries(tracks, sel), {
        title: 'Speed vs time',
        xLabel: 'seconds',
        yLabel: 'km/h',
        yFormat: (v) => `${v.toFixed(0)}`,
        theme: 'recorder',
        prognosticBands: bands,
        colorByPrognostic: bands.length > 0,
        subtitle: bandNote,
      });
    }
    if (speedDist) {
      drawMultiSeriesChart(speedDist, speedVsDistanceSeries(tracks, sel), {
        title: 'Speed vs distance',
        xLabel: 'metres',
        yLabel: 'km/h',
        yFormat: (v) => `${v.toFixed(0)}`,
        theme: 'recorder',
        prognosticBands: bands,
        colorByPrognostic: bands.length > 0,
        subtitle: bandNote,
      });
    }
    if (spm) {
      drawMultiSeriesChart(spm, strokeRateSeries(tracks, sel), {
        title: 'Stroke rate vs time',
        xLabel: 'seconds',
        yLabel: 'spm',
        yFormat: (v) => `${v.toFixed(0)}`,
        theme: 'recorder',
      });
    }
    if (hr) {
      drawMultiSeriesChart(hr, hrVsTimeSeries(tracks, sel), {
        title: 'HR vs time',
        xLabel: 'seconds',
        yLabel: 'bpm',
        yFormat: (v) => `${v.toFixed(0)}`,
        theme: 'recorder',
      });
    }
  }

  private paneIndex(id: PaneId): number {
    return PANES.findIndex((p) => p.id === id);
  }

  private stepPane(delta: number) {
    const idx = this.paneIndex(this.activePane);
    const next = idx + delta;
    if (next < 0 || next >= PANES.length) return;
    this.scrollToPane(PANES[next].id);
  }

  private scrollToPane(id: PaneId) {
    const track = this.q<HTMLElement>('[data-swipe-track]');
    const swipe = this.swipeEl;
    if (!track || !swipe) return;
    const idx = this.paneIndex(id);
    if (idx < 0) return;
    const pane = track.children[idx] as HTMLElement | undefined;
    if (!pane) return;
    swipe.scrollTo({ left: pane.offsetLeft, behavior: 'smooth' });
    this.activePane = id;
    this.syncSwipeUi();
    if (id === 'map') {
      window.setTimeout(() => this.map?.invalidateSize(), 80);
      window.setTimeout(() => this.map?.invalidateSize(), 280);
    }
    if (id === 'speed-time' || id === 'speed-dist' || id === 'spm' || id === 'hr') {
      this.renderCharts();
    }
  }

  private onSwipeScroll() {
    const swipe = this.swipeEl;
    if (!swipe) return;
    const w = swipe.clientWidth || 1;
    const idx = Math.round(swipe.scrollLeft / w);
    const pane = PANES[Math.max(0, Math.min(PANES.length - 1, idx))];
    if (pane && pane.id !== this.activePane) {
      this.activePane = pane.id;
      this.syncSwipeUi();
      if (pane.id === 'map') {
        window.setTimeout(() => this.map?.invalidateSize(), 50);
      }
      if (
        pane.id === 'speed-time' ||
        pane.id === 'speed-dist' ||
        pane.id === 'spm' ||
        pane.id === 'hr'
      ) {
        this.renderCharts();
      }
    }
  }

  private syncSwipeUi() {
    const label = this.q<HTMLElement>('[data-pane-label]');
    const pane = PANES.find((p) => p.id === this.activePane) ?? PANES[0];
    if (label) label.textContent = pane.label;
    this.root?.querySelectorAll<HTMLButtonElement>('[data-dot]').forEach((btn) => {
      const active = btn.dataset.dot === this.activePane;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const idx = this.paneIndex(this.activePane);
    const prevBtn = this.q<HTMLButtonElement>('[data-pane-prev]');
    const nextBtn = this.q<HTMLButtonElement>('[data-pane-next]');
    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx >= PANES.length - 1;
  }

  private bindChartResizeObserver() {
    this.teardownChartObserver();
    const swipe = this.q<HTMLElement>('[data-swipe]');
    if (!swipe || typeof ResizeObserver === 'undefined') return;
    this.chartResizeObserver = new ResizeObserver(() => {
      if (this.track && this.selection) this.renderCharts();
      if (this.map) window.setTimeout(() => this.map?.invalidateSize(), 40);
    });
    this.chartResizeObserver.observe(swipe);
  }

  private teardownChartObserver() {
    this.chartResizeObserver?.disconnect();
    this.chartResizeObserver = null;
  }

  private teardownMap() {
    this.deviceMarkers.clear();
    this.trackLine = null;
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.trackLayer = null;
      this.lineLayer = null;
      this.deviceLayer = null;
    }
  }

  private pickDefaultCourse(groups: string[]) {
    if (!groups.length) {
      this.engine.selectedCourse = '';
      return;
    }
    const saved = localStorage.getItem(LS_COURSE) || '';
    if (saved && groups.includes(saved)) {
      this.engine.selectedCourse = saved;
      return;
    }
    const withStart = groups.find((g) => {
      const c = parseCourse(this.engine.lines, g);
      return c?.start?.lineType === 'start';
    });
    this.engine.selectedCourse = withStart ?? groups[0];
    localStorage.setItem(LS_COURSE, this.engine.selectedCourse);
  }

  private populateCourseSelect(groups: string[]) {
    const sel = this.root?.querySelector('[data-race-course]') as HTMLSelectElement | null;
    if (!sel) return;
    sel.innerHTML = groups.length
      ? groups
          .map(
            (g) =>
              `<option value="${esc(g)}"${g === this.engine.selectedCourse ? ' selected' : ''}>${esc(g)}</option>`,
          )
          .join('')
      : '<option value="">No courses for this token</option>';
  }

  private setRaceMeta(msg: string, err = false) {
    const el = this.root?.querySelector('[data-race-meta]');
    if (el) {
      el.textContent = msg;
      el.classList.toggle('poll-line--warn', err);
    }
  }

  private setRaceStatus(msg: string, err = false) {
    const el = this.root?.querySelector('[data-race-status]') as HTMLElement | null;
    if (!el) return;
    const text = String(msg ?? '').trim();
    const show = Boolean(text) && text !== '—';
    el.textContent = show ? text : '';
    el.classList.toggle('err', err && show);
    el.hidden = !show;
  }

  private syncCourseSelect() {
    const sel = this.root?.querySelector('[data-race-course]') as HTMLSelectElement | null;
    if (!sel || !this.engine.selectedCourse) return;
    if (sel.value !== this.engine.selectedCourse) {
      sel.value = this.engine.selectedCourse;
    }
  }

  private refreshCourseView() {
    this.syncCourseSelect();
    const course = this.engine.getCourse();
    if (!course) {
      this.renderSplits(null);
      this.setRaceStatus('Select a course with start/finish lines (optional).');
      return;
    }
    this.renderSplits(course);
    const n = this.engine.visibleDeviceIdsByProg().length;
    this.setRaceStatus(
      `${course.group} · ${Math.round(course.totalDist)} m · ${n} boat${n === 1 ? '' : 's'} on course` +
        (this.engine.courseReversed ? ' · reverse' : '') +
        (this.engine.rollingStartEnabled ? ' · rolling start' : ''),
    );
  }

  private renderSplits(course: ParsedCourse | null) {
    const el = this.root?.querySelector('[data-race-splits]');
    if (!el) return;
    if (!course) {
      el.innerHTML = '<p class="poll-line">No course selected.</p>';
      return;
    }
    const segments = courseSegments(course, this.engine.courseReversed);
    const deviceIds = this.engine.visibleDeviceIdsByProg(
      this.lastPositions.map((p) => p.deviceId),
    );
    if (!deviceIds.length) {
      el.innerHTML = '<p class="poll-line">Waiting for devices on course…</p>';
      return;
    }
    el.innerHTML = deviceIds
      .map((deviceId) => {
        const crossed = this.engine.getCrossings(deviceId);
        const live = this.engine.getLive(deviceId);
        const trace = this.engine.getTrace(deviceId);
        const stats = computeCourseStats(trace, course, deviceId, live?.athleteId);
        const finished = this.engine.hasFinishedCourse(deviceId, course);
        const pos = this.lastPositions.find((p) => p.deviceId === deviceId);
        const displayName =
          String(live?.athleteId ?? pos?.athleteId ?? deviceId).trim() || deviceId;
        const rolling = this.engine.getRollingStart(deviceId);
        const tStart = this.engine.getEffectiveStartMs(deviceId, course);
        const startLabel = tStart
          ? rolling?.confirmed
            ? `${formatClock(tStart)} ↺`
            : formatClock(tStart)
          : this.engine.usesRollingStartGate(deviceId, live?.athleteId)
            ? '↺ pending'
            : '—';
        const splitsHtml = segments
          .map((seg) => {
            const label = markerLabelM(seg.line, course, this.engine.courseReversed);
            const t = crossingTimeForLine(crossed, seg.line, course);
            if (t == null || tStart == null) {
              return `<div class="race-split-cell"><dt>${esc(label)}</dt><dd>—</dd></div>`;
            }
            const elapsed = formatElapsed(t - tStart);
            const segSpeed = avgSpeedInSegment(trace, seg.from, seg.to);
            const segProg = formatPrognosticForDevice(
              segSpeed,
              deviceId,
              live?.athleteId,
            );
            const val = segProg ? `${elapsed} · ${segProg}` : elapsed;
            return `<div class="race-split-cell"><dt>${esc(label)}</dt><dd>${esc(val)}</dd></div>`;
          })
          .join('');
        let pace: string;
        if (finished) {
          pace =
            stats.avgMps != null
              ? formatPaceCell(stats.avgMps, deviceId, live?.athleteId)
              : '—';
        } else if (live?.stale && live.lastSeenAgoSec != null) {
          pace = `Stale ${live.lastSeenAgoSec}s`;
        } else {
          pace = formatSpeedDisplay(live?.speedMps, deviceId, live?.athleteId);
        }
        let spm = '—';
        if (finished) {
          spm =
            stats.avgSpm != null && stats.avgSpm > 0
              ? `${Math.round(stats.avgSpm)} spm`
              : '—';
        } else if (!live?.stale && live?.strokeRate != null && live.strokeRate > 0) {
          spm = `${Math.round(live.strokeRate)} spm`;
        }
        return `<article class="race-boat-card">
          <header class="race-boat-card__head">
            <span class="race-boat-card__dot" style="background:${courseColorForDevice(deviceId)}"></span>
            <strong class="race-boat-card__name">${esc(displayName)}</strong>
            <button type="button" class="race-boat-card__hide" data-hide-device="${esc(deviceId)}">Hide</button>
          </header>
          <dl class="race-boat-card__stats">
            <div><dt>Start</dt><dd>${esc(startLabel)}</dd></div>
            <div><dt>Pace</dt><dd>${esc(pace)}</dd></div>
            <div><dt>Rate</dt><dd>${esc(spm)}</dd></div>
          </dl>
          <dl class="race-boat-card__splits">${splitsHtml}</dl>
        </article>`;
      })
      .join('');
  }

  private ensureMap() {
    const el = this.q<HTMLElement>('[data-live-map]');
    if (!el || typeof L === 'undefined') return;
    if (!this.map) {
      this.map = L.map(el, { preferCanvas: true, zoomControl: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(this.map);
      this.trackLayer = L.layerGroup().addTo(this.map);
      this.lineLayer = L.layerGroup().addTo(this.map);
      this.deviceLayer = L.layerGroup().addTo(this.map);
    }
  }

  private renderMap() {
    this.ensureMap();
    if (!this.map || !this.trackLayer || !this.lineLayer || !this.deviceLayer) return;

    this.lineLayer.clearLayers();
    const course = this.engine.getCourse();
    if (course) {
      for (const line of course.lines) {
        const style =
          line.lineType === 'start'
            ? { color: '#22c55e', weight: 3 }
            : line.lineType === 'finish'
              ? { color: '#ef4444', weight: 3 }
              : { color: '#3b82f6', weight: 2, dashArray: '8 6' };
        const label =
          line.distanceM != null
            ? `${line.name} (${markerLabelM(line, course, this.engine.courseReversed)})`
            : line.name;
        L.polyline(
          [
            [line.lat1, line.lon1],
            [line.lat2, line.lon2],
          ],
          style,
        )
          .bindTooltip(label, { sticky: true })
          .addTo(this.lineLayer);
      }
    }

    const bounds: L.LatLng[] = [];
    if (this.track && this.selection) {
      const filtered = filterTracks([this.track], this.selection)[0];
      const latlngs = (filtered?.points ?? [])
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => L.latLng(p.lat!, p.lon!));
      latlngs.forEach((ll) => bounds.push(ll));
      if (latlngs.length >= 2) {
        if (this.trackLine) {
          this.trackLine.setLatLngs(latlngs);
          this.trackLine.setStyle({ color: this.track.color, weight: 4, opacity: 0.9 });
        } else {
          this.trackLine = L.polyline(latlngs, {
            color: this.track.color,
            weight: 4,
            opacity: 0.9,
          }).addTo(this.trackLayer);
        }
      }
    }

    this.updateMapDevices(course, bounds);

    if (course) {
      const cb = courseBounds(course);
      cb.forEach((ll) => bounds.push(L.latLng(ll[0], ll[1])));
    }
    if (bounds.length >= 2) {
      this.map.fitBounds(L.latLngBounds(bounds), { padding: [28, 28] });
    } else if (bounds.length === 1) {
      this.map.setView(bounds[0], 16);
    }
    window.setTimeout(() => this.map?.invalidateSize(), 50);
  }

  private updateMapDevices(course: ParsedCourse | null, bounds: L.LatLng[]) {
    if (!this.map || !this.deviceLayer) return;
    const seen = new Set<string>();
    const focusId = this.selectedDeviceId;

    for (const p of this.lastPositions) {
      const id = p.deviceId;
      if (!id || this.engine.hiddenDevices.has(id)) continue;
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;

      if (course) {
        const along = effectiveAlong(
          p.latitude,
          p.longitude,
          course,
          this.engine.courseReversed,
        );
        if (along == null || along < -80 || along > course.totalDist + 120) {
          if (id !== focusId) continue;
        }
      } else if (id !== focusId) {
        continue;
      }

      seen.add(id);
      const color = courseColorForDevice(id);
      const ll = L.latLng(p.latitude, p.longitude);
      bounds.push(ll);
      let marker = this.deviceMarkers.get(id);
      const icon = L.divIcon({
        className: 'race-device-marker',
        html: `<span style="background:${color}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      if (marker) {
        marker.setLatLng(ll);
        marker.setIcon(icon);
      } else {
        marker = L.marker(ll, { icon }).bindTooltip(id, {
          direction: 'top',
          offset: [0, -8],
        });
        this.deviceLayer.addLayer(marker);
        this.deviceMarkers.set(id, marker);
      }
    }
    for (const [id, marker] of this.deviceMarkers) {
      if (!seen.has(id)) {
        this.deviceLayer.removeLayer(marker);
        this.deviceMarkers.delete(id);
      }
    }
  }
}
