import L from 'leaflet';
import {
  listHistoryDevices,
  listSessions,
  loadDeviceHistoryRange,
  loadSessionDashboard,
  type CoachSettings,
  type SessionSummary,
} from '../lib/api';
import { drawMultiSeriesChart } from '../lib/history-charts';
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
  maxDistance,
  speedVsDistanceSeries,
  speedVsTimeSeries,
  strokeRateSeries,
  type DeviceTrack,
  type HistorySelection,
} from '../lib/history-track';
import { HistoryTimeline } from '../lib/history-timeline';

type StatusFn = (msg: string, err?: boolean) => void;

const SETUP_HTML = `
  <fieldset class="history-devices-field">
    <legend>Devices <span class="history-hint">(select one or more)</span></legend>
    <div class="history-device-list" data-device-list>
      <p class="poll-line">Load device list or type IDs below.</p>
    </div>
    <label class="coach-field history-device-add">
      Add device ID
      <input type="text" data-device-add placeholder="e.g. A2" />
    </label>
    <button type="button" class="coach-btn coach-btn--ghost" data-load-devices>Refresh device list</button>
  </fieldset>
  <button type="button" class="coach-btn coach-btn--ghost" data-load-sessions>Load sessions (first device)</button>
  <label class="coach-field">Session
    <select data-session-select><option value="">— load sessions first —</option></select>
  </label>
  <button type="button" class="coach-btn coach-btn--primary" data-load-track>Load trace &amp; charts</button>
  <p class="history-load-status" data-setup-load-status hidden aria-live="polite"></p>`;

const TRACK_HTML = `
  <div class="history-main" data-history-main>
    <p class="poll-line history-main__hint" data-track-hint>Use Settings to choose devices and load a session.</p>
    <div class="history-loading" data-history-loading hidden aria-live="polite">
      <div class="history-loading__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100">
        <div class="history-loading__fill"></div>
      </div>
      <p class="history-loading__text" data-loading-text>Loading session data…</p>
    </div>
    <div data-timeline-mount hidden></div>
    <div class="history-stats" data-history-stats hidden></div>
    <div class="history-map-wrap" hidden>
      <div class="history-map" data-history-map></div>
    </div>
    <div class="history-charts" hidden>
      <canvas class="history-chart" data-chart-speed-time height="200"></canvas>
      <canvas class="history-chart" data-chart-speed-dist height="200"></canvas>
      <canvas class="history-chart" data-chart-spm height="200"></canvas>
    </div>
  </div>`;

export class HistoryPanel {
  private getSettings: () => CoachSettings;
  private onStatus: StatusFn;
  private onTracksLoaded?: () => void;
  private setupHost: HTMLElement | null = null;
  private trackHost: HTMLElement | null = null;
  private tracks: DeviceTrack[] = [];
  private selection: HistorySelection | null = null;
  private timeline: HistoryTimeline | null = null;
  private historyMap: L.Map | null = null;
  private historyLines = new Map<string, L.Polyline>();
  private knownDevices: string[] = [];
  private sessionMeta: { from: string; to: string } | null = null;
  private devicesLoaded = false;
  private loading = false;
  private loadingMessage = '';
  private chartResizeObserver: ResizeObserver | null = null;
  private refreshScheduled = false;

  constructor(
    getSettings: () => CoachSettings,
    onStatus: StatusFn,
    onTracksLoaded?: () => void,
  ) {
    this.getSettings = getSettings;
    this.onStatus = onStatus;
    this.onTracksLoaded = onTracksLoaded;
  }

  /** Call before app re-render clears host elements. */
  prepareForRender(nextTab: 'live' | 'history' | 'settings'): void {
    if (nextTab !== 'history') {
      this.teardownMap();
      this.teardownChartObserver();
      this.timeline = null;
      this.trackHost = null;
    }
    if (nextTab !== 'settings') {
      this.setupHost = null;
    }
  }

