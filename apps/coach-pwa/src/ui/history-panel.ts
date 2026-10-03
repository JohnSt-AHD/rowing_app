import L from 'leaflet';
import {
  listHistoryDevices,
  listSessions,
  loadDeviceHistoryRange,
  loadSessionDashboard,
  type CoachSettings,
  type SessionSummary,
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
  maxDistance,
  resolveTrackBoatClass,
  speedVsDistanceSeries,
  speedVsTimeSeries,
  strokeRateSeries,
  type DeviceTrack,
  type HistorySelection,
} from '../lib/history-track';
import { HistoryTimeline } from '../lib/history-timeline';
import { bindInfoToggles } from '../lib/info-toggle';

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

const REVIEW_HTML = `
  <div class="history-review" data-history-review>
    <div class="history-select-bar" data-select-bar>
      <div class="history-select-bar__row">
        <label class="history-select-bar__field history-select-bar__field--device">
          <span>Device</span>
          <select data-device-select aria-label="Device">
            <option value="">Loading…</option>
          </select>
        </label>
        <label class="history-select-bar__field history-select-bar__field--session">
          <span>Session</span>
          <select data-session-select aria-label="Session">
            <option value="">— pick device —</option>
          </select>
        </label>
        <button type="button" class="coach-btn coach-btn--ghost history-select-bar__more" data-toggle-devices aria-expanded="false" title="More devices">+</button>
      </div>
      <div class="history-select-bar__extra" data-device-extra hidden>
        <div class="history-device-list" data-device-list></div>
        <label class="coach-field history-device-add">
          Add device ID
          <input type="text" data-device-add placeholder="e.g. A2" />
        </label>
        <button type="button" class="coach-btn coach-btn--ghost" data-load-devices>Refresh devices</button>
      </div>
      <p class="history-select-bar__status" data-setup-load-status hidden aria-live="polite"></p>
    </div>

    <div class="history-loading" data-history-loading hidden aria-live="polite">
      <div class="history-loading__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100">
        <div class="history-loading__fill"></div>
      </div>
      <p class="history-loading__text" data-loading-text>Loading session data…</p>
    </div>

    <div class="history-review__body" data-review-body>
      <p class="poll-line history-main__hint" data-track-hint>Pick a device and session to review the outing.</p>
      <div class="history-review__timeline" data-timeline-mount hidden></div>
      <div class="history-swipe" data-swipe hidden>
        <div class="history-swipe__track" data-swipe-track>
          <section class="history-pane" data-pane="metrics" aria-label="Metrics">
            <div class="history-stats" data-history-stats></div>
          </section>
          <section class="history-pane" data-pane="map" aria-label="Map">
            <div class="history-map-wrap">
              <div class="history-map" data-history-map></div>
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
          <div class="history-swipe__dots" data-swipe-dots role="tablist" aria-label="Review displays">
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

export class HistoryPanel {
  private getSettings: () => CoachSettings;
  private onStatus: StatusFn;
  private host: HTMLElement | null = null;
  private tracks: DeviceTrack[] = [];
  private selection: HistorySelection | null = null;
  private timeline: HistoryTimeline | null = null;
  private historyMap: L.Map | null = null;
  private historyLines = new Map<string, L.Polyline>();
  private knownDevices: string[] = [];
  private devicesLoaded = false;
  private loading = false;
  private loadingMessage = '';
  private chartResizeObserver: ResizeObserver | null = null;
  private refreshScheduled = false;
  private activePane: PaneId = 'metrics';
  private swipeEl: HTMLElement | null = null;
  private sessionsCache: SessionSummary[] = [];
  private lastSessionId = '';
  private autoLoadToken = 0;

  constructor(getSettings: () => CoachSettings, onStatus: StatusFn) {
    this.getSettings = getSettings;
    this.onStatus = onStatus;
  }

  /** Call before app re-render clears host elements. */
  prepareForRender(nextTab: string): void {
    if (nextTab !== 'history') {
      this.teardownMap();
      this.teardownChartObserver();
      this.timeline = null;
      this.swipeEl = null;
      this.host = null;
    }
  }

  /** Call after History tab is shown — fixes map/chart sizing when panel was hidden. */
  onHistoryTabShown(): void {
    if (this.tracks.length) this.scheduleRefreshViews();
    this.syncSwipeUi();
  }

  mount(host: HTMLElement): void {
    this.host = host;
    host.innerHTML = REVIEW_HTML;
    bindInfoToggles(host);

    this.swipeEl = this.q<HTMLElement>('[data-swipe]');
    this.swipeEl?.addEventListener('scroll', () => this.onSwipeScroll(), { passive: true });

    host.querySelector('[data-load-devices]')?.addEventListener('click', () => void this.loadDeviceList());
    host.querySelector('[data-toggle-devices]')?.addEventListener('click', () => this.toggleDeviceExtra());
    host.querySelector('[data-device-select]')?.addEventListener('change', () => {
      void this.onPrimaryDeviceChange();
    });
    host.querySelector('[data-session-select]')?.addEventListener('change', () => {
      void this.onSessionChange();
    });
    host.querySelector('[data-device-add]')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.addDeviceFromInput();
    });
    host.querySelector('[data-device-add]')?.addEventListener('blur', () => this.addDeviceFromInput());

    host.querySelectorAll<HTMLButtonElement>('[data-dot]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.dot as PaneId;
        this.scrollToPane(id);
      });
    });
    host.querySelector('[data-pane-prev]')?.addEventListener('click', () => this.stepPane(-1));
    host.querySelector('[data-pane-next]')?.addEventListener('click', () => this.stepPane(1));

    host.tabIndex = 0;
    host.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      this.stepPane(e.key === 'ArrowRight' ? 1 : -1);
    });

    const tlMount = this.q<HTMLElement>('[data-timeline-mount]');
    if (tlMount) {
      this.timeline = new HistoryTimeline(tlMount, {
        onChange: (sel) => {
          this.selection = sel;
          this.scheduleRefreshViews();
        },
      });
      if (this.selection && this.tracks.length) {
        const tMin = Math.min(...this.tracks.map((t) => t.tMin));
        const tMax = Math.max(...this.tracks.map((t) => t.tMax));
        this.timeline.setSelection(this.selection, {
          tMin,
          tMax,
          totalDistM: maxDistance(this.tracks),
        });
      }
    }

    this.bindChartResizeObserver();
    this.updateTrackHint();
    this.syncLoadingUi();
    this.syncSwipeUi();

    if (!this.devicesLoaded) {
      this.devicesLoaded = true;
      void this.loadDeviceList();
    } else {
      this.renderDeviceSelect();
      this.renderDeviceCheckboxes();
      this.restoreSessionSelect();
    }

    if (this.tracks.length) this.scheduleRefreshViews();
  }

  destroy(): void {
    this.teardownMap();
    this.teardownChartObserver();
    this.timeline = null;
    this.swipeEl = null;
    this.host = null;
    this.devicesLoaded = false;
    this.tracks = [];
    this.selection = null;
    this.knownDevices = [];
    this.loading = false;
  }

  private q<T extends Element>(sel: string): T | null {
    return (this.host?.querySelector(sel) ?? null) as T | null;
  }

  private toggleDeviceExtra(): void {
    const extra = this.q<HTMLElement>('[data-device-extra]');
    const btn = this.q<HTMLButtonElement>('[data-toggle-devices]');
    if (!extra || !btn) return;
    const open = extra.hasAttribute('hidden');
    extra.toggleAttribute('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? '−' : '+';
  }

  private setLoading(active: boolean, message = 'Loading session data…'): void {
    this.loading = active;
    this.loadingMessage = message;
    this.syncLoadingUi();
  }

  private syncLoadingUi(): void {
    const setupStatus = this.q<HTMLElement>('[data-setup-load-status]');
    const overlay = this.q<HTMLElement>('[data-history-loading]');
    const overlayText = this.q<HTMLElement>('[data-loading-text]');
    const selects = this.host?.querySelectorAll<HTMLSelectElement>(
      '[data-device-select], [data-session-select]',
    );

    selects?.forEach((el) => {
      el.disabled = this.loading;
    });

    if (setupStatus) {
      setupStatus.hidden = !this.loading;
      setupStatus.textContent = this.loading ? this.loadingMessage : '';
      setupStatus.classList.toggle('history-load-status--active', this.loading);
    }
    if (overlay) {
      overlay.hidden = !this.loading;
      overlay.classList.toggle('history-loading--active', this.loading);
      overlay.setAttribute('aria-busy', this.loading ? 'true' : 'false');
    }
    if (overlayText && this.loading) overlayText.textContent = this.loadingMessage;
  }

  private scheduleRefreshViews(): void {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.refreshScheduled = false;
        this.refreshViews();
      });
    });
  }

  private bindChartResizeObserver(): void {
    this.teardownChartObserver();
    const swipe = this.q<HTMLElement>('[data-swipe]');
    if (!swipe || typeof ResizeObserver === 'undefined') return;
    this.chartResizeObserver = new ResizeObserver(() => {
      if (this.tracks.length && this.selection) this.renderCharts();
      if (this.historyMap) {
        window.setTimeout(() => this.historyMap?.invalidateSize(), 40);
      }
    });
    this.chartResizeObserver.observe(swipe);
  }

  private teardownChartObserver(): void {
    this.chartResizeObserver?.disconnect();
    this.chartResizeObserver = null;
  }

  private teardownMap(): void {
    if (this.historyMap) {
      this.historyMap.remove();
      this.historyMap = null;
    }
    this.historyLines.clear();
  }

  private updateTrackHint(): void {
    const hint = this.q<HTMLElement>('[data-track-hint]');
    const hasTracks = this.tracks.length > 0;
    if (hint) hint.hidden = hasTracks || this.loading;
    this.q('[data-timeline-mount]')?.toggleAttribute('hidden', !hasTracks);
    this.q('[data-swipe]')?.toggleAttribute('hidden', !hasTracks);
    this.q('[data-swipe-footer]')?.toggleAttribute('hidden', !hasTracks);
    if (hasTracks && !this.loading) {
      const overlay = this.q<HTMLElement>('[data-history-loading]');
      if (overlay) {
        overlay.hidden = true;
        overlay.classList.remove('history-loading--active');
        overlay.setAttribute('aria-busy', 'false');
      }
    }
  }

  private selectedDeviceIds(): string[] {
    const boxes = this.host?.querySelectorAll<HTMLInputElement>('[data-device-id]:checked') ?? [];
    const fromBoxes = [...boxes].map((b) => b.value);
    if (fromBoxes.length) return fromBoxes;
    const primary = this.q<HTMLSelectElement>('[data-device-select]')?.value ?? '';
    return primary ? [primary] : [];
  }

  private primaryDeviceId(): string {
    return this.q<HTMLSelectElement>('[data-device-select]')?.value ?? '';
  }

  private renderDeviceSelect(): void {
    const sel = this.q<HTMLSelectElement>('[data-device-select]');
    if (!sel) return;
    const current = sel.value || this.knownDevices[0] || '';
    if (!this.knownDevices.length) {
      sel.innerHTML = '<option value="">No devices</option>';
      return;
    }
    sel.innerHTML = this.knownDevices
      .map((id) => `<option value="${esc(id)}" ${id === current ? 'selected' : ''}>${esc(id)}</option>`)
      .join('');
  }

  private renderDeviceCheckboxes(): void {
    const list = this.q<HTMLElement>('[data-device-list]');
    if (!list) return;
    const selected = new Set(this.selectedDeviceIds());
    const primary = this.primaryDeviceId();
    if (!this.knownDevices.length) {
      list.innerHTML = '<p class="poll-line">No devices — add IDs manually.</p>';
      return;
    }
    list.innerHTML = this.knownDevices
      .map(
        (id) =>
          `<label class="history-device-chip"><input type="checkbox" data-device-id value="${esc(id)}" ${selected.has(id) || id === primary ? 'checked' : ''} /> ${esc(id)}</label>`,
      )
      .join('');

    list.querySelectorAll<HTMLInputElement>('[data-device-id]').forEach((box) => {
      box.addEventListener('change', () => {
        const ids = this.selectedDeviceIds();
        if (ids.length && !ids.includes(this.primaryDeviceId())) {
          const sel = this.q<HTMLSelectElement>('[data-device-select]');
          if (sel) {
            sel.value = ids[0];
            void this.onPrimaryDeviceChange();
          }
        }
      });
    });
  }

  private addDeviceFromInput(): void {
    const input = this.q<HTMLInputElement>('[data-device-add]');
    const id = input?.value.trim().toUpperCase();
    if (!id) return;
    if (!this.knownDevices.includes(id)) {
      this.knownDevices.push(id);
      this.knownDevices.sort();
      this.renderDeviceSelect();
      this.renderDeviceCheckboxes();
      const sel = this.q<HTMLSelectElement>('[data-device-select]');
      if (sel) sel.value = id;
      void this.onPrimaryDeviceChange();
    }
    if (input) input.value = '';
  }

  private async loadDeviceList(): Promise<void> {
    try {
      const settings = this.getSettings();
      const devices = await listHistoryDevices(settings);
      const ids = devices.map((d) => String(d.uniqueId ?? d.unique_id ?? d.deviceId ?? '')).filter(Boolean);
      this.knownDevices = [...new Set([...this.knownDevices, ...ids])].sort();
      this.renderDeviceSelect();
      this.renderDeviceCheckboxes();
      this.onStatus(`${this.knownDevices.length} device(s) available`);
      if (this.primaryDeviceId()) {
        await this.loadSessionsForPrimary();
      }
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
      const sel = this.q<HTMLSelectElement>('[data-device-select]');
      if (sel && !this.knownDevices.length) {
        sel.innerHTML = '<option value="">Set API in Settings</option>';
      }
    }
  }

  private async onPrimaryDeviceChange(): Promise<void> {
    this.renderDeviceCheckboxes();
    await this.loadSessionsForPrimary();
  }

  private fillSessionSelect(sessions: SessionSummary[], selectedId = ''): void {
    const sel = this.q<HTMLSelectElement>('[data-session-select]');
    if (!sel) return;
    sel.innerHTML =
      sessions.length === 0
        ? '<option value="">No sessions</option>'
        : sessions
            .map(
              (s: SessionSummary) =>
                `<option value="${esc(s.session_id)}" data-from="${esc(s.started_at)}" data-to="${esc(s.ended_at ?? '')}" data-boat-class="${esc(s.boat_class ?? '')}" data-athlete-id="${esc(s.athlete_id ?? '')}" ${s.session_id === selectedId ? 'selected' : ''}>${esc(formatSessionLabel(s.started_at))}</option>`,
            )
            .join('');
  }

  private selectedSessionMeta(): { boatClass: string | null; athleteId: string | null } {
    const sel = this.q<HTMLSelectElement>('[data-session-select]');
    const opt = sel?.selectedOptions[0];
    const boatClass = String(opt?.dataset.boatClass ?? '').trim() || null;
    const athleteId = String(opt?.dataset.athleteId ?? '').trim() || null;
    return { boatClass, athleteId };
  }

  private restoreSessionSelect(): void {
    if (!this.sessionsCache.length) {
      const sel = this.q<HTMLSelectElement>('[data-session-select]');
      if (sel) sel.innerHTML = '<option value="">— pick device —</option>';
      return;
    }
    this.fillSessionSelect(this.sessionsCache, this.lastSessionId);
  }

  private async loadSessionsForPrimary(): Promise<void> {
    const deviceId = this.primaryDeviceId();
    const sel = this.q<HTMLSelectElement>('[data-session-select]');
    if (!sel) return;
    if (!deviceId) {
      sel.innerHTML = '<option value="">— pick device —</option>';
      this.sessionsCache = [];
      return;
    }
    try {
      const settings = this.getSettings();
      const sessions = await listSessions(settings, deviceId);
      this.sessionsCache = sessions;
      this.fillSessionSelect(sessions);
      this.onStatus(`${sessions.length} session(s) for ${deviceId}`);
      if (sessions.length) {
        void this.onSessionChange();
      }
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
      sel.innerHTML = '<option value="">Failed to load</option>';
    }
  }

  private async onSessionChange(): Promise<void> {
    const sessionId = this.q<HTMLSelectElement>('[data-session-select]')?.value ?? '';
    if (!sessionId) return;
    this.lastSessionId = sessionId;
    await this.loadTracks();
  }

  private sessionTimeRange(): { from: string; to: string } | null {
    const sel = this.q<HTMLSelectElement>('[data-session-select]');
    const opt = sel?.selectedOptions[0];
    if (!opt?.value) return null;
    const from = opt.dataset.from ?? '';
    let to = opt.dataset.to ?? '';
    if (!to) to = new Date().toISOString();
    return { from, to };
  }

  private async loadTracks(): Promise<void> {
    const devices = this.selectedDeviceIds();
    if (!devices.length) {
      this.onStatus('Select at least one device', true);
      return;
    }
    const settings = this.getSettings();
    const sessionId = this.q<HTMLSelectElement>('[data-session-select]')?.value ?? '';
    let fromTo = this.sessionTimeRange();
    const token = ++this.autoLoadToken;

    this.setLoading(true, 'Fetching GPS tracks…');
    try {
      const loaded: DeviceTrack[] = [];

      const sessionMeta = this.selectedSessionMeta();

      if (sessionId && devices.length === 1) {
        this.setLoading(true, `Loading session for ${devices[0]}…`);
        const dash = await loadSessionDashboard(settings, sessionId);
        if (token !== this.autoLoadToken) return;
        loaded.push(
          buildDeviceTrack(devices[0], colorForDevice(0), dash.track ?? [], {
            boatClass: dash.boatClass ?? sessionMeta.boatClass,
            athleteId: dash.athleteId ?? sessionMeta.athleteId,
          }),
        );
        if (dash.from && dash.to) fromTo = { from: dash.from, to: dash.to };
        else if ((dash.track ?? []).length) {
          const tr = dash.track!;
          fromTo = {
            from: new Date(tr[0].t).toISOString(),
            to: new Date(tr[tr.length - 1].t).toISOString(),
          };
        }
      }

      if (!fromTo) {
        this.onStatus('Pick a session to set the time window', true);
        return;
      }

      if (!(devices.length === 1 && loaded.length)) {
        for (let i = 0; i < devices.length; i++) {
          const deviceId = devices[i];
          if (loaded.some((t) => t.deviceId === deviceId)) continue;
          this.setLoading(true, `Loading ${deviceId} (${i + 1}/${devices.length})…`);
          const payload = await loadDeviceHistoryRange(settings, deviceId, fromTo.from, fromTo.to);
          if (token !== this.autoLoadToken) return;
          loaded.push(
            buildDeviceTrack(deviceId, colorForDevice(i), payload.track ?? [], {
              boatClass: payload.boatClass ?? (deviceId === this.primaryDeviceId() ? sessionMeta.boatClass : null),
              athleteId: payload.athleteId ?? (deviceId === this.primaryDeviceId() ? sessionMeta.athleteId : null),
            }),
          );
        }
      }

      this.tracks = loaded.filter((t) => t.points.length > 0);
      if (!this.tracks.length) {
        this.onStatus('No GPS data for selection', true);
        this.updateTrackHint();
        return;
      }

      this.selection = defaultSelection(this.tracks);
      const tMin = Math.min(...this.tracks.map((t) => t.tMin));
      const tMax = Math.max(...this.tracks.map((t) => t.tMax));
      this.timeline?.setSelection(this.selection, {
        tMin,
        tMax,
        totalDistM: maxDistance(this.tracks),
      });
      this.updateTrackHint();
      this.onStatus(
        `Loaded ${this.tracks.length} device(s) · ${this.tracks.reduce((n, t) => n + t.points.length, 0)} points`,
      );
      this.setLoading(false);
      this.scrollToPane(this.activePane);
      this.scheduleRefreshViews();
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      if (token === this.autoLoadToken) this.setLoading(false);
    }
  }

  private paneIndex(id: PaneId): number {
    return PANES.findIndex((p) => p.id === id);
  }

  private stepPane(delta: number): void {
    const idx = this.paneIndex(this.activePane);
    const next = idx + delta;
    if (next < 0 || next >= PANES.length) return;
    this.scrollToPane(PANES[next].id);
  }

  private scrollToPane(id: PaneId): void {
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
      window.setTimeout(() => this.historyMap?.invalidateSize(), 80);
      window.setTimeout(() => this.historyMap?.invalidateSize(), 280);
    }
    if (id === 'speed-time' || id === 'speed-dist' || id === 'spm' || id === 'hr') {
      this.renderCharts();
    }
  }

  private onSwipeScroll(): void {
    const swipe = this.swipeEl;
    if (!swipe) return;
    const w = swipe.clientWidth || 1;
    const idx = Math.round(swipe.scrollLeft / w);
    const pane = PANES[Math.max(0, Math.min(PANES.length - 1, idx))];
    if (pane && pane.id !== this.activePane) {
      this.activePane = pane.id;
      this.syncSwipeUi();
      if (pane.id === 'map') {
        window.setTimeout(() => this.historyMap?.invalidateSize(), 50);
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

  private syncSwipeUi(): void {
    const label = this.q<HTMLElement>('[data-pane-label]');
    const pane = PANES.find((p) => p.id === this.activePane) ?? PANES[0];
    if (label) label.textContent = pane.label;
    this.host?.querySelectorAll<HTMLButtonElement>('[data-dot]').forEach((btn) => {
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

  private refreshViews(): void {
    if (!this.selection || !this.tracks.length) return;
    this.renderStats();
    this.renderMap();
    this.renderCharts();
  }

  private renderStats(): void {
    const host = this.q<HTMLElement>('[data-history-stats]');
    if (!host || !this.selection) return;
    const stats = computeDeviceStats(this.tracks, this.selection);
    if (!stats.length) {
      host.innerHTML = '';
      return;
    }
    const rangeLabel = this.selection.distanceMode
      ? `${Math.round(this.selection.distStartM)}–${Math.round(this.selection.distStartM + this.selection.distWindowM)} m window`
      : `${formatDuration((this.selection.t1 - this.selection.t0) / 1000)} selected`;

    host.innerHTML = `
      <div class="history-stats__bar">
        <h2 class="history-stats__title">Session stats</h2>
        <span class="history-stats__range">${esc(rangeLabel)}</span>
      </div>
      <div class="history-stats__grid">
        ${stats
          .map(
            (s) => `
          <article class="history-stats__card" style="--device-color: ${esc(s.color)}; border-left-color: ${esc(s.color)}">
            <h3 class="history-stats__device">${esc(s.deviceId)}${s.boatClass ? ` <span class="history-hint">${esc(s.boatClass)}</span>` : ''}</h3>
            <dl class="history-stats__dl">
              <div><dt>Duration</dt><dd>${esc(formatDuration(s.durationSec))}</dd></div>
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
          </article>`,
          )
          .join('')}
      </div>`;
  }

  private renderMap(): void {
    if (!this.selection) return;
    const mapEl = this.q<HTMLElement>('[data-history-map]');
    if (!mapEl) return;

    if (!this.historyMap) {
      this.historyMap = L.map(mapEl, { preferCanvas: true });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(this.historyMap);
    }

    const filtered = filterTracks(this.tracks, this.selection);
    const bounds: L.LatLng[] = [];

    for (const track of filtered) {
      const latlngs = track.points
        .filter((p) => p.lat != null && p.lon != null)
        .map((p) => L.latLng(p.lat!, p.lon!));
      if (latlngs.length < 2) continue;
      latlngs.forEach((ll) => bounds.push(ll));
      let line = this.historyLines.get(track.deviceId);
      if (line) {
        line.setLatLngs(latlngs);
        line.setStyle({ color: track.color, weight: 4, opacity: 0.9 });
      } else {
        line = L.polyline(latlngs, { color: track.color, weight: 4, opacity: 0.9 });
        line.addTo(this.historyMap);
        this.historyLines.set(track.deviceId, line);
      }
    }

    for (const [id, line] of this.historyLines) {
      if (!filtered.some((t) => t.deviceId === id)) {
        this.historyMap.removeLayer(line);
        this.historyLines.delete(id);
      }
    }

    if (bounds.length >= 2) {
      this.historyMap.fitBounds(L.latLngBounds(bounds), { padding: [28, 28] });
    }
    window.setTimeout(() => this.historyMap?.invalidateSize(), 50);
    window.setTimeout(() => this.historyMap?.invalidateSize(), 280);
  }

  private renderCharts(): void {
    if (!this.selection) return;
    const sel = this.selection;
    const boatClass =
      this.tracks.map((t) => resolveTrackBoatClass(t)).find((b) => b != null) ?? null;
    const bands = prognosticBandsKmh(boatClass);
    const bandNote = bands.length
      ? undefined
      : boatClass
        ? `No prognostic bands for ${boatClass}`
        : 'No boat class on session — prognostic bands unavailable';

    const speedTime = this.q<HTMLCanvasElement>('[data-chart-speed-time]');
    const speedDist = this.q<HTMLCanvasElement>('[data-chart-speed-dist]');
    const spm = this.q<HTMLCanvasElement>('[data-chart-spm]');
    const hr = this.q<HTMLCanvasElement>('[data-chart-hr]');

    if (speedTime) {
      drawMultiSeriesChart(speedTime, speedVsTimeSeries(this.tracks, sel), {
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
      drawMultiSeriesChart(speedDist, speedVsDistanceSeries(this.tracks, sel), {
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
      drawMultiSeriesChart(spm, strokeRateSeries(this.tracks, sel), {
        title: 'Stroke rate vs time',
        xLabel: 'seconds',
        yLabel: 'spm',
        yFormat: (v) => `${v.toFixed(0)}`,
        theme: 'recorder',
      });
    }
    if (hr) {
      drawMultiSeriesChart(hr, hrVsTimeSeries(this.tracks, sel), {
        title: 'HR vs time',
        xLabel: 'seconds',
        yLabel: 'bpm',
        yFormat: (v) => `${v.toFixed(0)}`,
        theme: 'recorder',
      });
    }
  }
}

function formatSessionLabel(startedAt: string): string {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return startedAt;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} ${time}`;
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
