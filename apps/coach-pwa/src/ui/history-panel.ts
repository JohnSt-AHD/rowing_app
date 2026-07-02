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
  formatSpeedKmh,
  maxDistance,
  speedVsDistanceSeries,
  speedVsTimeSeries,
  strokeRateSeries,
  type DeviceTrack,
  type HistorySelection,
} from '../lib/history-track';
import { HistoryTimeline } from '../lib/history-timeline';

type StatusFn = (msg: string, err?: boolean) => void;
type HistoryView = 'track' | 'settings';

export class HistoryPanel {
  private host: HTMLElement;
  private getSettings: () => CoachSettings;
  private onStatus: StatusFn;
  private tracks: DeviceTrack[] = [];
  private selection: HistorySelection | null = null;
  private timeline: HistoryTimeline | null = null;
  private historyMap: L.Map | null = null;
  private historyLines = new Map<string, L.Polyline>();
  private knownDevices: string[] = [];
  private sessionMeta: { from: string; to: string } | null = null;
  private view: HistoryView = 'track';

  constructor(host: HTMLElement, getSettings: () => CoachSettings, onStatus: StatusFn) {
    this.host = host;
    this.getSettings = getSettings;
    this.onStatus = onStatus;
  }

  mount(): void {
    this.host.innerHTML = `
      <div class="history-panel">
        <nav class="history-subtabs" aria-label="History views">
          <button type="button" class="history-subtab ${this.view === 'track' ? 'active' : ''}" data-history-view="track">Track</button>
          <button type="button" class="history-subtab ${this.view === 'settings' ? 'active' : ''}" data-history-view="settings">Settings</button>
        </nav>
        <div class="history-setup" data-history-setup ${this.view === 'settings' ? '' : 'hidden'}>
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
        </div>
        <div class="history-track" data-history-track ${this.view === 'track' ? '' : 'hidden'}>
          <p class="poll-line history-track__hint" data-track-hint hidden>Open Settings to choose devices and load a session.</p>
          <div data-timeline-mount></div>
          <div class="history-stats" data-stats hidden></div>
          <div class="history-map-wrap">
            <div class="history-map" data-history-map></div>
          </div>
          <div class="history-charts">
            <canvas class="history-chart" data-chart-speed-time height="200"></canvas>
            <canvas class="history-chart" data-chart-speed-dist height="200"></canvas>
            <canvas class="history-chart" data-chart-spm height="200"></canvas>
          </div>
        </div>
      </div>`;

    this.host.querySelectorAll('[data-history-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = (btn as HTMLElement).dataset.historyView as HistoryView;
        if (next === this.view) return;
        this.view = next;
        this.host.querySelector('[data-history-setup]')?.toggleAttribute('hidden', this.view !== 'settings');
        this.host.querySelector('[data-history-track]')?.toggleAttribute('hidden', this.view !== 'track');
        this.host.querySelectorAll('[data-history-view]').forEach((b) => {
          b.classList.toggle('active', (b as HTMLElement).dataset.historyView === this.view);
        });
        if (this.view === 'track') {
          this.updateTrackHint();
          setTimeout(() => this.historyMap?.invalidateSize(), 120);
        }
      });
    });

    this.host.querySelector('[data-load-devices]')?.addEventListener('click', () => void this.loadDeviceList());
    this.host.querySelector('[data-load-sessions]')?.addEventListener('click', () => void this.loadSessions());
    this.host.querySelector('[data-load-track]')?.addEventListener('click', () => void this.loadTracks());
    this.host.querySelector('[data-device-add]')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.addDeviceFromInput();
    });
    this.host.querySelector('[data-device-add]')?.addEventListener('blur', () => this.addDeviceFromInput());

    const tlMount = this.host.querySelector('[data-timeline-mount]') as HTMLElement;
    this.timeline = new HistoryTimeline(tlMount, {
      onChange: (sel) => {
        this.selection = sel;
        this.refreshViews();
      },
    });

    this.updateTrackHint();
    void this.loadDeviceList();
  }

  destroy(): void {
    if (this.historyMap) {
      this.historyMap.remove();
      this.historyMap = null;
    }
    this.historyLines.clear();
    this.host.innerHTML = '';
  }

  private updateTrackHint(): void {
    const hint = this.host.querySelector('[data-track-hint]') as HTMLElement | null;
    if (!hint) return;
    hint.hidden = this.tracks.length > 0;
  }

  private selectedDeviceIds(): string[] {
    const boxes = this.host.querySelectorAll<HTMLInputElement>('[data-device-id]:checked');
    return [...boxes].map((b) => b.value);
  }

  private renderDeviceCheckboxes(): void {
    const list = this.host.querySelector('[data-device-list]');
    if (!list) return;
    if (!this.knownDevices.length) {
      list.innerHTML = '<p class="poll-line">No devices — add IDs manually.</p>';
      return;
    }
    list.innerHTML = this.knownDevices
      .map(
        (id, i) =>
          `<label class="history-device-chip"><input type="checkbox" data-device-id value="${esc(id)}" ${i === 0 ? 'checked' : ''} /> ${esc(id)}</label>`,
      )
      .join('');
  }

  private addDeviceFromInput(): void {
    const input = this.host.querySelector('[data-device-add]') as HTMLInputElement;
    const id = input?.value.trim().toUpperCase();
    if (!id) return;
    if (!this.knownDevices.includes(id)) {
      this.knownDevices.push(id);
      this.knownDevices.sort();
      this.renderDeviceCheckboxes();
      const box = this.host.querySelector(
        `[data-device-id][value="${CSS.escape(id)}"]`,
      ) as HTMLInputElement;
      if (box) box.checked = true;
    }
    input.value = '';
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
      const sel = this.host.querySelector('[data-session-select]') as HTMLSelectElement;
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
    const sel = this.host.querySelector('[data-session-select]') as HTMLSelectElement;
    const opt = sel.selectedOptions[0];
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
    const sessionId = (this.host.querySelector('[data-session-select]') as HTMLSelectElement).value;
    let fromTo = this.sessionTimeRange();

    try {
      this.onStatus('Loading tracks…');
      const loaded: DeviceTrack[] = [];

      if (sessionId && devices.length === 1) {
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

      if (devices.length === 1 && loaded.length) {
        // single-device session already loaded
      } else {
        for (let i = 0; i < devices.length; i++) {
          const deviceId = devices[i];
          if (loaded.some((t) => t.deviceId === deviceId)) continue;
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
      this.view = 'track';
      this.host.querySelector('[data-history-setup]')?.setAttribute('hidden', '');
      this.host.querySelector('[data-history-track]')?.removeAttribute('hidden');
      this.host.querySelectorAll('[data-history-view]').forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.historyView === 'track');
      });
      this.updateTrackHint();
      this.refreshViews();
      this.onStatus(
        `Loaded ${this.tracks.length} device(s) · ${this.tracks.reduce((n, t) => n + t.points.length, 0)} points`,
      );
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  private refreshViews(): void {
    if (!this.selection || !this.tracks.length) return;
    this.renderStats();
    this.renderMap();
    this.renderCharts();
  }

  private renderStats(): void {
    const el = this.host.querySelector('[data-stats]') as HTMLElement;
    if (!el || !this.selection) return;
    const stats = computeDeviceStats(this.tracks, this.selection);
    el.hidden = false;
    el.innerHTML = `
      <h3 class="history-stats__title">Selection stats</h3>
      <div class="history-stats__grid">
        ${stats
          .map(
            (s) => `
          <div class="history-stats__card" style="--device-color:${s.color}">
            <div class="history-stats__device">${esc(s.deviceId)}</div>
            <dl class="history-stats__dl">
              <div><dt>Duration</dt><dd>${formatDuration(s.durationSec)}</dd></div>
              <div><dt>Distance</dt><dd>${Math.round(s.distanceM)} m</dd></div>
              <div><dt>Avg speed</dt><dd>${formatSpeedKmh(s.avgSpeedMps)}</dd></div>
              <div><dt>Max speed</dt><dd>${formatSpeedKmh(s.maxSpeedMps)}</dd></div>
              <div><dt>Avg stroke rate</dt><dd>${s.avgStrokeRate != null ? `${Math.round(s.avgStrokeRate)} spm` : '—'}</dd></div>
              <div><dt>Points</dt><dd>${s.pointCount}</dd></div>
            </dl>
          </div>`,
          )
          .join('')}
      </div>`;
  }

  private renderMap(): void {
    if (!this.selection) return;
    const mapEl = this.host.querySelector('[data-history-map]') as HTMLElement;
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
    setTimeout(() => this.historyMap?.invalidateSize(), 120);
  }

  private renderCharts(): void {
    if (!this.selection) return;
    const sel = this.selection;

    const speedTime = this.host.querySelector('[data-chart-speed-time]') as HTMLCanvasElement;
    const speedDist = this.host.querySelector('[data-chart-speed-dist]') as HTMLCanvasElement;
    const spm = this.host.querySelector('[data-chart-spm]') as HTMLCanvasElement;

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
