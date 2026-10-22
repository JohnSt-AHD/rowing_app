import '../styles.css';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ClubAdminPanel } from './club-admin-panel';
import { HistoryPanel } from './history-panel';
import { LiveDataPanel } from './live-data-panel';
import { LogbookPanel } from './logbook-panel';
import {
  clearLiveSpeedBuffers,
  liveDeviceColor,
  liveSpeedVsTimeSeries,
  recordLiveSpeedSamples,
  registerLiveDevice,
} from '../lib/live-speed-buffer';
import {
  clearCapsizeAlert,
  fetchCapsizeDayLog,
  fetchDevices,
  fetchFleetConfig,
  fetchMapPositions,
  type FleetCoach,
  type FleetDevice,
  type MapPosition,
} from '../lib/api';
import { isCoachDevice, managerDeviceId } from '../lib/coach-identity';
import {
  getCoachLocationStatus,
  syncCoachLocation,
  type CoachLocationStatus,
} from '../lib/coach-location';
import { formatSplit500 } from '../lib/course-format';
import { drawMultiSeriesChart, prognosticBandsKmh } from '../lib/history-charts';
import { parseBoatClass } from '@rowing/rowing-pace';
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
import {
  loadSettings,
  saveSettings,
  clampLocationIntervalMs,
  DEFAULT_API_BASE_URL,
  DEFAULT_LOCATION_INTERVAL_MS,
  type CoachSettings,
} from '../lib/settings';
import { demoMapPositions, isDemoMode } from '../lib/demo-mode';
import {
  acknowledgeCapsizeLog,
  formatCapsizeAckLine,
  formatNzTime,
  listCapsizeDayLog,
  markMissingCapsizesClearedRemote,
  replaceCapsizeDayLogForDemo,
  replaceCapsizeDayLogFromServer,
  upsertActiveCapsize,
} from '../lib/capsize-day-log';
import {
  demoGeofencesSnapshot,
  drawDemoGeofencesOnMap,
  loadDemoGeofences,
} from '../lib/demo-geofences';
import { bindInfoToggles } from '../lib/info-toggle';
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

type Tab = 'dashboard' | 'map' | 'live' | 'logbook' | 'history' | 'settings';

type CrewTicketRow = FleetDevice & {
  onWater: boolean;
  speedMps: number | null;
  displayName: string;
  colorIndex: number;
  telemetryStale?: boolean;
  mapPosition?: MapPosition;
};

const ONLINE_SEC = 120;
const LS_MAP_FOLLOW = 'crewsight_map_follow_fleet';
const LS_TICKET_SCOPE = 'crewsight_ticket_scope';

type TicketScope = 'all' | 'mine';

function loadTicketScope(): TicketScope {
  try {
    return localStorage.getItem(LS_TICKET_SCOPE) === 'mine' ? 'mine' : 'all';
  } catch {
    return 'all';
  }
}

function saveTicketScope(scope: TicketScope) {
  try {
    localStorage.setItem(LS_TICKET_SCOPE, scope);
  } catch {
    /* ignore */
  }
}

