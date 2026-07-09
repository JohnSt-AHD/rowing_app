import '../styles.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { HistoryPanel } from './history-panel';
import { drawMultiSeriesChart } from '../lib/history-charts';
import {
  clearLiveSpeedBuffers,
  liveDeviceColor,
  liveSpeedVsTimeSeries,
  recordLiveSpeedSamples,
  registerLiveDevice,
} from '../lib/live-speed-buffer';
import {
  fetchDevices,
  fetchMapPositions,
  type FleetDevice,
  type MapPosition,
} from '../lib/api';
import {
  getNativeMonitoringStatus,
  IS_NATIVE,
  startNativeMonitoring,
  stopNativeMonitoring,
} from '../lib/native-monitor';
import {
  clearMapTracks,
  displayLatLon,
  onMapDisplayTick,
  resolveSpeedMps,
  syncMapTracks,
} from '../lib/map-smooth';
import { loadSettings, saveSettings, DEFAULT_API_BASE_URL, type CoachSettings } from '../lib/settings';
import {
  gpsFixState,
  gpsStatusLabel,
  resolveGpsDisplayAge,
  displayGpsAgeSec,
} from '../lib/gps-age';

type Tab = 'live' | 'history' | 'settings';

type LiveDeviceRow = FleetDevice & {
  speedMps: number | null;
  displayName: string;
  colorIndex: number;
};

const ONLINE_SEC = 120;
const LS_MAP_FOLLOW = 'crewsight_map_follow_fleet';

function loadMapFollowPref(): boolean {
  try {
    return localStorage.getItem(LS_MAP_FOLLOW) !== '0';
  } catch {
    return true;
  }
}

