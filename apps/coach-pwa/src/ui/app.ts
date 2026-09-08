import '../styles.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { HistoryPanel } from './history-panel';
import { RacePanel } from './race-panel';
import { drawMultiSeriesChart } from '../lib/history-charts';
import {
  clearLiveSpeedBuffers,
  liveDeviceColor,
  liveSpeedVsTimeSeries,
  recordLiveSpeedSamples,
  registerLiveDevice,
} from '../lib/live-speed-buffer';
import {
  clearCapsizeAlert,
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
  resolveStrokeRate,
  syncMapTracks,
} from '../lib/map-smooth';
import { loadSettings, saveSettings, DEFAULT_API_BASE_URL, type CoachSettings } from '../lib/settings';
import {
  gpsFixState,
  gpsStatusLabel,
  isTelemetryStale,
  resolveGpsDisplayAge,
  displayGpsAgeSec,
} from '../lib/gps-age';
import {
  QUIET_HOURS_MESSAGE,
  isQuietHours,
  onQuietHoursChange,
} from '../lib/quiet-hours';

type Tab = 'live' | 'history' | 'race' | 'settings';

type LiveDeviceRow = FleetDevice & {
  speedMps: number | null;
  displayName: string;
  colorIndex: number;
  telemetryStale?: boolean;
  mapPosition?: MapPosition;
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
  let pollInFlight = false;
  let quietHoursActive = isQuietHours();
  let quietHoursUnsub: (() => void) | null = null;
  let map: L.Map | null = null;
  let markersLayer: L.LayerGroup | null = null;
  /** @type {Map<string, L.Marker>} */
  const markers = new Map<string, L.Marker>();
  /** When true, map pans/zooms to keep active devices in view. Toggle via Follow fleet button. */
  let mapFollowFleet = loadMapFollowPref();
  let mapTickUnsub: (() => void) | null = null;
  let historyPanel: HistoryPanel | null = null;
  let racePanel: RacePanel | null = null;
  /** Capsize alarm: beep + voice + beep, every 5s until cleared. */
  const CAPSIZE_ALARM_EVERY_MS = 5000;
  const CAPSIZE_ALARM_BEEP_MS = 400;
  const CAPSIZE_ALARM_GAIN = 0.9;
  const CAPSIZE_ALARM_PHRASE = 'Capsize alert';
  let capsizeAlarmTimer: ReturnType<typeof setInterval> | null = null;
  let capsizeAlarmCtx: AudioContext | null = null;
  let capsizeAlarmOscillators: OscillatorNode[] = [];
  let capsizeAlarmSeq = 0;
  let capsizeAlarmTimeouts: ReturnType<typeof setTimeout>[] = [];

  function shouldPollLive(): boolean {
    if (isQuietHours()) return false;
    if (!settings.apiBaseUrl) return false;
    return monitoring || tab === 'race';
  }

  function syncPollTimer() {
    if (shouldPollLive()) startPollTimer();
    else stopPollTimer();
  }

  const capsizeCount = () =>
    devices.filter((d) => d.rowing?.capsize || positions.some((p) => p.deviceId === d.deviceId && p.capsize)).length;

  function capsizedDevices(): FleetDevice[] {
    return devices.filter(
      (d) => d.rowing?.capsize || positions.some((p) => p.deviceId === d.deviceId && p.capsize),
    );
  }

  function capsizeBannerText(): string {
    const caps = capsizedDevices();
    const names = caps.map((d) => deviceDisplayName(d)).filter(Boolean);
    const namePart = names.length ? `: ${names.join(', ')}` : '';
    const n = caps.length || 1;
    return `${n} CAPSIZE${namePart} — check crew now. Stays until acknowledged.`;
  }

  function updateCapsizeBanner(): void {
    const caps = capsizedDevices();
    const banner = root.querySelector('[data-capsize-banner]') as HTMLElement | null;
    if (!banner) return;
    banner.hidden = caps.length === 0;
    const text = banner.querySelector('[data-capsize-text]');
    if (text) text.textContent = caps.length > 0 ? capsizeBannerText() : '';
  }

  function monitorStatusHtml(): string {
    if (quietHoursActive) return QUIET_HOURS_MESSAGE;
    if (monitoring) {
      return serviceRunning
        ? '● Monitoring fleet (background active)'
        : '● Monitoring (foreground poll only)';
    }
    return 'Monitoring off — no background alerts';
  }

  function monitorBarHtml(): string {
    const on = monitoring && !quietHoursActive;
    return (
      `<div class="coach-monitor-bar ${on ? 'monitoring' : ''}" data-monitor-bar>` +
      `<div class="status-line ${on ? 'on' : ''}">${monitorStatusHtml()}</div>` +
      (monitoring
        ? `<button type="button" class="coach-btn coach-btn--danger" data-stop-monitor>Stop monitoring</button>`
        : `<button type="button" class="coach-btn coach-btn--primary" data-start-monitor>Start monitoring</button>`) +
      `</div>`
    );
  }

  async function acknowledgeCapsizeAlerts() {
    try {
      await clearCapsizeAlert(settings);
      setStatus('Capsize alert acknowledged');
      await pollLive();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    }
  }

  function clearCapsizeAlarmTimeouts() {
    for (const id of capsizeAlarmTimeouts) clearTimeout(id);
    capsizeAlarmTimeouts = [];
  }

  function stopCapsizeAlarmSound() {
    clearCapsizeAlarmTimeouts();
    capsizeAlarmSeq += 1;
    try {
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    } catch {
      /* optional */
    }
    try {
      for (const osc of capsizeAlarmOscillators) {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
      }
      capsizeAlarmOscillators = [];
      if (capsizeAlarmCtx) {
        void capsizeAlarmCtx.close();
        capsizeAlarmCtx = null;
      }
    } catch {
      /* optional */
    }
  }

  function playCapsizeTone(ctx: AudioContext, seq: number) {
    if (seq !== capsizeAlarmSeq) return;
    try {
      if (ctx.state === 'closed') return;
      if (ctx.state === 'suspended') void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime;
      const durSec = CAPSIZE_ALARM_BEEP_MS / 1000;
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, start);
      gain.gain.setValueAtTime(CAPSIZE_ALARM_GAIN, start);
      gain.gain.setValueAtTime(CAPSIZE_ALARM_GAIN, start + durSec - 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + durSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + durSec);
      capsizeAlarmOscillators.push(osc);
      osc.onended = () => {
        capsizeAlarmOscillators = capsizeAlarmOscillators.filter((o) => o !== osc);
      };
    } catch {
      /* optional */
    }
  }

  function speakCapsizeAlert(seq: number, onDone?: () => void) {
    if (seq !== capsizeAlarmSeq) return;
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
      onDone?.();
      return;
    }
    try {
      const u = new SpeechSynthesisUtterance(CAPSIZE_ALARM_PHRASE);
      u.volume = 1;
      u.rate = 1.05;
      u.pitch = 1.05;
      u.onend = () => {
        if (seq === capsizeAlarmSeq) onDone?.();
      };
      u.onerror = () => {
        if (seq === capsizeAlarmSeq) onDone?.();
      };
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch {
      onDone?.();
    }
  }

  function playCapsizeAlarmCycle() {
    stopCapsizeAlarmSound();
    const seq = capsizeAlarmSeq;
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      capsizeAlarmCtx = audioCtx;
      playCapsizeTone(audioCtx, seq);
      const afterBeep = setTimeout(() => {
        if (seq !== capsizeAlarmSeq) return;
        speakCapsizeAlert(seq, () => {
          if (seq !== capsizeAlarmSeq) return;
          playCapsizeTone(audioCtx, seq);
        });
      }, CAPSIZE_ALARM_BEEP_MS + 100);
      capsizeAlarmTimeouts.push(afterBeep);
    } catch {
      /* Browsers may block audio until the user has interacted with the app. */
    }
  }

  function startCapsizeAlarmLoop() {
    if (capsizeAlarmTimer != null) return;
    playCapsizeAlarmCycle();
    capsizeAlarmTimer = setInterval(playCapsizeAlarmCycle, CAPSIZE_ALARM_EVERY_MS);
  }

  function stopCapsizeAlarmLoop() {
    if (capsizeAlarmTimer != null) {
      clearInterval(capsizeAlarmTimer);
      capsizeAlarmTimer = null;
    }
    stopCapsizeAlarmSound();
  }

  function syncCapsizeAlarm() {
    updateCapsizeBanner();
    if (capsizeCount() > 0) startCapsizeAlarmLoop();
    else stopCapsizeAlarmLoop();
  }

  async function refreshMonitoringStatus() {
    const st = await getNativeMonitoringStatus();
    monitoring = st.active;
    serviceRunning = st.serviceRunning;
  }

  async function pollLive() {
    if (isQuietHours()) {
      quietHoursActive = true;
      setStatus(QUIET_HOURS_MESSAGE);
      return;
    }
    if (!settings.apiBaseUrl || pollInFlight) return;
    pollInFlight = true;
    try {
      const settled = await Promise.allSettled([
        fetchDevices(settings),
        fetchMapPositions(settings),
      ]);
      const devResult = settled[0];
      const posResult = settled[1];
      const errors: string[] = [];

      const pos =
        posResult.status === 'fulfilled' ? posResult.value : ([] as MapPosition[]);
      if (posResult.status === 'rejected') {
        const msg =
          posResult.reason instanceof Error
            ? posResult.reason.message
            : String(posResult.reason);
        errors.push(`Map: ${msg}`);
      }

      let dev: FleetDevice[] = [];
      if (devResult.status === 'fulfilled') {
        dev = mergeCoachDevicesWithMap(devResult.value, pos);
      } else {
        const msg =
          devResult.reason instanceof Error
            ? devResult.reason.message
            : String(devResult.reason);
        errors.push(`Devices: ${msg}`);
        // Still show map markers if devices list failed.
        dev = mergeCoachDevicesWithMap([], pos);
      }

      devices = dev;
      positions = pos;
      syncMapTracks(pos);
      recordLiveSpeedSamples(pos);
      syncCapsizeAlarm();
      updateLivePanel();
      updateMap();
      racePanel?.processPositions(pos);

      if (errors.length && !pos.length && !dev.length) {
        const joined = errors.join(' · ');
        const network = /failed to fetch|networkerror|load failed|aborted|timeout/i.test(
          joined,
        );
        setStatus(
          network
            ? 'Failed to fetch — API timed out or unreachable (check ingest token / Vercel)'
            : joined,
          true,
        );
        return;
      }
      if (errors.length) {
        setStatus(
          `Partial update · ${devices.length} device(s) — ${errors.join(' · ')}`,
          true,
        );
        return;
      }
      setStatus(`Updated · ${devices.length} device(s)`, false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const network =
        /failed to fetch|networkerror|load failed|aborted/i.test(msg) ||
        (e instanceof TypeError && /fetch/i.test(msg));
      setStatus(
        network
          ? 'Failed to fetch — check API URL, ingest token, and Vercel (cold start / timeout)'
          : msg,
        true,
      );
    } finally {
      pollInFlight = false;
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
    const receiveAgo = device?.lastSeenAgoSec ?? p.lastSeenAgoSec ?? null;
    const stale = p.telemetryStale === true || isTelemetryStale(receiveAgo);
    const cap = Boolean(p.capsize);
    const state = gpsFixState(gpsAge);
    const accent = liveDeviceColor(p.deviceId);
    const opacity = state === 'lost' ? 0.45 : state === 'amber' ? 0.75 : 1;
    const capRing = cap ? 'box-shadow:0 0 0 2px #ef4444;' : '';
    const className = cap ? 'coach-marker capsize' : 'coach-marker';
    const staleFlag = stale
      ? `<span class="coach-marker-stale">Stale</span>`
      : '';
    return L.divIcon({
      className,
      html: `<span class="coach-marker-stack">${staleFlag}<span style="background:${accent};opacity:${opacity};${capRing}width:14px;height:14px;border-radius:50%;display:block;border:2px solid #fff"></span></span>`,
      iconSize: stale ? [52, 30] : [14, 14],
      iconAnchor: stale ? [26, 26] : [7, 7],
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

  function formatSpm(d: FleetDevice, p?: MapPosition): string {
    const spm =
      p != null
        ? resolveStrokeRate(p)
        : d.displayStrokeRate ?? d.rowing?.strokeRate ?? null;
    if (spm != null && Number.isFinite(spm) && spm > 0) {
      return `${Math.round(spm)} spm`;
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
      const stale = p.telemetryStale === true || isTelemetryStale(ago);
      rows.push({
        ...d,
        speedMps: stale ? null : resolveSpeedMps(p),
        displayName: deviceDisplayName(d),
        colorIndex: registerLiveDevice(d.deviceId),
        telemetryStale: stale,
        lastSeenAgoSec: ago,
        mapPosition: p,
      });
    }
    rows.sort((a, b) => (b.speedMps ?? -1) - (a.speedMps ?? -1));
    return rows;
  }

  function deviceCardHtml(d: LiveDeviceRow, expanded: boolean): string {
    const cap = Boolean(d.rowing?.capsize);
    const gpsAge = d.gpsAgeSec ?? resolveGpsDisplayAge(d);
    const gpsLabel = gpsAge == null ? 'GPS —' : gpsStatusLabel(gpsAge);
    const stale = Boolean(d.telemetryStale);
    const staleNote = stale
      ? ` · Stale — no data for ${d.lastSeenAgoSec ?? '?'}s`
      : '';
    const accent = liveDeviceColor(d.deviceId);
    const meta = monitoring
      ? `${d.online ? 'Online' : 'Offline'} · ${gpsLabel}${staleNote}`
      : `${d.online ? 'Online' : 'Offline'} · ${gpsLabel} · seen ${d.lastSeenAgoSec ?? '—'}s ago${staleNote}`;
    const speedValue =
      stale || d.speedMps == null || !Number.isFinite(d.speedMps) || d.speedMps < 0
        ? '—'
        : (d.speedMps * 3.6).toFixed(1);
    const spmRaw =
      d.mapPosition != null
        ? resolveStrokeRate(d.mapPosition)
        : d.displayStrokeRate ?? d.rowing?.strokeRate ?? null;
    const spmValue =
      stale || spmRaw == null || !Number.isFinite(spmRaw) || spmRaw <= 0
        ? '—'
        : String(Math.round(spmRaw));
    return `<li>
      <details class="device-card ${cap ? 'capsize' : ''}${stale ? ' device-card--stale' : ''}" data-device-id="${esc(d.deviceId)}" ${expanded ? 'open' : ''}>
        <summary class="device-card__summary">
          <span class="device-card__lead">
            <span class="device-card__dot" style="background:${accent}"></span>
            <span class="device-card__name">${esc(d.displayName)}</span>
            ${d.displayName !== d.deviceId ? `<span class="device-card__id-tag">${esc(d.deviceId)}</span>` : ''}
            ${stale ? '<span class="device-card__stale">Stale</span>' : ''}
            ${cap ? '<span class="device-card__alert">CAPSIZE</span>' : ''}
          </span>
          <span class="device-card__head-stats">
            <span class="device-card__stat">
              <span class="device-card__stat-value">${esc(speedValue)}</span>
              <span class="device-card__stat-label">km/h</span>
            </span>
            <span class="device-card__stat">
              <span class="device-card__stat-value">${esc(spmValue)}</span>
              <span class="device-card__stat-label">spm</span>
            </span>
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
    syncCapsizeAlarm();
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
    monitoring = true;
    if (isQuietHours()) {
      quietHoursActive = true;
      serviceRunning = false;
      stopPollTimer();
      stopMapTick();
      setStatus(QUIET_HOURS_MESSAGE);
      render();
      return;
    }
    if (IS_NATIVE) {
      await startNativeMonitoring(settings.apiBaseUrl, settings.ingestToken);
    }
    serviceRunning = IS_NATIVE;
    syncPollTimer();
    startMapTick();
    render();
    void pollLive();
  }

  async function applyQuietHours(paused: boolean) {
    quietHoursActive = paused;
    const banner = root.querySelector('[data-quiet-hours-banner]') as HTMLElement | null;
    if (banner) {
      banner.hidden = !paused;
      banner.setAttribute('aria-hidden', paused ? 'false' : 'true');
    }
    if (paused) {
      stopPollTimer();
      stopMapTick();
      if (IS_NATIVE && serviceRunning) {
        await stopNativeMonitoring();
        serviceRunning = false;
      }
      setStatus(QUIET_HOURS_MESSAGE);
      return;
    }
    if (!monitoring && tab !== 'race') return;
    settings = loadSettings();
    if (IS_NATIVE && settings.apiBaseUrl && monitoring) {
      await startNativeMonitoring(settings.apiBaseUrl, settings.ingestToken);
      serviceRunning = true;
    }
    syncPollTimer();
    if (monitoring) startMapTick();
    void pollLive();
  }

  async function onStopMonitoring() {
    if (IS_NATIVE) {
      await stopNativeMonitoring();
    }
    monitoring = false;
    serviceRunning = false;
    syncPollTimer();
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
    if (!shouldPollLive()) return;
    pollTimer = setInterval(() => void pollLive(), 2000);
  }

  function stopPollTimer() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function ensureRacePanel(): RacePanel {
    if (!racePanel) {
      racePanel = new RacePanel(
        () => loadSettings(),
        (msg, err) => setStatus(msg, err),
      );
    }
    return racePanel;
  }

  function ensureHistoryPanel(): HistoryPanel {
    if (!historyPanel) {
      historyPanel = new HistoryPanel(
        () => loadSettings(),
        (msg, err) => setStatus(msg, err),
        () => {
          historyPanel?.prepareForRender('history');
          tab = 'history';
          render();
        },
      );
    }
    return historyPanel;
  }

  function render() {
    destroyMap();
    const caps = capsizeCount();
    root.innerHTML = `
      <div class="coach-app">
        <header class="coach-topbar" aria-label="CrewSight Manager">
          <img
            src="${asset('assets/crewsight/crewsight-logo-icon-only-manager-color.png')}"
            alt=""
            class="coach-topbar__icon"
            width="40"
            height="40"
          />
          <div class="coach-topbar__text">
            <span class="coach-topbar__brand">CrewSight</span>
            <span class="coach-topbar__product">Manager</span>
          </div>
        </header>
        <div class="coach-sticky-chrome">
          <div
            class="quiet-hours-banner"
            data-quiet-hours-banner
            role="status"
            ${quietHoursActive ? '' : 'hidden'}
            aria-hidden="${quietHoursActive ? 'false' : 'true'}"
          >${QUIET_HOURS_MESSAGE}</div>
          <div class="capsize-banner" data-capsize-banner role="alert" ${caps > 0 ? '' : 'hidden'}>
            <span data-capsize-text>${caps > 0 ? capsizeBannerText() : ''}</span>
            <button type="button" class="capsize-banner__clear" data-capsize-clear>Acknowledge / clear</button>
          </div>
          ${monitorBarHtml()}
        </div>
        <section class="coach-panel" data-panel="live" ${tab === 'live' ? '' : 'hidden'}>
          <p class="poll-line" data-poll-status>—</p>
          <div class="live-devices-section">
            <h2 class="live-devices__title">Active devices <span class="live-devices__count" data-active-count>0</span></h2>
            <ul class="device-list" data-device-list></ul>
          </div>
          <div class="coach-map-bar">
            <button type="button" class="coach-btn coach-btn--ghost ${mapFollowFleet ? 'coach-btn--active' : ''}" data-map-follow aria-pressed="${mapFollowFleet ? 'true' : 'false'}">Follow fleet</button>
          </div>
          <div id="coachMap" class="coach-map"></div>
          <canvas class="live-speed-chart history-chart" data-live-speed-chart height="200"></canvas>
        </section>
        <section class="coach-panel coach-panel--race" data-panel="race" ${tab === 'race' ? '' : 'hidden'}>
          <p class="poll-line" data-poll-status>—</p>
          <div class="race-panel-root" data-race-root></div>
        </section>
        <section class="coach-panel coach-panel--history" data-panel="history" ${tab === 'history' ? '' : 'hidden'}>
          <h2 class="coach-section-title">Load session</h2>
          <div class="history-setup" data-history-setup-root></div>
          <h2 class="coach-section-title">Session review</h2>
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
        </section>
        <nav class="coach-tabs coach-tabs--bottom" aria-label="Manager sections">
          <button type="button" class="coach-tab coach-tab--live ${tab === 'live' ? 'active' : ''}" data-tab="live">Live</button>
          <button type="button" class="coach-tab ${tab === 'race' ? 'active' : ''}" data-tab="race">Race</button>
          <button type="button" class="coach-tab ${tab === 'history' ? 'active' : ''}" data-tab="history">History</button>
          <button type="button" class="coach-tab ${tab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
        </nav>
      </div>`;

    root.querySelector('[data-map-follow]')?.addEventListener('click', () => {
      mapFollowFleet = !mapFollowFleet;
      saveMapFollowPref(mapFollowFleet);
      updateMapFollowButton();
      if (mapFollowFleet) followActiveDevicesOnMap();
    });
    root.querySelector('[data-start-monitor]')?.addEventListener('click', () => void onStartMonitoring());
    root.querySelector('[data-stop-monitor]')?.addEventListener('click', () => void onStopMonitoring());
    root.querySelector('[data-capsize-clear]')?.addEventListener('click', () => void acknowledgeCapsizeAlerts());
    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = (btn as HTMLElement).dataset.tab as Tab;
        historyPanel?.prepareForRender(next);
        racePanel?.prepareForRender(next);
        tab = next;
        render();
        syncPollTimer();
        if (tab === 'live') {
          ensureMap();
          updateMap();
        }
        if (tab === 'race') {
          void pollLive();
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
      void ensureRacePanel().reloadLines();
    });

    if (tab === 'race') {
      const raceRoot = root.querySelector('[data-race-root]') as HTMLElement | null;
      if (raceRoot) {
        const panel = ensureRacePanel();
        panel.mount(raceRoot);
        panel.onTabShown();
        panel.processPositions(positions);
      }
    }

    if (tab === 'history') {
      const setupRoot = root.querySelector('[data-history-setup-root]') as HTMLElement | null;
      const trackRoot = root.querySelector('[data-history-track-root]') as HTMLElement | null;
      const panel = ensureHistoryPanel();
      if (setupRoot) panel.mountSetup(setupRoot);
      if (trackRoot) {
        panel.mountTrack(trackRoot);
        panel.onHistoryTabShown();
      }
    }

    if (tab === 'live') {
      ensureMap();
      updateMap();
      updateLivePanel();
    } else {
      syncCapsizeAlarm();
    }
  }

  quietHoursUnsub = onQuietHoursChange((paused) => {
    void applyQuietHours(paused).then(() => {
      render();
    });
  });

  void (async () => {
    await refreshMonitoringStatus();
    quietHoursActive = isQuietHours();
    if ((monitoring || tab === 'race') && !quietHoursActive) {
      syncPollTimer();
      if (monitoring) startMapTick();
      void pollLive();
    } else if (quietHoursActive) {
      stopPollTimer();
      stopMapTick();
      setStatus(QUIET_HOURS_MESSAGE);
    }
    render();
  })();

  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      shouldPollLive()
    ) {
      void pollLive();
    }
  });
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