  /** Call after History tab is shown — fixes map/chart sizing when panel was hidden. */
  onHistoryTabShown(): void {
    if (this.tracks.length) this.scheduleRefreshViews();
  }

  mountSetup(host: HTMLElement): void {
    this.setupHost = host;
    host.innerHTML = SETUP_HTML;
    host.querySelector('[data-load-devices]')?.addEventListener('click', () => void this.loadDeviceList());
    host.querySelector('[data-load-sessions]')?.addEventListener('click', () => void this.loadSessions());
    host.querySelector('[data-load-track]')?.addEventListener('click', () => void this.loadTracks());
    host.querySelector('[data-device-add]')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.addDeviceFromInput();
    });
    host.querySelector('[data-device-add]')?.addEventListener('blur', () => this.addDeviceFromInput());
    this.syncLoadingUi();
    if (!this.devicesLoaded) {
      this.devicesLoaded = true;
      void this.loadDeviceList();
    } else {
      this.renderDeviceCheckboxes();
    }
  }

  mountTrack(host: HTMLElement): void {
    this.trackHost = host;
    host.innerHTML = TRACK_HTML;
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
    if (this.tracks.length) this.scheduleRefreshViews();
  }

  destroy(): void {
    this.teardownMap();
    this.teardownChartObserver();
    this.timeline = null;
    this.setupHost = null;
    this.trackHost = null;
    this.devicesLoaded = false;
    this.tracks = [];
    this.selection = null;
    this.knownDevices = [];
    this.loading = false;
  }

  private q<T extends Element>(sel: string): T | null {
    return (this.setupHost?.querySelector(sel) ??
      this.trackHost?.querySelector(sel) ??
      null) as T | null;
  }

  private setLoading(active: boolean, message = 'Loading session data…'): void {
    this.loading = active;
    this.loadingMessage = message;
    this.syncLoadingUi();
  }

  private syncLoadingUi(): void {
    const loadBtn = this.q<HTMLButtonElement>('[data-load-track]');
    const setupStatus = this.q<HTMLElement>('[data-setup-load-status]');
    const overlay = this.q<HTMLElement>('[data-history-loading]');
    const overlayText = this.q<HTMLElement>('[data-loading-text]');

    if (loadBtn) {
      loadBtn.disabled = this.loading;
      loadBtn.textContent = this.loading ? 'Loading…' : 'Load trace & charts';
    }
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
    const charts = this.q<HTMLElement>('.history-charts');
    if (!charts || typeof ResizeObserver === 'undefined') return;
    this.chartResizeObserver = new ResizeObserver(() => {
      if (this.tracks.length && this.selection) this.renderCharts();
    });
    this.chartResizeObserver.observe(charts);
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
    this.q('[data-history-stats]')?.toggleAttribute('hidden', !hasTracks);
    this.q('.history-map-wrap')?.toggleAttribute('hidden', !hasTracks);
    this.q('.history-charts')?.toggleAttribute('hidden', !hasTracks);
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
    const boxes = this.setupHost?.querySelectorAll<HTMLInputElement>('[data-device-id]:checked') ?? [];
    return [...boxes].map((b) => b.value);
  }

  private renderDeviceCheckboxes(): void {
    const list = this.q<HTMLElement>('[data-device-list]');
    if (!list) return;
    const selected = new Set(this.selectedDeviceIds());
    if (!this.knownDevices.length) {
      list.innerHTML = '<p class="poll-line">No devices — add IDs manually.</p>';
      return;
    }
    list.innerHTML = this.knownDevices
      .map(
        (id, i) =>
          `<label class="history-device-chip"><input type="checkbox" data-device-id value="${esc(id)}" ${selected.has(id) || (selected.size === 0 && i === 0) ? 'checked' : ''} /> ${esc(id)}</label>`,
      )
      .join('');
  }

  private addDeviceFromInput(): void {
    const input = this.q<HTMLInputElement>('[data-device-add]');
    const id = input?.value.trim().toUpperCase();
    if (!id) return;
    if (!this.knownDevices.includes(id)) {
      this.knownDevices.push(id);
      this.knownDevices.sort();
      this.renderDeviceCheckboxes();
      const box = this.setupHost?.querySelector(
        `[data-device-id][value="${CSS.escape(id)}"]`,
      ) as HTMLInputElement | null;
      if (box) box.checked = true;
    }
    if (input) input.value = '';
  }

  private async loadDeviceList(): Promise<void> {
    try {
      const settings = this.getSettings();
      const devices = await listHistoryDevices(settings);
      const ids = devices.map((d) => String(d.uniqueId ?? d.unique_id ?? d.deviceId ?? '')).filter(Boolean);
      this.knownDevices = [...new Set([...this.knownDevices, ...ids])].sort();
      this.renderDeviceCheckboxes();
      this.onStatus(`${this.knownDevices.length} device(s) available`);
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  private async loadSessions(): Promise<void> {
    const devices = this.selectedDeviceIds();
    if (!devices.length) {
      this.onStatus('Select at least one device', true);
      return;
    }
    try {
      const settings = this.getSettings();
      const sessions = await listSessions(settings, devices[0]);
      const sel = this.q<HTMLSelectElement>('[data-session-select]');
      if (!sel) return;
      sel.innerHTML =
        sessions.length === 0
          ? '<option value="">No sessions</option>'
          : sessions
              .map(
                (s: SessionSummary) =>
                  `<option value="${esc(s.session_id)}" data-from="${esc(s.started_at)}" data-to="${esc(s.ended_at ?? '')}">${esc(formatSessionLabel(s.started_at))}</option>`,
              )
              .join('');
      this.onStatus(`${sessions.length} session(s) for ${devices[0]}`);
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
    }
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

    this.setLoading(true, 'Fetching GPS tracks…');
    try {
      const loaded: DeviceTrack[] = [];

      if (sessionId && devices.length === 1) {
        this.setLoading(true, `Loading session for ${devices[0]}…`);
        const dash = await loadSessionDashboard(settings, sessionId);
        loaded.push(buildDeviceTrack(devices[0], colorForDevice(0), dash.track ?? []));
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
          loaded.push(buildDeviceTrack(deviceId, colorForDevice(i), payload.track ?? []));
        }
      }

      this.tracks = loaded.filter((t) => t.points.length > 0);
      if (!this.tracks.length) {
        this.onStatus('No GPS data for selection', true);
        return;
      }

      this.sessionMeta = fromTo;
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
      this.onTracksLoaded?.();
      if (this.trackHost) this.scheduleRefreshViews();
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      this.setLoading(false);
    }
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
      <h2 class="history-stats__title">Session stats <span class="history-hint">(${esc(rangeLabel)})</span></h2>
      <div class="history-stats__grid">
        ${stats
          .map(
            (s) => `
          <article class="history-stats__card" style="border-left-color: ${esc(s.color)}">
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

    const speedTime = this.q<HTMLCanvasElement>('[data-chart-speed-time]');
    const speedDist = this.q<HTMLCanvasElement>('[data-chart-speed-dist]');
    const spm = this.q<HTMLCanvasElement>('[data-chart-spm]');

    if (speedTime) {
      drawMultiSeriesChart(speedTime, speedVsTimeSeries(this.tracks, sel), {
        title: 'Speed vs time',
        xLabel: 'seconds',
        yLabel: 'km/h',
        yFormat: (v) => `${v.toFixed(0)}`,
      });
    }
    if (speedDist) {
      drawMultiSeriesChart(speedDist, speedVsDistanceSeries(this.tracks, sel), {
        title: 'Speed vs distance',
        xLabel: 'metres',
        yLabel: 'km/h',
        yFormat: (v) => `${v.toFixed(0)}`,
      });
    }
    if (spm) {
      drawMultiSeriesChart(spm, strokeRateSeries(this.tracks, sel), {
        title: 'Stroke rate vs time',
        xLabel: 'seconds',
        yLabel: 'spm',
        yFormat: (v) => `${v.toFixed(0)}`,
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