function saveMapFollowPref(enabled: boolean) {
  try {
    localStorage.setItem(LS_MAP_FOLLOW, enabled ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Resolve static assets for web (/) and Capacitor (./). */
function asset(path: string): string {
  const clean = path.replace(/^\//, '');
  return `${import.meta.env.BASE_URL}${clean}`;
}

export function mountApp(root: HTMLElement): void {
  let settings = loadSettings();
  let tab: Tab = 'live';
  let monitoring = false;
  let serviceRunning = false;
  let devices: FleetDevice[] = [];
  let positions: MapPosition[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let map: L.Map | null = null;
  let markersLayer: L.LayerGroup | null = null;
  /** @type {Map<string, L.Marker>} */
  const markers = new Map<string, L.Marker>();
  /** When true, map pans/zooms to keep active devices in view. Toggle via Follow fleet button. */
  let mapFollowFleet = loadMapFollowPref();
  let mapTickUnsub: (() => void) | null = null;
  let historyPanel: HistoryPanel | null = null;

  const capsizeCount = () =>
    devices.filter((d) => d.rowing?.capsize || positions.some((p) => p.deviceId === d.deviceId && p.capsize)).length;

  async function refreshMonitoringStatus() {
    const st = await getNativeMonitoringStatus();
    monitoring = st.active;
    serviceRunning = st.serviceRunning;
  }

  async function pollLive() {
    if (!settings.apiBaseUrl) return;
    try {
      const [dev, pos] = await Promise.all([
        fetchDevices(settings),
        fetchMapPositions(settings),
      ]);
      devices = mergeCoachDevicesWithMap(dev, pos);
      positions = pos;
      syncMapTracks(pos);
      recordLiveSpeedSamples(pos);
      updateLivePanel();
      updateMap();
      setStatus(`Updated · ${devices.length} device(s)`, false);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  function mergeCoachDevicesWithMap(
    apiDevices: FleetDevice[],
    mapPositions: MapPosition[],
  ): FleetDevice[] {
    const mapById = new Map(mapPositions.map((p) => [p.deviceId, p]));
    const byId = new Map<string, FleetDevice>();
    for (const d of apiDevices) {
      const p = mapById.get(d.deviceId);
      byId.set(d.deviceId, {
        ...d,
        gpsAgeSec:
          d.gps?.displayAgeSec ??
          displayGpsAgeSec(d.gps?.ageSec, d.gps?.ingestAgoSec) ??
          p?.fixAgeSec ??
          d.gps?.ageSec ??
          undefined,
      });
    }
    for (const p of mapPositions) {
      if (!byId.has(p.deviceId)) {
        byId.set(p.deviceId, {
          deviceId: p.deviceId,
          online: true,
          lastSeenAgoSec: p.lastSeenAgoSec ?? p.fixAgeSec,
          gpsAgeSec: displayGpsAgeSec(p.fixAgeSec, p.lastSeenAgoSec) ?? p.fixAgeSec,
          rowing: {
            capsize: p.capsize,
            strokeRate: p.strokeRate ?? null,
            strokeRateValid: p.strokeRate != null,
          },
        });
      }
    }
    return [...byId.values()];
  }

  function setStatus(msg: string, err = false) {
    const el = root.querySelector('[data-poll-status]');
    if (el) {
      el.textContent = msg;
      el.classList.toggle('err', err);
    }
  }

  function destroyMap() {
    if (map) {
      map.remove();
      map = null;
      markersLayer = null;
      markers.clear();
    }
  }

  function ensureMap() {
    const el = root.querySelector('#coachMap') as HTMLElement | null;
    if (!el) return;
    if (map && map.getContainer() !== el) {
      destroyMap();
    }
    if (map) return;
    try {
      map = L.map(el, { preferCanvas: true }).setView([-37.93, 175.55], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
      map.on('dragstart', () => {
        if (!mapFollowFleet) return;
        mapFollowFleet = false;
        saveMapFollowPref(false);
        updateMapFollowButton();
      });
      map.on('zoomstart', (e: L.LeafletEvent) => {
        if (!e.originalEvent || !mapFollowFleet) return;
        mapFollowFleet = false;
        saveMapFollowPref(false);
        updateMapFollowButton();
      });
      setTimeout(() => map?.invalidateSize(), 150);
    } catch (e) {
      setStatus(
        `Map failed to load: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
  }

  function markerIcon(p: MapPosition, device?: FleetDevice): L.DivIcon {
    registerLiveDevice(p.deviceId);
    const gpsAge = resolveGpsDisplayAge(device, p);
    const cap = Boolean(p.capsize);
    const state = gpsFixState(gpsAge);
    const accent = liveDeviceColor(p.deviceId);
    const opacity = state === 'lost' ? 0.45 : state === 'amber' ? 0.75 : 1;
    const capRing = cap ? 'box-shadow:0 0 0 2px #ef4444;' : '';
    const className = cap ? 'coach-marker capsize' : 'coach-marker';
    return L.divIcon({
      className,
      html: `<span style="background:${accent};opacity:${opacity};${capRing}width:14px;height:14px;border-radius:50%;display:block;border:2px solid #fff"></span>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  function mapLatLngFor(p: MapPosition): L.LatLng {
    const display = displayLatLon(p.deviceId);
    if (display) return L.latLng(display.lat, display.lon);
    const lat = p.smoothLatitude ?? p.latitude;
    const lon = p.smoothLongitude ?? p.longitude;
    return L.latLng(lat, lon);
  }

  function activeMapLatLngs(): L.LatLng[] {
    const posById = new Map(positions.map((p) => [p.deviceId, p]));
    const latlngs: L.LatLng[] = [];
    for (const d of devices) {
      if (!d.online) continue;
      const p = posById.get(d.deviceId);
      if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
      const ago = d.lastSeenAgoSec ?? p.lastSeenAgoSec ?? p.fixAgeSec ?? 999;
      if (ago > ONLINE_SEC) continue;
      latlngs.push(mapLatLngFor(p));
    }
    return latlngs;
  }

  function expandBoundsMinSpan(bounds: L.LatLngBounds, minMeters: number): L.LatLngBounds {
    const center = bounds.getCenter();
    const ne = bounds.getNorthEast();
    if (center.distanceTo(ne) >= minMeters / 2) return bounds;
    const halfLat = minMeters / 2 / 111_320;
    const cosLat = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.2);
    const halfLng = minMeters / 2 / (111_320 * cosLat);
    return L.latLngBounds(
      [center.lat - halfLat, center.lng - halfLng],
      [center.lat + halfLat, center.lng + halfLng],
    );
  }

  function fleetOutsideMapInset(latlngs: L.LatLng[]): boolean {
    if (!map || latlngs.length === 0) return false;
    const view = map.getBounds();
    const latSpan = view.getNorth() - view.getSouth();
    const lngSpan = view.getEast() - view.getWest();
    const inset = L.latLngBounds(
      [view.getSouth() + latSpan * 0.15, view.getWest() + lngSpan * 0.15],
      [view.getNorth() - latSpan * 0.15, view.getEast() - lngSpan * 0.15],
    );
    return latlngs.some((ll) => !inset.contains(ll));
  }

  function fitMapToActiveDevices(latlngs: L.LatLng[]) {
    if (!map || latlngs.length === 0) return;
    if (latlngs.length === 1) {
      const zoom = Math.min(Math.max(map.getZoom(), 15), 17);
      map.setView(latlngs[0], zoom, { animate: true });
      return;
    }
    let bounds = L.latLngBounds(latlngs);
    bounds = expandBoundsMinSpan(bounds, 250);
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: true });
  }

  function followActiveDevicesOnMap() {
    if (!mapFollowFleet) return;
    const active = activeMapLatLngs();
    if (active.length === 0) return;
    if (active.length === 1) {
      fitMapToActiveDevices(active);
      return;
    }
    if (fleetOutsideMapInset(active)) fitMapToActiveDevices(active);
  }

  function updateMapFollowButton() {
    const btn = root.querySelector('[data-map-follow]') as HTMLButtonElement | null;
    if (!btn) return;
    btn.classList.toggle('coach-btn--active', mapFollowFleet);
    btn.setAttribute('aria-pressed', mapFollowFleet ? 'true' : 'false');
  }

  function updateMap() {
    ensureMap();
    if (!map || !markersLayer) return;
    const seen = new Set<string>();
    const latlngs: L.LatLng[] = [];
    const deviceById = new Map(devices.map((d) => [d.deviceId, d]));
    for (const p of positions) {
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
      seen.add(p.deviceId);
      const latlng = mapLatLngFor(p);
      latlngs.push(latlng);
      const icon = markerIcon(p, deviceById.get(p.deviceId));
      let m = markers.get(p.deviceId);
      if (m) {
        m.setLatLng(latlng);
        m.setIcon(icon);
      } else {
        m = L.marker(latlng, { icon }).bindPopup(p.deviceId);
        markersLayer.addLayer(m);
        markers.set(p.deviceId, m);
      }
    }
    for (const [id, m] of markers) {
      if (!seen.has(id)) {
        markersLayer.removeLayer(m);
        markers.delete(id);
      }
    }
    followActiveDevicesOnMap();
    setTimeout(() => map?.invalidateSize(), 100);
  }

  function deviceDisplayName(d: FleetDevice): string {
    const name = String(d.athleteId ?? '').trim();
    return name || d.deviceId;
  }

  function formatSpeedKmh(mps: number | null | undefined): string {
    if (mps == null || !Number.isFinite(mps) || mps < 0) return '—';
    return `${(mps * 3.6).toFixed(1)} km/h`;
  }

  function formatSpm(d: FleetDevice): string {
    if (d.rowing?.strokeRateValid && d.rowing.strokeRate != null) {
      return `${Math.round(d.rowing.strokeRate)} spm`;
    }
    return '— spm';
  }

  function activeLiveDevices(): LiveDeviceRow[] {
    const posById = new Map(positions.map((p) => [p.deviceId, p]));
    const rows: LiveDeviceRow[] = [];
    for (const d of devices) {
      if (!d.online) continue;
      const p = posById.get(d.deviceId);
      if (!p) continue;
      const ago = d.lastSeenAgoSec ?? p.lastSeenAgoSec ?? p.fixAgeSec ?? 999;
      if (ago > ONLINE_SEC) continue;
      rows.push({
        ...d,
        speedMps: resolveSpeedMps(p),
        displayName: deviceDisplayName(d),
        colorIndex: registerLiveDevice(d.deviceId),
      });
    }
    rows.sort((a, b) => (b.speedMps ?? -1) - (a.speedMps ?? -1));
    return rows;
  }

  function deviceCardHtml(d: LiveDeviceRow, expanded: boolean): string {
    const cap = Boolean(d.rowing?.capsize);
    const gpsAge = d.gpsAgeSec ?? resolveGpsDisplayAge(d);
    const gpsLabel = gpsAge == null ? 'GPS —' : gpsStatusLabel(gpsAge);
    const accent = liveDeviceColor(d.deviceId);
    const meta = monitoring
      ? `${d.online ? 'Online' : 'Offline'} · ${gpsLabel}`
      : `${d.online ? 'Online' : 'Offline'} · ${gpsLabel} · seen ${d.lastSeenAgoSec ?? '—'}s ago`;
    return `<li>
      <details class="device-card ${cap ? 'capsize' : ''}" data-device-id="${esc(d.deviceId)}" ${expanded ? 'open' : ''}>
        <summary class="device-card__summary">
          <span class="device-card__lead">
            <span class="device-card__dot" style="background:${accent}"></span>
            <span class="device-card__name">${esc(d.displayName)}</span>
            ${d.displayName !== d.deviceId ? `<span class="device-card__id-tag">${esc(d.deviceId)}</span>` : ''}
            ${cap ? '<span class="device-card__alert">CAPSIZE</span>' : ''}
          </span>
          <span class="device-card__head-stats">
            <span>${formatSpeedKmh(d.speedMps)}</span>
            <span>${formatSpm(d)}</span>
          </span>
        </summary>
        <div class="device-card__body">
          <div class="device-card__meta">${meta}</div>
        </div>
      </details>
    </li>`;
  }

  function expandedDeviceIds(): Set<string> {
    return new Set(
      [...root.querySelectorAll<HTMLDetailsElement>('details.device-card[open]')].map(
        (el) => el.dataset.deviceId ?? '',
      ).filter(Boolean),
    );
  }

  function updateLiveChart(activeIds: string[]): void {
    const canvas = root.querySelector('[data-live-speed-chart]') as HTMLCanvasElement | null;
    if (!canvas) return;
    const series = liveSpeedVsTimeSeries(activeIds);
    drawMultiSeriesChart(canvas, series, {
      title: 'Speed vs time (last 5 min)',
      xLabel: 'seconds',
      yLabel: 'km/h',
      yFormat: (v) => `${v.toFixed(0)}`,
    });
  }

  function updateLivePanel() {
    if (tab !== 'live') return;
    const caps = capsizeCount();
    const banner = root.querySelector('[data-capsize-banner]') as HTMLElement | null;
    if (banner) {
      banner.hidden = caps === 0;
      if (caps > 0) banner.textContent = `${caps} CAPSIZE — check crew now`;
    }
    const active = activeLiveDevices();
    const expanded = expandedDeviceIds();
    const list = root.querySelector('[data-device-list]');
    if (list) {
      list.innerHTML = active.length
        ? active.map((d) => deviceCardHtml(d, expanded.has(d.deviceId))).join('')
        : '<li class="device-list__empty">No active devices on the water</li>';
    }
    const countEl = root.querySelector('[data-active-count]');
    if (countEl) countEl.textContent = String(active.length);
    updateLiveChart(active.map((d) => d.deviceId));
  }

  async function onStartMonitoring() {
    settings = loadSettings();
    if (!settings.apiBaseUrl) {
      setStatus('Set API URL in Settings first', true);
      tab = 'settings';
      render();
      return;
    }
    if (IS_NATIVE) {
      await startNativeMonitoring(settings.apiBaseUrl, settings.ingestToken);
    }
    monitoring = true;
    serviceRunning = IS_NATIVE;
    startPollTimer();
    startMapTick();
    render();
    void pollLive();
  }

  async function onStopMonitoring() {
    if (IS_NATIVE) {
      await stopNativeMonitoring();
    }
    monitoring = false;
    serviceRunning = false;
    stopPollTimer();
    stopMapTick();
    clearMapTracks();
    clearLiveSpeedBuffers();
    render();
  }

  function startMapTick() {
    stopMapTick();
    mapTickUnsub = onMapDisplayTick((deviceId, lat, lon) => {
      const m = markers.get(deviceId);
      if (m) m.setLatLng([lat, lon]);
    });
  }

  function stopMapTick() {
    mapTickUnsub?.();
    mapTickUnsub = null;
  }

  function startPollTimer() {
    stopPollTimer();
    pollTimer = setInterval(() => void pollLive(), 1000);
  }

  function stopPollTimer() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function ensureHistoryPanel(): HistoryPanel {
    if (!historyPanel) {
      historyPanel = new HistoryPanel(
        () => loadSettings(),
        (msg, err) => setStatus(msg, err),
        () => {
          tab = 'history';
          render();
        },
      );
    }
    return historyPanel;
  }

  function render() {
    if (tab === 'live') destroyMap();
    const caps = capsizeCount();
    root.innerHTML = `
      <div class="coach-app">
        <header class="hub-topbar hub-topbar--manager">
          <div class="hub-topbar-inner">
            <div class="hub-topbar-brands">
              <img src="${asset('assets/crewsight/crewsight-logo-full-manager-color.png')}" alt="CrewSight Manager" class="hub-crewsight-logo hub-crewsight-logo--manager" width="200" height="200" />
            </div>
          </div>
        </header>
        <div class="capsize-banner" data-capsize-banner role="alert" ${caps > 0 ? '' : 'hidden'}>${caps > 0 ? `${caps} CAPSIZE — check crew now` : ''}</div>
        ${tab === 'live'
          ? `<div class="coach-monitor-bar ${monitoring ? 'monitoring' : ''}">
          <div class="status-line ${monitoring ? 'on' : ''}">
            ${monitoring
              ? serviceRunning
                ? '● Monitoring fleet (background active)'
                : '● Monitoring (foreground poll only)'
              : 'Monitoring off — no background alerts'}
          </div>
          ${monitoring
            ? `<button type="button" class="coach-btn coach-btn--danger" data-stop-monitor>Stop monitoring</button>`
            : `<button type="button" class="coach-btn coach-btn--primary" data-start-monitor>Start monitoring</button>`}
        </div>`
          : ''}
        <nav class="coach-tabs">
          <button type="button" class="coach-tab ${tab === 'live' ? 'active' : ''}" data-tab="live">Live</button>
          <button type="button" class="coach-tab ${tab === 'history' ? 'active' : ''}" data-tab="history">History</button>
          <button type="button" class="coach-tab ${tab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
        </nav>
        <section class="coach-panel" data-panel="live" ${tab === 'live' ? '' : 'hidden'}>
          <p class="poll-line" data-poll-status>—</p>
          <div class="coach-map-bar">
            <button type="button" class="coach-btn coach-btn--ghost ${mapFollowFleet ? 'coach-btn--active' : ''}" data-map-follow aria-pressed="${mapFollowFleet ? 'true' : 'false'}">Follow fleet</button>
          </div>
          <div id="coachMap" class="coach-map"></div>
          <div class="live-devices-section">
            <h2 class="live-devices__title">Active devices <span class="live-devices__count" data-active-count>0</span></h2>
            <ul class="device-list" data-device-list></ul>
          </div>
          <canvas class="live-speed-chart history-chart" data-live-speed-chart height="200"></canvas>
        </section>
        <section class="coach-panel coach-panel--history" data-panel="history" ${tab === 'history' ? '' : 'hidden'}>
          <div class="history-panel" data-history-track-root></div>
        </section>
        <section class="coach-panel" data-panel="settings" ${tab === 'settings' ? '' : 'hidden'}>
          <h2 class="coach-section-title">Connection</h2>
          <label class="coach-field">API base URL
            <input type="url" id="apiBase" value="${esc(settings.apiBaseUrl)}" placeholder="${esc(DEFAULT_API_BASE_URL)}" />
          </label>
          <label class="coach-field">Ingest token (Bearer)
            <input type="password" id="ingestToken" value="${esc(settings.ingestToken)}" autocomplete="off" />
          </label>
          <button type="button" class="coach-btn coach-btn--primary" data-save-settings>Save settings</button>
          <p class="poll-line">Same URL and token as the rower app / dashboard. Monitoring must be stopped to change URL safely.</p>
          <h2 class="coach-section-title">History</h2>
          <div class="history-setup" data-history-setup-root></div>
        </section>
      </div>`;

    root.querySelector('[data-map-follow]')?.addEventListener('click', () => {
      mapFollowFleet = !mapFollowFleet;
      saveMapFollowPref(mapFollowFleet);
      updateMapFollowButton();
      if (mapFollowFleet) followActiveDevicesOnMap();
    });
    root.querySelector('[data-start-monitor]')?.addEventListener('click', () => void onStartMonitoring());
    root.querySelector('[data-stop-monitor]')?.addEventListener('click', () => void onStopMonitoring());
    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = (btn as HTMLElement).dataset.tab as Tab;
        historyPanel?.prepareForRender(next);
        if (next === 'live') destroyMap();
        tab = next;
        render();
        if (tab === 'live') {
          ensureMap();
          updateMap();
        }
      });
    });
    root.querySelector('[data-save-settings]')?.addEventListener('click', () => {
      settings = {
        apiBaseUrl: (root.querySelector('#apiBase') as HTMLInputElement).value.trim(),
        ingestToken: (root.querySelector('#ingestToken') as HTMLInputElement).value.trim(),
      };
      saveSettings(settings);
      setStatus('Settings saved');
    });

    if (tab === 'history') {
      const trackRoot = root.querySelector('[data-history-track-root]') as HTMLElement | null;
      if (trackRoot) {
        const panel = ensureHistoryPanel();
        panel.mountTrack(trackRoot);
        panel.onHistoryTabShown();
      }
    }

    if (tab === 'settings') {
      const setupRoot = root.querySelector('[data-history-setup-root]') as HTMLElement | null;
      if (setupRoot) ensureHistoryPanel().mountSetup(setupRoot);
    }

    if (tab === 'live') {
      ensureMap();
      updateMap();
      updateLivePanel();
    }
  }

  void (async () => {
    await refreshMonitoringStatus();
    if (monitoring) {
      startPollTimer();
      startMapTick();
    }
    render();
    void pollLive();
  })();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && monitoring) void pollLive();
  });
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
