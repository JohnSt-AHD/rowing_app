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
  defaultSelection,
  filterTracks,
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
  <button type="button" class="coach-btn coach-btn--primary" data-load-track>Load trace &amp; charts</button>`;

const TRACK_HTML = `
  <div class="history-main" data-history-main>
    <p class="poll-line history-main__hint" data-track-hint>Use Settings to choose devices and load a session.</p>
    <div data-timeline-mount hidden></div>
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
      this.timeline = null;
      this.trackHost = null;
    }
    if (nextTab !== 'settings') {
      this.setupHost = null;
    }
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
          this.refreshViews();
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
    this.updateTrackHint();
    if (this.tracks.length) this.refreshViews();
  }

  destroy(): void {
    this.teardownMap();
    this.timeline = null;
    this.setupHost = null;
    this.trackHost = null;
    this.devicesLoaded = false;
    this.tracks = [];
    this.selection = null;
    this.knownDevices = [];
  }

  private q<T extends Element>(sel: string): T | null {
    return (this.setupHost?.querySelector(sel) ??
      this.trackHost?.querySelector(sel) ??
      null) as T | null;
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
    if (hint) hint.hidden = hasTracks;
    this.q('[data-timeline-mount]')?.toggleAttribute('hidden', !hasTracks);
    this.q('.history-map-wrap')?.toggleAttribute('hidden', !hasTracks);
    this.q('.history-charts')?.toggleAttribute('hidden', !hasTracks);
  }

  private selectedDeviceIds(): string[] {
    const boxes = this.setupHost?.querySelectorAll<HTMLInputElement>('[data-device-id]:checked') ?? [];
    return [...boxes].map((b) => b.value);
  }

  private renderDeviceCheckboxes(): void {
    const list = this.q<HTMLElement>('[data-device-list]');
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

      if (!(devices.length === 1 && loaded.length)) {
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
      this.updateTrackHint();
      this.refreshViews();
      this.onStatus(
        `Loaded ${this.tracks.length} device(s) · ${this.tracks.reduce((n, t) => n + t.points.length, 0)} points`,
      );
      this.onTracksLoaded?.();
    } catch (e) {
      this.onStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  private refreshViews(): void {
    if (!this.selection || !this.tracks.length) return;
    this.renderMap();
    this.renderCharts();
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
    setTimeout(() => this.historyMap?.invalidateSize(), 120);
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