function normalizeCoachName(value?: string | null): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

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
  let tab: Tab = 'dashboard';
  let monitoring = isDemoMode();
  let serviceRunning = false;
  let devices: FleetDevice[] = [];
  let positions: MapPosition[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  let quietHoursActive = isQuietHours();
  let quietHoursUnsub: (() => void) | null = null;
  let map: L.Map | null = null;
  let markersLayer: L.LayerGroup | null = null;
  let geofenceLayer: L.LayerGroup | null = null;
  /** @type {Map<string, L.Marker>} */
  const markers = new Map<string, L.Marker>();
  /** When true, map pans/zooms to keep active devices in view. Toggle via Follow fleet button. */
  let mapFollowFleet = isDemoMode() ? false : loadMapFollowPref();
  /** Ticket / cycle lock — keep this device centred when set. */
  let followDeviceId: string | null = null;
  /** Home / map: all token boats, or this Manager’s athletes. Capsizes always stay visible. */
  let ticketScope: TicketScope = loadTicketScope();
  /** Follow fleet rotates through on-water crews. */
  let followCycleOn = false;
  let followCycleTimer: ReturnType<typeof setInterval> | null = null;
  const FOLLOW_CYCLE_MS = 8_000;
  let mapTickUnsub: (() => void) | null = null;
  let fleetCoaches: FleetCoach[] = [];
  let historyPanel: HistoryPanel | null = null;
  let liveDataPanel: LiveDataPanel | null = null;
  let logbookPanel: LogbookPanel | null = null;
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
  /** After Acknowledge, mute alarm briefly even if a stale sticky poll flickers. */
  let suppressCapsizeAlarmUntilMs = 0;
  /**
   * Local sticky latch: once Manager sees a tip, keep CAPSIZE until Acknowledge
   * even if the phone goes offline / drops out of map-positions.
   */
  const latchedCapsizeById = new Map<string, FleetDevice>();

  function shouldPollLive(): boolean {
    if (isQuietHours()) return false;
    if (!settings.apiBaseUrl) return false;
    return monitoring || tab === 'live' || tab === 'dashboard' || tab === 'map';
  }

  function syncPollTimer() {
    if (shouldPollLive()) startPollTimer();
    else stopPollTimer();
  }

  function deviceHasCapsize(d: FleetDevice, pos?: MapPosition[]): boolean {
    if (d.rowing?.capsize) return true;
    if (latchedCapsizeById.has(d.deviceId)) return true;
    const list = pos ?? positions;
    return list.some((p) => p.deviceId === d.deviceId && p.capsize);
  }

  function isOwnManagerDevice(d?: FleetDevice | null): boolean {
    if (!d) return false;
    const mine = managerDeviceId(settings.coachName);
    if (mine && d.deviceId === mine) return true;
    const coach = normalizeCoachName(settings.coachName);
    if (!coach) return false;
    if (isCoachDevice(d) && normalizeCoachName(d.coach) === coach) return true;
    if (isCoachDevice(d) && normalizeCoachName(d.athleteId) === coach) return true;
    return false;
  }

  function deviceCoachMatchesManager(d?: FleetDevice | null): boolean {
    const mine = normalizeCoachName(settings.coachName);
    if (!mine || !d) return false;
    return normalizeCoachName(d.coach) === mine;
  }

  /** My-crews filter. Capsizes on this token always pass so every Manager sees them. */
  function devicePassesScope(d?: FleetDevice | null, p?: MapPosition): boolean {
    if (Boolean(d && deviceHasCapsize(d)) || Boolean(p?.capsize)) return true;
    if (ticketScope === 'all') return true;
    if (!d) return false;
    if (isOwnManagerDevice(d)) return true;
    return deviceCoachMatchesManager(d);
  }

  function applyTicketScope<T extends FleetDevice>(rows: T[]): T[] {
    if (ticketScope === 'all') return rows;
    return rows.filter((row) => devicePassesScope(row, (row as CrewTicketRow).mapPosition));
  }

  /** Remember sticky tips from the latest poll (skipped during Acknowledge mute). */
  function latchCapsizeFromPoll(devs: FleetDevice[], pos: MapPosition[]): void {
    if (Date.now() < suppressCapsizeAlarmUntilMs) return;
    for (const d of devs) {
      if (!d.rowing?.capsize) continue;
      latchedCapsizeById.set(d.deviceId, {
        ...d,
        rowing: { ...(d.rowing || {}), capsize: true },
      });
    }
    for (const p of pos) {
      if (!p.capsize) continue;
      const prev = latchedCapsizeById.get(p.deviceId);
      if (prev) {
        latchedCapsizeById.set(p.deviceId, {
          ...prev,
          rowing: { ...(prev.rowing || {}), capsize: true },
        });
      } else {
        latchedCapsizeById.set(p.deviceId, {
          deviceId: p.deviceId,
          online: false,
          lastSeenAgoSec: p.lastSeenAgoSec ?? p.fixAgeSec,
          rowing: { capsize: true },
        });
      }
    }
  }

  /** Merge latched sticky devices into the fleet so banner/tickets survive disconnect. */
  function mergeLatchedCapsizeDevices(devs: FleetDevice[]): FleetDevice[] {
    if (Date.now() < suppressCapsizeAlarmUntilMs || latchedCapsizeById.size === 0) {
      return devs;
    }
    const byId = new Map(devs.map((d) => [d.deviceId, { ...d }]));
    for (const [id, latched] of latchedCapsizeById) {
      const cur = byId.get(id);
      if (cur) {
        byId.set(id, {
          ...cur,
          rowing: { ...(cur.rowing || {}), capsize: true },
        });
      } else {
        byId.set(id, {
          ...latched,
          rowing: { ...(latched.rowing || {}), capsize: true },
        });
      }
    }
    return [...byId.values()];
  }

  const capsizeCount = () => capsizedDevices().length;

  function capsizedDevices(): FleetDevice[] {
    const byId = new Map<string, FleetDevice>();
    for (const d of devices) {
      if (!deviceHasCapsize(d)) continue;
      byId.set(d.deviceId, {
        ...d,
        rowing: { ...(d.rowing || {}), capsize: true },
      });
    }
    for (const p of positions) {
      if (!p.capsize || byId.has(p.deviceId)) continue;
      const latched = latchedCapsizeById.get(p.deviceId);
      byId.set(p.deviceId, {
        ...(latched || {
          deviceId: p.deviceId,
          online: false,
          lastSeenAgoSec: p.lastSeenAgoSec ?? p.fixAgeSec,
        }),
        rowing: { capsize: true },
      });
    }
    if (Date.now() >= suppressCapsizeAlarmUntilMs) {
      for (const [id, latched] of latchedCapsizeById) {
        if (byId.has(id)) continue;
        byId.set(id, {
          ...latched,
          rowing: { ...(latched.rowing || {}), capsize: true },
        });
      }
    }
    return [...byId.values()];
  }

  function capsizeBannerText(): string {
    const caps = capsizedDevices();
    const names = caps.map((d) => deviceDisplayName(d)).filter(Boolean);
    const namePart = names.length ? `: ${names.join(', ')}` : '';
    const n = caps.length || 1;
    return `${n} CAPSIZE${namePart} — check crew now. Tap Acknowledge when help is on the way.`;
  }

  function updateCapsizeBanner(): void {
    const caps = capsizedDevices();
    const banner = root.querySelector('[data-capsize-banner]') as HTMLElement | null;
    if (!banner) return;
    banner.hidden = caps.length === 0;
    const text = banner.querySelector('[data-capsize-text]');
    if (text) text.textContent = caps.length > 0 ? capsizeBannerText() : '';
  }

  function monitorBarHtml(): string {
    const on = monitoring && !quietHoursActive;
    let statusInner: string;
    let helpHtml = '';
    if (quietHoursActive) {
      statusInner = `<span>${esc(QUIET_HOURS_MESSAGE)}</span>`;
    } else if (monitoring) {
      const label = serviceRunning
        ? '● Monitoring fleet (background active)'
        : '● Monitoring (foreground poll only)';
      statusInner = `<span>${esc(label)}</span>`;
    } else {
      statusInner = `
        <span>Monitoring off</span>
        <button type="button" class="info-btn" data-info-toggle aria-label="About monitoring off" aria-expanded="false">i</button>
      `;
      helpHtml =
        `<p class="info-help" hidden>No background alerts while monitoring is off. Start monitoring to receive capsize alerts when the app is in the background.</p>`;
    }
    return (
      `<div class="coach-monitor-bar ${on ? 'monitoring' : ''}" data-monitor-bar>` +
      `<div class="coach-monitor-bar__main">` +
      `<div class="status-line ${on ? 'on' : ''}">${statusInner}</div>` +
      (monitoring
        ? `<button type="button" class="coach-btn coach-btn--danger" data-stop-monitor>Stop monitoring</button>`
        : `<button type="button" class="coach-btn coach-btn--primary" data-start-monitor>Start monitoring</button>`) +
      `</div>` +
      helpHtml +
      `</div>`
    );
  }

  function topbarMonitoringBadge(): string {
    if (!monitoring || quietHoursActive) return '';
    return `<span class="coach-topbar__monitoring" aria-live="polite">Monitoring</span>`;
  }

  function managerAckName(): string {
    const name = String(settings.coachName || '').trim();
    return name || 'CrewSight Manager';
  }

  async function acknowledgeCapsizeAlerts() {
    stopCapsizeAlarmLoop();
    suppressCapsizeAlarmUntilMs = Date.now() + 60_000;
    latchedCapsizeById.clear();
    try {
      const ids = capsizedDevices().map((d) => d.deviceId);
      const ackedBy = managerAckName();
      acknowledgeCapsizeLog(ids, ackedBy, 'manager');
      const result = (await clearCapsizeAlert(settings, undefined, {
        ackedBy,
        ackSource: 'manager',
      })) as {
        helpNotified?: string[];
        cleared?: string[];
      };
      const helped = Array.isArray(result?.helpNotified) ? result.helpNotified.length : 0;
      setStatus(
        helped > 0
          ? `Acknowledged — help message sent to ${helped} crew device(s)`
          : 'Acknowledged — help message sent',
      );
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
    if (capsizeCount() > 0 && Date.now() >= suppressCapsizeAlarmUntilMs) {
      startCapsizeAlarmLoop();
    } else {
      stopCapsizeAlarmLoop();
    }
  }

  async function refreshMonitoringStatus() {
    if (isDemoMode()) {
      monitoring = true;
      serviceRunning = false;
      return;
    }
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
        fetchCapsizeDayLog(settings),
      ]);
      const devResult = settled[0];
      const posResult = settled[1];
      const logResult = settled[2];
      const errors: string[] = [];
      let usedServerLog = false;
      if (logResult.status === 'fulfilled' && logResult.value) {
        replaceCapsizeDayLogFromServer(logResult.value);
        usedServerLog = true;
      }

      // Keep last good map/devices on a failed poll so Lou (etc.) does not flash off.
      let pos: MapPosition[] = positions;
      if (posResult.status === 'fulfilled') {
        pos = posResult.value;
      } else {
        const msg =
          posResult.reason instanceof Error
            ? posResult.reason.message
            : String(posResult.reason);
        errors.push(`Map: ${msg}`);
      }

      let dev: FleetDevice[] = devices;
      if (devResult.status === 'fulfilled') {
        dev = mergeCoachDevicesWithMap(devResult.value, pos);
      } else {
        const msg =
          devResult.reason instanceof Error
            ? devResult.reason.message
            : String(devResult.reason);
        errors.push(`Devices: ${msg}`);
        // Keep prior fleet metadata; still merge any fresh map points.
        dev = mergeCoachDevicesWithMap(devices, pos);
      }

      latchCapsizeFromPoll(dev, pos);
      recordLiveSpeedSamples(pos);
      syncCapsizeDayLog(dev, pos, { skipRemoteClear: usedServerLog });
      // Stamp map markers from latch so offline tips stay visible after stale drop.
      if (Date.now() >= suppressCapsizeAlarmUntilMs && latchedCapsizeById.size) {
        pos = pos.map((p) =>
          latchedCapsizeById.has(p.deviceId) ? { ...p, capsize: true } : p,
        );
      }
      devices = mergeLatchedCapsizeDevices(dev);
      positions = pos;
      syncMapTracks(pos);
      syncCapsizeAlarm();
      updateDashboardPanel();
      updateMapPanelExtras();
      updateMap();
      liveDataPanel?.processPositions(pos);

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
      const rowing = { ...(d.rowing || {}) };
      if (p?.capsize) rowing.capsize = true;
      byId.set(d.deviceId, {
        ...d,
        rowing,
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
    const text = String(msg ?? '').trim();
    const show = Boolean(text) && text !== '—';
    root.querySelectorAll('[data-poll-status]').forEach((el) => {
      el.textContent = show ? text : '';
      el.classList.toggle('err', err && show);
      if (el instanceof HTMLElement) el.hidden = !show;
    });
  }

  function destroyMap() {
    if (map) {
      map.remove();
      map = null;
      markersLayer = null;
      geofenceLayer = null;
      markers.clear();
    }
  }

  function isTabletHome(): boolean {
    return typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 960px)').matches
      : false;
  }

  function visibleMapHost(): HTMLElement | null {
    const home = root.querySelector('#coachHomeMap') as HTMLElement | null;
    const tabMap = root.querySelector('#coachMap') as HTMLElement | null;
    if (tab === 'dashboard' && isTabletHome() && home) return home;
    if (tab === 'map' && tabMap) return tabMap;
    return null;
  }

  function ensureMap() {
    const el = visibleMapHost();
    if (!el) return;
    if (map && map.getContainer() !== el) {
      destroyMap();
    }
    if (map) return;
    try {
      map = L.map(el, { preferCanvas: !isDemoMode() }).setView([-37.93, 175.55], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
      if (isDemoMode()) {
        const paint = (list: ReturnType<typeof demoGeofencesSnapshot>) => {
          if (!map) return;
          geofenceLayer?.remove();
          try {
            geofenceLayer = drawDemoGeofencesOnMap(map, list);
          } catch (e) {
            setStatus(
              `Demo geofences failed: ${e instanceof Error ? e.message : String(e)}`,
              true,
            );
          }
        };
        paint(demoGeofencesSnapshot());
        void loadDemoGeofences().then(paint).catch(() => {
          /* snapshot already drawn */
        });
      }
      map.on('dragstart', () => {
        if (!mapFollowFleet && !followDeviceId) return;
        stopCrewFollow();
      });
      map.on('zoomstart', (e: L.LeafletEvent) => {
        if (!e.originalEvent || (!mapFollowFleet && !followDeviceId)) return;
        stopCrewFollow();
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
    const coach = isCoachDevice(p) || (device != null && isCoachDevice(device));
    const accent = coach ? '#f59e0b' : liveDeviceColor(p.deviceId);
    const opacity = state === 'lost' ? 0.45 : state === 'amber' ? 0.75 : 1;
    const capRing = cap ? 'box-shadow:0 0 0 2px #ef4444;' : '';
    const shape = coach
      ? 'width:12px;height:12px;transform:rotate(45deg);border-radius:2px;'
      : 'width:14px;height:14px;border-radius:50%;';
    const className = cap ? 'coach-marker capsize' : coach ? 'coach-marker coach-marker--launch' : 'coach-marker';
    const staleFlag = stale
      ? `<span class="coach-marker-stale">Stale</span>`
      : '';
    return L.divIcon({
      className,
      html: `<span class="coach-marker-stack">${staleFlag}<span style="background:${accent};opacity:${opacity};${capRing}${shape}display:block;border:2px solid #fff"></span></span>`,
      iconSize: stale ? [52, 30] : coach ? [16, 16] : [14, 14],
      iconAnchor: stale ? [26, 26] : coach ? [8, 8] : [7, 7],
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
      if (!devicePassesScope(d, p)) continue;
      const ago = d.lastSeenAgoSec ?? p.lastSeenAgoSec;
      if (ago != null && Number.isFinite(ago) && ago > ONLINE_SEC) continue;
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

  function capsizeMapLatLngs(): L.LatLng[] {
    const out: L.LatLng[] = [];
    const posById = new Map(positions.map((p) => [p.deviceId, p]));
    for (const d of capsizedDevices()) {
      const p = posById.get(d.deviceId);
      if (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
        out.push(mapLatLngFor(p));
      }
    }
    return out;
  }

  function followableCrewIds(): string[] {
    return crewTicketRows()
      .filter((r) => r.onWater && !isCoachDevice(r) && r.mapPosition)
      .map((r) => r.deviceId);
  }

  function followSingleDeviceOnMap(deviceId: string, force: boolean) {
    if (!map) return;
    const p = positions.find((row) => row.deviceId === deviceId);
    if (!p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
    const ll = mapLatLngFor(p);
    if (!force && !fleetOutsideMapInset([ll])) return;
    const zoom = Math.min(Math.max(map.getZoom(), 16), 17);
    map.setView(ll, zoom, { animate: true });
    const marker = markers.get(deviceId);
    if (force && marker) marker.openPopup();
  }

  function stopFollowCycle() {
    if (followCycleTimer) {
      clearInterval(followCycleTimer);
      followCycleTimer = null;
    }
    followCycleOn = false;
  }

  function startFollowCycle() {
    stopFollowCycle();
    followCycleOn = true;
    mapFollowFleet = true;
    saveMapFollowPref(true);
    const ids = followableCrewIds();
    if (!ids.length) {
      followDeviceId = null;
      followActiveDevicesOnMap();
      updateMapFollowButton();
      return;
    }
    if (!followDeviceId || !ids.includes(followDeviceId)) followDeviceId = ids[0];
    followSingleDeviceOnMap(followDeviceId, true);
    followCycleTimer = setInterval(() => {
      const list = followableCrewIds();
      if (!list.length) return;
      const i = list.indexOf(followDeviceId || '');
      followDeviceId = list[(i + 1 + list.length) % list.length];
      followSingleDeviceOnMap(followDeviceId, true);
      updateTicketFollowUi();
      updateMapFollowButton();
    }, FOLLOW_CYCLE_MS);
    updateTicketFollowUi();
    updateMapFollowButton();
  }

  function stopCrewFollow() {
    stopFollowCycle();
    followDeviceId = null;
    mapFollowFleet = false;
    saveMapFollowPref(false);
    updateMapFollowButton();
    updateTicketFollowUi();
  }

  function onTicketFollow(deviceId: string) {
    if (followDeviceId === deviceId && !followCycleOn) {
      stopCrewFollow();
      return;
    }
    stopFollowCycle();
    mapFollowFleet = false;
    saveMapFollowPref(false);
    followDeviceId = deviceId;
    followSingleDeviceOnMap(deviceId, true);
    updateMapFollowButton();
    updateTicketFollowUi();
  }

  function followActiveDevicesOnMap() {
    const caps = capsizeMapLatLngs();
    if (caps.length && !followDeviceId) {
      fitMapToActiveDevices(caps);
      return;
    }
    if (followDeviceId) {
      followSingleDeviceOnMap(followDeviceId, false);
      return;
    }
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
    root.querySelectorAll('[data-map-follow]').forEach((el) => {
      const btn = el as HTMLButtonElement;
      const following = mapFollowFleet || Boolean(followDeviceId);
      btn.classList.toggle('coach-btn--active', following);
      btn.setAttribute('aria-pressed', following ? 'true' : 'false');
      if (followCycleOn) btn.textContent = 'Follow fleet';
      else if (followDeviceId) btn.textContent = 'Following';
      else btn.textContent = 'Follow fleet';
    });
  }

  function updateTicketFollowUi() {
    root.querySelectorAll<HTMLElement>('.crew-ticket[data-device-id]').forEach((el) => {
      el.classList.toggle('crew-ticket--follow', el.dataset.deviceId === followDeviceId);
    });
  }

  function updateMap() {
    ensureMap();
    if (!map || !markersLayer) return;
    const seen = new Set<string>();
    const latlngs: L.LatLng[] = [];
    const deviceById = new Map(devices.map((d) => [d.deviceId, d]));
    for (const p of positions) {
      if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
      const d = deviceById.get(p.deviceId);
      if (!devicePassesScope(d, p)) continue;
      seen.add(p.deviceId);
      const latlng = mapLatLngFor(p);
      latlngs.push(latlng);
      const icon = markerIcon(p, deviceById.get(p.deviceId));
      let m = markers.get(p.deviceId);
      if (m) {
        m.setLatLng(latlng);
        m.setIcon(icon);
      } else {
        const popupLabel = isCoachDevice(p) || (deviceById.get(p.deviceId) && isCoachDevice(deviceById.get(p.deviceId)!))
          ? `${p.deviceId}<br><span class="map-popup-coach">Coach / Manager</span>`
          : p.deviceId;
        m = L.marker(latlng, { icon }).bindPopup(popupLabel);
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
    // Always prefer device identity (recorder Name = deviceId). Walk-up may set rower name.
    const name = String(d.name ?? '').trim();
    return name || d.deviceId;
  }

  function deviceCrewDetailLine(d: FleetDevice): string {
    const parts: string[] = [];
    const title = deviceDisplayName(d);
    const coach = String(d.coach ?? '').trim();
    const athlete = String(d.athleteId ?? '').trim();
    const boatName = String(d.boatName ?? '').trim();
    // Outing boat class is optional — fall back to class encoded in device id (e.g. W1x Emma).
    const boatClass =
      String(d.boatClass ?? '').trim() ||
      parseBoatClass(d.boatClass, d.deviceId, d.name) ||
      '';
    if (coach && coach !== title) parts.push(`Coach ${coach}`);
    if (athlete && athlete !== title && athlete !== coach) {
      parts.push(`Athlete ${athlete}`);
    }
    if (boatName && boatName !== title) parts.push(boatName);
    if (boatClass && boatClass.toLowerCase() !== 'coach') parts.push(boatClass);
    return parts.join(' · ');
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

  function isDeviceOnWater(d: FleetDevice, p?: MapPosition): boolean {
    // Sticky CAPSIZE stays on-water even when the phone dies underwater / goes offline.
    if (deviceHasCapsize(d) || p?.capsize) return true;
    if (d.noGps && d.online) return true;
    if (!d.online) return false;
    // Use ingest/receive age only — GPS fix clock age can spike and flicker tickets.
    const ago = d.lastSeenAgoSec ?? p?.lastSeenAgoSec;
    if (ago != null && Number.isFinite(ago)) return ago <= ONLINE_SEC;
    // Online but age missing: still on water if we have a map fix.
    if (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) return true;
    return false;
  }

  function crewTicketRows(): CrewTicketRow[] {
    const posById = new Map(positions.map((p) => [p.deviceId, p]));
    const rows: CrewTicketRow[] = [];
    for (const d of devices) {
      const p = posById.get(d.deviceId);
      const cap = deviceHasCapsize(d) || Boolean(p?.capsize);
      const onWater = isDeviceOnWater(d, p);
      const ago = d.lastSeenAgoSec ?? p?.lastSeenAgoSec ?? p?.fixAgeSec ?? null;
      const stale =
        p != null && (p.telemetryStale === true || isTelemetryStale(ago));
      rows.push({
        ...d,
        rowing: cap ? { ...(d.rowing || {}), capsize: true } : d.rowing,
        onWater,
        // Keep speed on tickets even when outing identity is missing; mark stale in meta.
        speedMps: onWater && p ? resolveSpeedMps(p) : null,
        displayName: deviceDisplayName(d),
        colorIndex: registerLiveDevice(d.deviceId),
        telemetryStale: stale,
        lastSeenAgoSec: ago ?? undefined,
        mapPosition: p,
      });
    }
    rows.sort((a, b) => {
      const capA = Boolean(a.rowing?.capsize);
      const capB = Boolean(b.rowing?.capsize);
      // Capsize first — phone may already be offline / underwater.
      if (capA !== capB) return capA ? -1 : 1;
      if (a.onWater !== b.onWater) return a.onWater ? -1 : 1;
      return (b.speedMps ?? -1) - (a.speedMps ?? -1) || a.displayName.localeCompare(b.displayName);
    });
    return applyTicketScope(rows);
  }

  function crewTicketHtml(d: CrewTicketRow): string {
    const cap = Boolean(d.rowing?.capsize);
    const accent = liveDeviceColor(d.deviceId);
    const split = d.onWater ? formatSplit500(d.speedMps) : '—';
    const speed = d.onWater && split !== '—' ? `${split} /500m` : null;
    const spm =
      d.onWater && d.mapPosition
        ? (() => {
            const v = resolveStrokeRate(d.mapPosition!);
            return v != null && v > 0 ? `${Math.round(v)} spm` : null;
          })()
        : null;
    const coach = isCoachDevice(d);
    const statusClass = cap
      ? 'crew-ticket__badge--capsize'
      : coach
        ? 'crew-ticket__badge--coach'
        : d.onWater
          ? 'crew-ticket__badge--water'
          : 'crew-ticket__badge--ashore';
    const statusLabel = cap ? 'Capsize' : coach ? 'Coach' : d.onWater ? 'On water' : 'Ashore';
    const ticketClass = [
      'crew-ticket',
      coach ? 'crew-ticket--coach' : d.onWater ? 'crew-ticket--water' : 'crew-ticket--ashore',
      cap ? 'crew-ticket--capsize' : '',
      d.deviceId === followDeviceId ? 'crew-ticket--follow' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const meta = d.onWater
      ? d.noGps
        ? 'No GPS · logbook check-in'
        : d.telemetryStale
          ? `Stale · seen ${formatRelativeAgo(d.lastSeenAgoSec)}`
          : gpsStatusLabel(d.gpsAgeSec ?? resolveGpsDisplayAge(d, d.mapPosition))
      : d.lastSeenAgoSec != null
        ? `Last seen ${formatRelativeAgo(d.lastSeenAgoSec)}`
        : 'Offline';
    const crewLine = deviceCrewDetailLine(d);
    // Always keep device id visible when the title is a rower/walk-up name.
    const showDeviceId = d.displayName !== d.deviceId;
    // Show speed when known even without coach/boat outing fields.
    const speedMpsFallback =
      d.onWater && !d.noGps && d.speedMps == null && d.mapPosition
        ? resolveSpeedMps(d.mapPosition)
        : null;
    const fallbackSplit = formatSplit500(speedMpsFallback);
    const speedShown = speed || (fallbackSplit !== '—' ? `${fallbackSplit} /500m` : null);
    return (
      `<li class="${ticketClass}" data-device-id="${esc(d.deviceId)}" role="button" tabindex="0" title="Follow ${esc(d.displayName)} on the map">` +
      `<span class="crew-ticket__dot" style="background:${accent}" aria-hidden="true"></span>` +
      `<div class="crew-ticket__body">` +
      `<div class="crew-ticket__name">${esc(d.displayName)}</div>` +
      (showDeviceId ? `<div class="crew-ticket__id">${esc(d.deviceId)}</div>` : '') +
      (crewLine ? `<div class="crew-ticket__crew">${esc(crewLine)}</div>` : '') +
      `<div class="crew-ticket__meta">${esc(meta)}</div>` +
      `</div>` +
      `<div class="crew-ticket__status">` +
      `<span class="crew-ticket__badge ${statusClass}">${statusLabel}</span>` +
      (d.onWater && !d.noGps && (speedShown || spm)
        ? `<div class="crew-ticket__stats">${[speedShown, spm].filter(Boolean).map((x) => esc(x!)).join(' · ')}</div>`
        : d.onWater && d.noGps
          ? `<div class="crew-ticket__stats">No GPS</div>`
          : d.onWater
            ? `<div class="crew-ticket__stats">Live</div>`
            : '') +
      `</div>` +
      `</li>`
    );
  }

  function updateDashboardPanel() {
    if (tab !== 'dashboard') return;
    syncCapsizeAlarm();
    const rows = crewTicketRows();
    const coaches = rows.filter((r) => isCoachDevice(r) && r.onWater);
    const onWater = rows.filter((r) => r.onWater && !isCoachDevice(r));
    const ashore = rows.filter((r) => !r.onWater && !isCoachDevice(r));
    const onEl = root.querySelector('[data-on-water-count]');
    const totalEl = root.querySelector('[data-fleet-count]');
    if (onEl) onEl.textContent = String(onWater.length);
    if (totalEl) totalEl.textContent = String(rows.filter((r) => !isCoachDevice(r)).length);
    const mapCount = root.querySelector('[data-map-active-count]');
    if (mapCount) mapCount.textContent = String(onWater.length);

    const waterList = root.querySelector('[data-ticket-on-water]');
    if (waterList) {
      const listed = [...coaches, ...onWater];
      waterList.innerHTML = listed.length
        ? listed.map((d) => crewTicketHtml(d)).join('')
        : '<li class="crew-ticket__empty">No crews on the water</li>';
    }
    const ashoreList = root.querySelector('[data-ticket-ashore]');
    if (ashoreList) {
      ashoreList.innerHTML = ashore.length
        ? ashore.map((d) => crewTicketHtml(d)).join('')
        : rows.length
          ? ''
          : '<li class="crew-ticket__empty">No devices on the system</li>';
    }
    const ashoreSection = root.querySelector('[data-ashore-section]') as HTMLElement | null;
    if (ashoreSection) ashoreSection.hidden = ashore.length === 0;
    updateHomeCapsizeUi();
    updateHomeChart(onWater);
    if (isTabletHome()) {
      ensureMap();
      updateMap();
    }
  }

  function syncCapsizeDayLog(
    devs: FleetDevice[],
    pos: MapPosition[],
    opts: { skipRemoteClear?: boolean } = {},
  ): void {
    const posById = new Map(pos.map((p) => [p.deviceId, p]));
    const activeIds: string[] = [];
    const seen = new Set<string>();
    const consider = (id: string, name: string, p?: MapPosition) => {
      if (seen.has(id)) return;
      seen.add(id);
      activeIds.push(id);
      upsertActiveCapsize({
        deviceId: id,
        name,
        lat: p?.latitude,
        lon: p?.longitude,
      });
    };
    for (const d of devs) {
      if (!deviceHasCapsize(d, pos)) continue;
      consider(d.deviceId, deviceDisplayName(d), posById.get(d.deviceId));
    }
    for (const p of pos) {
      if (!p.capsize) continue;
      consider(p.deviceId, p.deviceId, p);
    }
    if (!opts.skipRemoteClear) markMissingCapsizesClearedRemote(activeIds);
  }

  function updateHomeCapsizeUi(): void {
    const card = root.querySelector('[data-home-capsize]') as HTMLElement | null;
    const detail = root.querySelector('[data-home-capsize-detail]');
    const logEl = root.querySelector('[data-capsize-log]');
    const caps = capsizedDevices();
    const posById = new Map(positions.map((p) => [p.deviceId, p]));
    if (card) {
      card.hidden = caps.length === 0;
      if (detail && caps.length) {
        const lines = caps.map((d) => {
          const p = posById.get(d.deviceId);
          const when = formatNzTime(p?.fixMs || Date.now());
          const loc =
            p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)
              ? `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`
              : 'No GPS';
          return `${deviceDisplayName(d)} · ${when} · ${loc} · not acknowledged`;
        });
        detail.textContent = lines.join('\n');
      }
    }
    if (logEl) {
      const entries = listCapsizeDayLog();
      logEl.innerHTML = entries.length
        ? entries
            .map((e) => {
              const loc =
                e.lat != null && e.lon != null
                  ? `${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`
                  : 'No GPS';
              const ack = formatCapsizeAckLine(e);
              return (
                `<li class="home-capsize-log__item home-capsize-log__item--${e.status}">` +
                `<strong>${esc(e.name)}</strong>` +
                `<span>${esc(formatNzTime(e.startedAt))} · ${esc(loc)}</span>` +
                `<span>${esc(ack)}</span>` +
                `</li>`
              );
            })
            .join('')
        : '<li class="home-capsize-log__empty">No capsizes today</li>';
    }
  }

  function updateHomeChart(onWater: CrewTicketRow[]): void {
    const canvas = root.querySelector('[data-home-speed-chart]') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ids = onWater.filter((r) => !r.noGps).map((r) => r.deviceId);
    const series = liveSpeedVsTimeSeries(ids).map((s) => {
      const row = onWater.find((r) => r.deviceId === s.id);
      return { ...s, label: row?.displayName || s.label };
    });
    const classes = [
      ...new Set(
        onWater
          .map((r) => String(r.boatClass ?? '').trim() || parseBoatClass(r.boatClass, r.deviceId, r.name) || '')
          .filter(Boolean),
      ),
    ];
    const bands =
      classes.length === 1
        ? prognosticBandsKmh(classes[0])
        : classes.flatMap((c) => prognosticBandsKmh(c)).filter((b, i, all) => all.findIndex((x) => x.pct === b.pct && Math.abs(x.y - b.y) < 0.05) === i);
    const subtitle = series.length
      ? classes.length > 1
        ? 'Active boats · mixed boat-class bands'
        : classes[0]
          ? `${classes[0]} prognostic bands`
          : 'No boat class — bands unavailable'
      : 'Waiting for on-water GPS';
    drawMultiSeriesChart(canvas, series, {
      title: 'Speed vs time',
      xLabel: 'seconds',
      yLabel: 'km/h',
      yFormat: (v) => `${v.toFixed(0)}`,
      theme: 'recorder',
      prognosticBands: bands,
      subtitle,
    });
  }

  function updateMapPanelExtras() {
    if (tab !== 'map') return;
    const active = crewTicketRows().filter((r) => r.onWater && !isCoachDevice(r));
    const countEl = root.querySelector('[data-map-active-count]');
    if (countEl) countEl.textContent = String(active.length);
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
    if (!monitoring && tab !== 'live' && tab !== 'dashboard' && tab !== 'map') return;
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
    stopFollowCycle();
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
      if (followDeviceId === deviceId && !capsizeMapLatLngs().length) {
        followSingleDeviceOnMap(deviceId, false);
      }
    });
  }

  function stopMapTick() {
    mapTickUnsub?.();
    mapTickUnsub = null;
  }

  function startPollTimer() {
    stopPollTimer();
    if (!shouldPollLive()) return;
    // 1s poll so sticky capsize alerts show on Manager soon after ingest.
    pollTimer = setInterval(() => void pollLive(), 1000);
  }

  function stopPollTimer() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function ensureLiveDataPanel(): LiveDataPanel {
    if (!liveDataPanel) {
      liveDataPanel = new LiveDataPanel(
        () => loadSettings(),
        (msg, err) => setStatus(msg, err),
      );
    }
    return liveDataPanel;
  }

  function ensureLogbookPanel(): LogbookPanel {
    if (!logbookPanel) {
      logbookPanel = new LogbookPanel(
        () => loadSettings(),
        (msg, err) => setStatus(msg, err),
      );
    }
    return logbookPanel;
  }

  function ensureHistoryPanel(): HistoryPanel {
    if (!historyPanel) {
      historyPanel = new HistoryPanel(
        () => loadSettings(),
        (msg, err) => setStatus(msg, err),
      );
    }
    return historyPanel;
  }

  function coachSelectHtml(s: CoachSettings, coaches: FleetCoach[]): string {
    const opts = ['<option value="">— select coach —</option>'];
    let found = false;
    for (const c of coaches) {
      const sel = c.id === s.coachId ? ' selected' : '';
      if (c.id === s.coachId) found = true;
      opts.push(`<option value="${esc(c.id)}"${sel}>${esc(c.name)}</option>`);
    }
    if (s.coachId && !found) {
      opts.push(
        `<option value="${esc(s.coachId)}" selected>${esc(s.coachName || s.coachId)}</option>`,
      );
    }
    return `<select id="coachId" aria-label="Coach">${opts.join('')}</select>`;
  }

  function locationStatusLabel(status: CoachLocationStatus, s: CoachSettings): string {
    if (isDemoMode()) return 'Demo — Coach Tom is shown live on the map.';
    if (!s.coachName.trim()) return 'Select a coach to share this tablet on RowSafe.';
    if (!s.shareLocation) return 'Location sharing is off.';
    if (!s.ingestToken.trim()) return 'Save the ingest password to start sharing location.';
    if (status.lastError) return status.lastError;
    if (status.lastOkMs) {
      const ago = Math.max(0, Math.round((Date.now() - status.lastOkMs) / 1000));
      return `Sharing as ${status.deviceId || s.coachName} · last upload ${ago}s ago`;
    }
    if (status.running) return `Sharing as ${status.deviceId || s.coachName} · waiting for GPS…`;
    return 'Location sharing is ready — save settings to start.';
  }

  function updateLocationStatusLine(status: CoachLocationStatus): void {
    const el = root.querySelector('[data-location-status]');
    if (el) el.textContent = locationStatusLabel(status, settings);
  }

  function readSettingsFromForm(): CoachSettings {
    const coachId = (root.querySelector('#coachId') as HTMLSelectElement | null)?.value.trim() ?? '';
    const coach = fleetCoaches.find((c) => c.id === coachId);
    const share = (root.querySelector('#shareLocation') as HTMLInputElement | null)?.checked ?? true;
    const sec = Number((root.querySelector('#locationIntervalSec') as HTMLInputElement | null)?.value);
    const intervalMs = clampLocationIntervalMs(
      Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_LOCATION_INTERVAL_MS,
    );
    return {
      apiBaseUrl: (root.querySelector('#apiBase') as HTMLInputElement).value.trim(),
      ingestToken: (root.querySelector('#ingestToken') as HTMLInputElement).value.trim(),
      coachId,
      coachName: coach?.name || settings.coachName,
      shareLocation: share,
      locationIntervalMs: intervalMs,
    };
  }

  async function refreshFleetCoaches(): Promise<void> {
    try {
      const cfg = await fetchFleetConfig(settings);
      fleetCoaches = cfg.coaches ?? [];
    } catch {
      fleetCoaches = [];
    }
  }

  let clubAdminPanel: ClubAdminPanel | null = null;
  function ensureClubAdminPanel(): ClubAdminPanel {
    if (!clubAdminPanel) {
      clubAdminPanel = new ClubAdminPanel(
        () => loadSettings(),
        (msg, err) => setStatus(msg, err),
      );
    }
    return clubAdminPanel;
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
            width="97"
            height="97"
          />
          <div class="coach-topbar__text">
            <span class="coach-topbar__brand">CrewSight</span>
            <div class="coach-topbar__title-row">
              <span class="coach-topbar__product">Manager</span>
              ${topbarMonitoringBadge()}
              ${isDemoMode() ? '<span class="coach-demo-pill">Demo</span>' : ''}
            </div>
          </div>
          <nav class="coach-topbar__nav" aria-label="Settings">
            <button
              type="button"
              class="coach-topbar__nav-btn ${tab === 'settings' ? 'is-active' : ''}"
              data-tab="settings"
              aria-pressed="${tab === 'settings' ? 'true' : 'false'}"
              aria-label="Settings"
              title="Settings"
            >
              <svg class="coach-topbar__nav-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.25.42.49.42h3.8c.24 0 .44-.18.49-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>
              </svg>
              <span class="coach-topbar__nav-label">Settings</span>
            </button>
          </nav>
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
            <button type="button" class="capsize-banner__clear" data-capsize-clear>Acknowledge — notify crew</button>
          </div>
        </div>
        <section class="coach-panel coach-panel--dashboard" data-panel="dashboard" ${tab === 'dashboard' ? '' : 'hidden'}>
          ${monitorBarHtml()}
          <p class="poll-line" data-poll-status hidden></p>
          <div class="coach-dashboard">
            <div class="coach-dashboard__tickets">
              <div class="coach-dashboard__summary">
                <span class="coach-dash-pill coach-dash-pill--water"><strong data-on-water-count>0</strong> on water</span>
                <span class="coach-dash-pill"><strong data-fleet-count>0</strong> crews</span>
                <div class="coach-scope-toggle" role="group" aria-label="Show all boats or this coach’s crews">
                  <button type="button" class="coach-scope-toggle__btn ${ticketScope === 'all' ? 'is-active' : ''}" data-ticket-scope="all" aria-pressed="${ticketScope === 'all' ? 'true' : 'false'}">All boats</button>
                  <button type="button" class="coach-scope-toggle__btn ${ticketScope === 'mine' ? 'is-active' : ''}" data-ticket-scope="mine" aria-pressed="${ticketScope === 'mine' ? 'true' : 'false'}">My crews</button>
                </div>
              </div>
              <div class="coach-dashboard__ticket-scroll">
                <div>
                  <h2 class="coach-ticket-section__title">On water</h2>
                  <ul class="crew-ticket-list" data-ticket-on-water></ul>
                </div>
                <div data-ashore-section>
                  <h2 class="coach-ticket-section__title">Ashore</h2>
                  <ul class="crew-ticket-list" data-ticket-ashore></ul>
                </div>
              </div>
              <div class="home-capsize-card" data-home-capsize hidden role="alert">
                <strong>Capsize</strong>
                <p data-home-capsize-detail></p>
              </div>
              <div class="home-capsize-log">
                <h3 class="home-capsize-log__title">Today’s capsize log</h3>
                <ul data-capsize-log></ul>
              </div>
            </div>
            <div class="coach-dashboard__stage" data-home-stage>
              <div class="coach-dashboard__map-pane">
                <div class="coach-dashboard__map-tools">
                  <button type="button" class="coach-btn coach-btn--ghost ${mapFollowFleet ? 'coach-btn--active' : ''}" data-map-follow aria-pressed="${mapFollowFleet ? 'true' : 'false'}">Follow fleet</button>
                  <span class="coach-dash-pill"><strong data-map-active-count>0</strong> on water</span>
                </div>
                <div id="coachHomeMap" class="coach-map coach-map--home"></div>
              </div>
              <div class="coach-dashboard__chart-pane">
                <canvas data-home-speed-chart aria-label="Speed versus time for boats on the water"></canvas>
              </div>
            </div>
          </div>
        </section>
        <section class="coach-panel coach-panel--map" data-panel="map" ${tab === 'map' ? '' : 'hidden'}>
          <p class="poll-line" data-poll-status hidden></p>
          <div class="coach-map-panel-tools">
            <button type="button" class="coach-btn coach-btn--ghost ${mapFollowFleet ? 'coach-btn--active' : ''}" data-map-follow aria-pressed="${mapFollowFleet ? 'true' : 'false'}">Follow fleet</button>
            <span class="coach-dash-pill"><strong data-map-active-count>0</strong> on water</span>
          </div>
          <div id="coachMap" class="coach-map"></div>
        </section>
        <section class="coach-panel coach-panel--live coach-panel--history" data-panel="live" ${tab === 'live' ? '' : 'hidden'}>
          <p class="poll-line" data-poll-status hidden></p>
          <div class="live-data-panel-root" data-live-root></div>
        </section>
        <section class="coach-panel" data-panel="logbook" ${tab === 'logbook' ? '' : 'hidden'}>
          <div data-logbook-root></div>
        </section>
        <section class="coach-panel coach-panel--history" data-panel="history" ${tab === 'history' ? '' : 'hidden'}>
          <div class="history-panel" data-history-root></div>
        </section>
        <section class="coach-panel" data-panel="settings" ${tab === 'settings' ? '' : 'hidden'}>
          ${
            isDemoMode()
              ? '<p class="coach-demo-note">Interactive demo — sample data only. Connection settings are not saved.</p>'
              : ''
          }
          <h2 class="coach-section-title">This device</h2>
          ${settingsField(
            'Coach',
            'Who is using this Manager tablet. The name comes from RowSafe Setup → Coaches & Boats.',
            coachSelectHtml(settings, fleetCoaches),
          )}
          ${settingsField(
            'Share location',
            'Use this tablet’s GPS so RowSafe and other Managers see the coach live on the map.',
            `<label class="coach-check"><input type="checkbox" id="shareLocation" ${settings.shareLocation ? 'checked' : ''} /> Show on RowSafe</label>`,
          )}
          ${settingsField(
            'Location update',
            'Seconds between GPS uploads. Default is 20 seconds.',
            `<input type="number" id="locationIntervalSec" min="5" max="120" step="1" value="${esc(String(Math.round(settings.locationIntervalMs / 1000) || 20))}" />`,
          )}
          <p class="poll-line coach-location-status" data-location-status>${esc(locationStatusLabel(getCoachLocationStatus(), settings))}</p>
          <h2 class="coach-section-title">Connection</h2>
          ${settingsField(
            'URL',
            'Same URL and password as the rower app. Stop monitoring before changing the URL.',
            `<input type="url" id="apiBase" value="${esc(settings.apiBaseUrl)}" placeholder="${esc(DEFAULT_API_BASE_URL)}" />`,
          )}
          ${settingsField(
            'Password',
            'Ingest access password (Bearer token). Ask your club admin if you do not have one.',
            `<input type="password" id="ingestToken" value="${esc(settings.ingestToken)}" autocomplete="off" />`,
          )}
          <div class="coach-settings-actions">
            <button type="button" class="coach-btn coach-btn--primary" data-save-settings>Save settings</button>
          </div>
          <hr class="club-admin__divider" />
          <div data-club-admin-root></div>
        </section>
        <nav class="coach-tabs coach-tabs--bottom" aria-label="Manager sections">
          <button type="button" class="coach-tab coach-tab--home ${tab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">Home</button>
          <button type="button" class="coach-tab ${tab === 'map' ? 'active' : ''}" data-tab="map">Map</button>
          <button type="button" class="coach-tab ${tab === 'live' ? 'active' : ''}" data-tab="live">Live data</button>
          <button type="button" class="coach-tab ${tab === 'logbook' ? 'active' : ''}" data-tab="logbook">Logbook</button>
          <button type="button" class="coach-tab ${tab === 'history' ? 'active' : ''}" data-tab="history">History</button>
        </nav>
      </div>`;

    bindInfoToggles(root);

    root.querySelectorAll('[data-map-follow]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (followCycleOn || (mapFollowFleet && !followDeviceId)) {
          stopCrewFollow();
          return;
        }
        startFollowCycle();
      });
    });
    const onWaterTickets = root.querySelector('[data-ticket-on-water]');
    onWaterTickets?.addEventListener('click', (ev) => {
      const li = (ev.target as HTMLElement).closest('[data-device-id]') as HTMLElement | null;
      if (!li || !onWaterTickets.contains(li)) return;
      const id = li.dataset.deviceId?.trim();
      if (id) onTicketFollow(id);
    });
    onWaterTickets?.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const li = (ev.target as HTMLElement).closest('[data-device-id]') as HTMLElement | null;
      if (!li || !onWaterTickets.contains(li)) return;
      ev.preventDefault();
      const id = li.dataset.deviceId?.trim();
      if (id) onTicketFollow(id);
    });
    updateMapFollowButton();
    root.querySelectorAll('[data-ticket-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = (btn as HTMLElement).dataset.ticketScope === 'mine' ? 'mine' : 'all';
        if (next === ticketScope) return;
        ticketScope = next;
        saveTicketScope(next);
        if (followDeviceId && !crewTicketRows().some((r) => r.deviceId === followDeviceId)) {
          followDeviceId = null;
          if (followCycleOn) startFollowCycle();
        }
        root.querySelectorAll<HTMLButtonElement>('[data-ticket-scope]').forEach((el) => {
          const on = el.dataset.ticketScope === ticketScope;
          el.classList.toggle('is-active', on);
          el.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        updateDashboardPanel();
        updateMap();
        updateMapPanelExtras();
        updateTicketFollowUi();
      });
    });
    root.querySelector('[data-start-monitor]')?.addEventListener('click', () => void onStartMonitoring());
    root.querySelector('[data-stop-monitor]')?.addEventListener('click', () => void onStopMonitoring());
    root.querySelector('[data-capsize-clear]')?.addEventListener('click', () => void acknowledgeCapsizeAlerts());
    root.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = (btn as HTMLElement).dataset.tab as Tab;
        historyPanel?.prepareForRender(next);
        liveDataPanel?.prepareForRender(next);
        logbookPanel?.prepareForRender(next);
        tab = next;
        render();
        syncPollTimer();
        if (tab === 'map') {
          ensureMap();
          updateMap();
          updateMapPanelExtras();
        }
        if (tab === 'dashboard') {
          updateDashboardPanel();
          void pollLive();
        }
        if (tab === 'live' || tab === 'map') {
          void pollLive();
        }
        if (tab === 'logbook') {
          void ensureLogbookPanel().onTabShown();
        }
        if (tab === 'history') {
          ensureHistoryPanel().onHistoryTabShown();
        }
      });
    });
    root.querySelector('[data-save-settings]')?.addEventListener('click', () => {
      settings = readSettingsFromForm();
      saveSettings(settings);
      setStatus(isDemoMode() ? 'Demo mode — settings are not saved' : 'Settings saved');
      void refreshFleetCoaches();
      syncCoachLocation(settings, updateLocationStatusLine);
      void ensureLiveDataPanel().reloadLines();
      syncPollTimer();
      if (shouldPollLive()) void pollLive();
    });

    if (tab === 'live') {
      const liveRoot = root.querySelector('[data-live-root]') as HTMLElement | null;
      if (liveRoot) {
        const panel = ensureLiveDataPanel();
        panel.mount(liveRoot);
        panel.onTabShown();
        panel.processPositions(positions);
      }
    }

    if (tab === 'history') {
      const historyRoot = root.querySelector('[data-history-root]') as HTMLElement | null;
      const panel = ensureHistoryPanel();
      if (historyRoot) {
        panel.mount(historyRoot);
        panel.onHistoryTabShown();
      }
    }

    if (tab === 'logbook') {
      const logRoot = root.querySelector('[data-logbook-root]') as HTMLElement | null;
      if (logRoot) {
        const panel = ensureLogbookPanel();
        panel.mount(logRoot);
        void panel.onTabShown();
      }
    }

    if (tab === 'settings') {
      const adminRoot = root.querySelector('[data-club-admin-root]') as HTMLElement | null;
      if (adminRoot) ensureClubAdminPanel().mount(adminRoot);
    }

    if (tab === 'map') {
      ensureMap();
      updateMap();
      updateMapPanelExtras();
      syncCapsizeAlarm();
      window.setTimeout(() => map?.invalidateSize(), 80);
      window.setTimeout(() => map?.invalidateSize(), 280);
    } else if (tab === 'dashboard') {
      updateDashboardPanel();
      syncCapsizeAlarm();
      if (isTabletHome()) {
        window.setTimeout(() => map?.invalidateSize(), 80);
        window.setTimeout(() => map?.invalidateSize(), 280);
      }
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
    if (isDemoMode()) {
      const now = Date.now();
      for (let i = 90; i >= 0; i--) {
        recordLiveSpeedSamples(demoMapPositions(now - i * 2000));
      }
      replaceCapsizeDayLogForDemo([
        {
          id: 'demo-kg-active',
          deviceId: 'W1x KG',
          name: 'W1x KG',
          lat: -37.9362,
          lon: 175.5518,
          startedAt: now - 4 * 60_000,
          status: 'active',
        },
        {
          id: 'demo-eh-acked',
          deviceId: 'W1x EH',
          name: 'W1x EH',
          lat: -37.9391,
          lon: 175.5544,
          startedAt: now - 52 * 60_000,
          status: 'acknowledged',
          ackedAt: now - 47 * 60_000,
          ackedBy: 'Coach Tom',
          ackSource: 'manager',
        },
        {
          id: 'demo-ls-remote',
          deviceId: 'W1x LS',
          name: 'W1x LS',
          lat: -37.941,
          lon: 175.556,
          startedAt: now - 3 * 3600_000,
          status: 'cleared',
          ackedAt: now - 3 * 3600_000 + 8 * 60_000,
          ackedBy: 'RowSafe',
          ackSource: 'rowsafe',
        },
      ]);
    }
    await refreshFleetCoaches();
    syncCoachLocation(settings, updateLocationStatusLine);
    await refreshMonitoringStatus();
    quietHoursActive = isQuietHours();
    if (!quietHoursActive && settings.apiBaseUrl) {
      syncPollTimer();
      if (monitoring) startMapTick();
      if (shouldPollLive()) void pollLive();
    } else if (quietHoursActive) {
      stopPollTimer();
      stopMapTick();
      setStatus(QUIET_HOURS_MESSAGE);
    }
    render();
    if (!quietHoursActive && settings.apiBaseUrl && shouldPollLive()) {
      void pollLive();
    }
  })();

  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      shouldPollLive()
    ) {
      void pollLive();
    }
  });

  if (typeof window.matchMedia === 'function') {
    window.matchMedia('(min-width: 960px)').addEventListener('change', () => {
      if (tab === 'dashboard' || tab === 'map') render();
    });
  }
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

/** Relative age for Home “last seen”: s < 60s, m < 60min, h < 24h, else days. */
function formatRelativeAgo(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '?';
  const s = Math.round(sec);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function settingsField(label: string, info: string, inputHtml: string): string {
  return `
      <div class="form-row">
        <div class="form-row__meta">
          <span class="form-row__label">${label}</span>
          <button type="button" class="info-btn" data-info-toggle aria-label="About ${label}" aria-expanded="false">i</button>
        </div>
        ${inputHtml}
        <p class="form-row__help info-help" hidden>${esc(info)}</p>
      </div>
    `;
}
