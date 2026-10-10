import {
  defaultFleetConfig,
  fetchFleetConfig,
  findBoat,
  findCoach,
  getCachedFleetConfig,
  type FleetConfig,
} from '../lib/fleet-config';
import {
  loadSettings,
  sampleRateSecFromSettings,
  saveSettings,
  settingsFromForm,
} from '../lib/settings';
import {
  clearRecordingActive,
  getInterruptedRecording,
  getPersistedRecording,
  markRecordingActive,
  startBackgroundSession,
  stopBackgroundSession,
  type BackgroundStatus,
} from '../lib/background-session';
import { requestNativePermissions } from '@rowing/sensor-adapters';
import type { SessionMeta } from '@rowing/telemetry-types';
import {
  armNativeGeofenceStandby,
  disarmNativeGeofenceStandby,
  getNativeActiveSession,
  getNativeStandbyStatus,
  prepareNativeRecordingSetup,
  recordingSetupLogLines,
  setNativeGeofences,
  stopNativeCapsizeMonitor,
  transitionToNativeGeofenceStandby,
  type NativeStandbyStatus,
} from '../lib/native-capsize-monitor';
import { fetchGeofences, getCachedGeofences } from '../lib/geofence-service';
import {
  LAKE_MASK_OUTER_RING,
  lakeBoundaryRing,
  normalizeGeofenceKind,
  type GeofenceConfig,
} from '../lib/geofence';
import {
  courseFromTrack,
  evaluateChannelStatus,
} from '../lib/channel-status';
import {
  clearSessionSpeedBuffer,
  getSessionSpeedSamplesSmoothed,
  getSessionTrailLatLon,
  pushSessionSpeedSample,
} from '../lib/session-speed-buffer';

import {
  drawSpeedTimeChart,
  speedChartColorForPrognostic,
} from '../lib/session-speed-chart';
import {
  parseBoatClass,
  prognosticPercent,
  speedMpsForPrognostic,
} from '@rowing/rowing-pace';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { resolveResumeCandidate } from '../lib/session-resume';
import {
  getHrConnectionStatus,
  pairHeartRate,
  subscribeHrConnection,
} from '../lib/hr-connection';
import { startRecorder, type RecorderController } from '../session/recorder';
import {
  startGeofenceStandby,
  type StandbyController,
  type StandbyStatus,
} from '../lib/geofence-standby';
import { clearPendingOutbox, countPendingOutbox, getSession } from '../session/store';
import { flushOutbox } from '../upload/sync';
import { postSessionEnd } from '../upload/telemetry-api';
import { repairOversizedPendingOutbox } from '../session/store';
import {
  formatPrognostic,
  formatSplit500m,
  hrToT,
  MetricRollingAvg,
  STROKE_AVG_WINDOW_MS,
  splitSecFromMps,
  splitSecToT,
  updateSpectrumRail,
} from './session-display';
import { StrokePeriodSpeedAvg } from '../lib/stroke-speed-smooth';
import {
  exportStrokeDebugJson,
  StrokeDebugCapture,
} from '../lib/stroke-debug-capture';
import { HistoryPanel } from './history-panel';

type View = 'record' | 'history' | 'settings';
type FsTab = 'metrics' | 'speed' | 'map';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';
const APP_VERSION = import.meta.env.VITE_APP_VERSION;
const APP_VERSION_CODE = import.meta.env.VITE_APP_VERSION_CODE;

function buildVersionLabel(): string {
  if (!APP_VERSION) return '';
  if (IS_NATIVE && APP_VERSION_CODE) {
    return `Build v${APP_VERSION} (${APP_VERSION_CODE})`;
  }
  return `Build v${APP_VERSION}`;
}

/** Resolve static assets for web (/) and Capacitor (./). */
function asset(path: string): string {
  const clean = path.replace(/^\//, '');
  return `${import.meta.env.BASE_URL}${clean}`;
}

export function mountApp(root: HTMLElement): void {
  let view: View = 'record';
  let historyPanel: HistoryPanel | null = null;
  let fleetConfigCache: FleetConfig | null = getCachedFleetConfig();
  let recording = false;
  let capsizeActive = false;
  let backgroundStatus: BackgroundStatus = 'foreground';
  let controller: RecorderController | null = null;
  let standby: StandbyController | null = null;
  let standbyStatus: StandbyStatus | null = null;
  let nativeStandbyPollTimer: ReturnType<typeof setInterval> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let sessionStartedAt: number | null = null;
  let hudTickTimer: ReturnType<typeof setInterval> | null = null;
  let logExpanded = false;
  let resumeInFlight = false;
  let fsTab: FsTab = 'metrics';
  let sessionMap: L.Map | null = null;
  let sessionMapMarker: L.CircleMarker | null = null;
  let sessionMapTrail: L.Polyline | null = null;
  let sessionMapGeofenceLayer: L.LayerGroup | null = null;
  /** Keep map centered on the phone GPS; pauses when the user pans/zooms. */
  let sessionMapFollow = true;
  /** Previous GPS fix for course-over-ground (channel check). */
  let channelCoursePrev: { lat: number; lon: number } | null = null;
  let channelCourseDeg: number | null = null;
  /** Average boat speed over ~2 stroke periods (surge removed). */
  const speedAvg = new StrokePeriodSpeedAvg({ strokes: 2, minMs: 4000, maxMs: 10000, fallbackMs: 8000 });
  const strokeRateAvg = new MetricRollingAvg(STROKE_AVG_WINDOW_MS, 0);
  const strokeDebugCapture = new StrokeDebugCapture();
  let settings = loadSettings();

  function refreshStrokeDebugStatus(): void {
    const el = root.querySelector('[data-stroke-debug-status]');
    if (!el) return;
    const st = strokeDebugCapture.getStatus();
    const last = strokeDebugCapture.getLastExport();
    if (st.active) {
      const spm =
        st.strokeRate != null && st.strokeRate > 0
          ? `${Math.round(st.strokeRate)} spm`
          : 'calibrating…';
      el.textContent = `Recording ${st.elapsedSec}s / ${st.remainingSec}s left · ${st.sampleCount} samples · ${spm}${st.calibrated ? '' : ' · hold still to calibrate'}`;
      return;
    }
    if (last) {
      const spm =
        last.replay.strokeRate != null
          ? `${Math.round(last.replay.strokeRate)} spm`
          : 'no rate';
      el.textContent = `Last capture: ${last.sampleCount} samples · ${spm} · ${last.replay.markers.length} markers — export ready`;
      return;
    }
    el.textContent =
      'Idle — record 30–60s at a steady rate, then export JSON for analysis.';
  }

  async function startStrokeDebug(durationSec: number): Promise<void> {
    if (recording || standby) {
      pushLog('Stop the normal session / standby before stroke debug.');
      return;
    }
    if (strokeDebugCapture.isActive()) {
      pushLog('Stroke debug already running.');
      return;
    }
    const s = loadSettings();
    const ok = await strokeDebugCapture.start({
      durationSec,
      deviceId: s.deviceId || 'debug',
      label: s.boatClass || '',
      appVersion: buildVersionLabel() || APP_VERSION || '',
      motionIntervalMs: 40,
      onLog: (m) => pushLog(m, false),
      onStatus: () => refreshStrokeDebugStatus(),
    });
    if (ok) {
      refreshStrokeDebugStatus();
      refreshLogPre();
    }
  }

  async function stopStrokeDebugAndExport(): Promise<void> {
    const exp =
      strokeDebugCapture.isActive()
        ? await strokeDebugCapture.stop()
        : strokeDebugCapture.getLastExport();
    refreshStrokeDebugStatus();
    if (!exp) {
      pushLog('No stroke debug capture to export yet.');
      return;
    }
    try {
      const how = await exportStrokeDebugJson(exp);
      pushLog(
        how === 'shared'
          ? 'Stroke debug shared — save the JSON (Files / Drive / email).'
          : how === 'downloaded'
            ? 'Stroke debug downloaded — check Downloads / Files.'
            : 'Stroke debug JSON copied to clipboard.',
      );
    } catch (e) {
      pushLog(
        `Export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    refreshLogPre();
  }

  document.addEventListener('fullscreenchange', () => {
    const stage = root.querySelector('[data-session-stage]');
    if (!stage) return;
    // Recording always uses the immersive layout; browser FS is optional chrome-hide.
    if (recording) {
      stage.classList.add('session-stage--fullscreen');
    } else {
      stage.classList.toggle(
        'session-stage--fullscreen',
        document.fullscreenElement === stage,
      );
    }
    if (document.fullscreenElement === stage || recording) {
      requestAnimationFrame(() => {
        refreshFsPanels();
        if (fsTab === 'map') invalidateSessionMap();
      });
    }
  });

  const isLandscapeOrientation = (): boolean =>
    window.matchMedia('(orientation: landscape)').matches;

  function syncSessionViewForOrientation(): void {
    const landscape = isLandscapeOrientation();
    const tabs = root.querySelector('.session-fs-tabs') as HTMLElement | null;
    if (tabs) tabs.hidden = !landscape;
    if (!landscape && fsTab !== 'metrics') {
      setFsTab('metrics');
      return;
    }
    requestAnimationFrame(() => {
      refreshFsPanels();
      if (fsTab === 'map') invalidateSessionMap();
    });
  }

  const onFsViewportChange = () => {
    if (!recording) return;
    syncSessionViewForOrientation();
  };
  window.addEventListener('resize', onFsViewportChange);
  window.addEventListener('orientationchange', onFsViewportChange);

  const logLines: string[] = [];
  const refreshLogPre = () => {
    const pre = root.querySelector('.hub-panel.log pre');
    if (pre) pre.textContent = logLines.join('\n') || 'Ready.';
  };
  const pushLog = (msg: string, rerender = true) => {
    const t = new Date().toLocaleTimeString();
    logLines.unshift(`[${t}] ${msg}`);
    if (logLines.length > 80) logLines.length = 80;
    // Full page rebuild wipes the Settings form (focus + unsaved edits).
    if (rerender && view !== 'settings') render();
    else refreshLogPre();
  };

  const updatePending = async () => {
    const n = await countPendingOutbox();
    const el = root.querySelector('[data-pending]');
    if (el) el.textContent = String(n);
  };

  async function runSync(manual = false) {
    if (manual) {
      pushLog('Uploading queued data…');
      if (recording) {
        pushLog('Tip: queue still grows while recording — stop session to freeze queue.', false);
      }
    }
    try {
      const s = loadSettings();
      const pendingBefore = await countPendingOutbox();
      if (manual && pendingBefore === 0) {
        pushLog('Queue is empty — nothing to upload.');
        await updatePending();
        return;
      }

      const { sent, failed, errors } = await flushOutbox(s, {
        force: manual,
        maxBatches: manual ? 15 : 40,
        onProgress: manual ? (msg) => pushLog(msg, false) : undefined,
      });

      const pendingAfter = await countPendingOutbox();
      if (manual || sent || failed) {
        pushLog(`Upload: ${sent} sent, ${failed} failed · queue ${pendingAfter}`);
      }
      if (recording && pendingAfter >= 120) {
        pushLog(
          `Queue pressure HIGH (${pendingAfter}) — check signal or raise upload interval.`,
          false,
        );
      } else if (recording && pendingAfter >= 60) {
        pushLog(`Queue pressure rising (${pendingAfter}) — watch upload status.`, false);
      }
      if (errors.length) {
        for (const err of errors.slice(0, 3)) pushLog(err, false);
        refreshLogPre();
        if (view !== 'settings') render();
        if (/failed to fetch|timed out/i.test(errors[0])) {
          pushLog('Tip: stop session, check signal, Settings → Test upload.');
        }
      } else if (pendingBefore > 0 && sent === 0 && pendingAfter >= pendingBefore) {
        pushLog(`Queue still ${pendingAfter} — tap Upload again or Clear session.`);
      } else if (manual && pendingAfter === 0 && sent > 0) {
        pushLog('All queued data uploaded.');
      } else if (manual && pendingAfter > 0 && sent > 0) {
        pushLog(`${pendingAfter} batch(es) left — tap Upload again.`);
      }
      await updatePending();
    } catch (e) {
      pushLog(`Upload error: ${e instanceof Error ? e.message : String(e)}`);
      await updatePending();
    }
  }

  function logPanelHtml(): string {
    return `
      <section class="hub-panel log ${logExpanded ? 'log--open' : 'log--closed'}">
        <button type="button" class="log-toggle hub-btn hub-btn--ghost" data-action="toggle-log" aria-expanded="${logExpanded}">
          Log ${logExpanded ? '▲ hide' : '▼ show'}
        </button>
        ${logExpanded ? `<pre>${logLines.join('\n') || 'Ready.'}</pre>` : ''}
      </section>
    `;
  }

  async function clearQueue(manual = true): Promise<void> {
    const n = await clearPendingOutbox();
    await updatePending();
    if (manual) pushLog(n ? `Cleared ${n} queued batch(es).` : 'Queue was already empty.');
  }

  async function clearSession(): Promise<void> {
    if (recording) {
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      stopHudTimer();
      sessionStartedAt = null;
      speedAvg.clear();
      strokeRateAvg.clear();
      clearSessionSpeedBuffer();
      destroySessionMap();
      fsTab = 'metrics';
      await exitStageFullscreen();
      stopBackgroundSession();
      await controller?.stop();
      controller = null;
      recording = false;
      capsizeActive = false;
      backgroundStatus = 'foreground';
    }
    clearRecordingActive();
    if (IS_NATIVE) {
      await stopStandby();
      await stopNativeCapsizeMonitor();
    }
    const n = await clearPendingOutbox();
    await updatePending();
    pushLog(
      n
        ? `Session cleared — stopped recording and removed ${n} queued batch(es).`
        : 'Session cleared — stopped recording; queue was empty.',
    );
    render();
  }

  function formatElapsed(ms: number): string {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatDistanceM(metres: number | null | undefined): string {
    if (metres == null || !Number.isFinite(metres) || metres < 0) return '—';
    if (metres < 1000) return `${Math.round(metres)} m`;
    return `${(metres / 1000).toFixed(2)} km`;
  }

  async function enterStageFullscreen(): Promise<void> {
    const stage = root.querySelector('[data-session-stage]') as HTMLElement | null;
    if (!stage) return;
    stage.classList.add('session-stage--fullscreen');
    if (document.fullscreenElement === stage) return;
    try {
      await stage.requestFullscreen();
    } catch {
      /* Immersive CSS layout still applies without browser fullscreen. */
    }
  }

  async function exitStageFullscreen(): Promise<void> {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        /* ignore */
      }
    }
  }

  function stopHudTimer(): void {
    if (hudTickTimer) clearInterval(hudTickTimer);
    hudTickTimer = null;
  }

  function setHudText(sel: string, text: string): void {
    root.querySelectorAll(sel).forEach((el) => {
      el.textContent = text;
    });
  }

  function destroySessionMap(): void {
    if (sessionMap) {
      sessionMap.remove();
      sessionMap = null;
    }
    sessionMapMarker = null;
    sessionMapTrail = null;
    sessionMapGeofenceLayer = null;
  }

  function invalidateSessionMap(): void {
    sessionMap?.invalidateSize();
  }

  function updateSessionMapFollowButton(): void {
    const btn = root.querySelector('[data-map-follow]') as HTMLButtonElement | null;
    if (!btn) return;
    btn.classList.toggle('is-active', sessionMapFollow);
    btn.setAttribute('aria-pressed', sessionMapFollow ? 'true' : 'false');
    btn.textContent = sessionMapFollow ? 'Following' : 'Follow';
  }

  function setSessionMapFollow(on: boolean): void {
    sessionMapFollow = on;
    updateSessionMapFollowButton();
    if (on) updateSessionMapOverlay();
  }

  function drawGeofencesOnMap(list: GeofenceConfig[]): void {
    if (!sessionMap) return;
    if (sessionMapGeofenceLayer) {
      sessionMapGeofenceLayer.clearLayers();
    } else {
      sessionMapGeofenceLayer = L.layerGroup().addTo(sessionMap);
    }
    for (const g of list) {
      if (!g.enabled) continue;
      const kind = normalizeGeofenceKind(g.kind);
      if (kind === 'lake') {
        const hole = lakeBoundaryRing(g);
        if (hole.length < 3) continue;
        L.polygon([LAKE_MASK_OUTER_RING, hole], {
          color: '#475569',
          fillColor: '#1e293b',
          fillOpacity: 0.45,
          stroke: false,
          interactive: false,
        }).addTo(sessionMapGeofenceLayer);
        L.polygon(hole, {
          color: '#94a3b8',
          fill: false,
          weight: 2,
          dashArray: '4 3',
        })
          .bindTooltip(g.name || 'Lake boundary')
          .addTo(sessionMapGeofenceLayer);
        continue;
      }
      const isNotify =
        Boolean(g.notifyOnEnter) || kind === 'hazard' || kind === 'lane_nogo';
      const color =
        kind === 'lane_up'
          ? '#22d3ee'
          : kind === 'lane_down'
            ? '#a78bfa'
            : kind === 'lane_nogo'
              ? '#f97316'
              : kind === 'turnaround'
                ? '#fbbf24'
                : isNotify
                  ? '#f87171'
                  : '#f59e0b';
      if (g.shapeType === 'circle' && g.radiusM > 0) {
        L.circle([g.centerLat, g.centerLon], {
          radius: g.radiusM,
          color,
          fillColor: color,
          fillOpacity: 0.14,
          weight: 2,
        })
          .bindTooltip(g.name || 'Geofence')
          .addTo(sessionMapGeofenceLayer);
      } else if (g.shapeType === 'polygon' && g.polygonCoords?.length >= 3) {
        L.polygon(
          g.polygonCoords.map(([lat, lon]) => [lat, lon] as [number, number]),
          {
            color,
            fillColor: color,
            fillOpacity: 0.14,
            weight: 2,
          },
        )
          .bindTooltip(g.name || 'Geofence')
          .addTo(sessionMapGeofenceLayer);
      }
    }
  }

  function ensureSessionMap(): void {
    const el = root.querySelector('[data-session-map]') as HTMLElement | null;
    if (!el) return;
    if (!sessionMap) {
      const stats = controller?.getStats();
      const lat = stats?.lastGps?.lat ?? -37.928;
      const lon = stats?.lastGps?.lon ?? 175.548;
      sessionMapFollow = true;
      sessionMap = L.map(el, {
        preferCanvas: true,
        zoomControl: true,
        attributionControl: false,
      }).setView([lat, lon], 15);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(sessionMap);
      sessionMap.on('dragstart', () => {
        if (!sessionMapFollow) return;
        setSessionMapFollow(false);
      });
      sessionMap.on('zoomstart', (e: L.LeafletEvent) => {
        if (!sessionMapFollow || !e.originalEvent) return;
        setSessionMapFollow(false);
      });
      drawGeofencesOnMap(getCachedGeofences());
      void fetchGeofences(loadSettings().ingestUrl, loadSettings().ingestToken).then(
        (list) => {
          if (sessionMap) drawGeofencesOnMap(list);
        },
        () => {
          /* keep cached */
        },
      );
    }
    updateSessionMapFollowButton();
    updateSessionMapOverlay();
    requestAnimationFrame(() => invalidateSessionMap());
  }

  function updateSessionMapOverlay(): void {
    if (!sessionMap) return;
    const stats = controller?.getStats();
    const gps = stats?.lastGps;
    const trail = getSessionTrailLatLon();
    if (trail.length >= 2) {
      if (!sessionMapTrail) {
        sessionMapTrail = L.polyline(trail, {
          color: '#00e5ff',
          weight: 3,
          opacity: 0.85,
        }).addTo(sessionMap);
      } else {
        sessionMapTrail.setLatLngs(trail);
      }
    }
    if (gps && Number.isFinite(gps.lat) && Number.isFinite(gps.lon)) {
      const ll: [number, number] = [gps.lat, gps.lon];
      if (!sessionMapMarker) {
        sessionMapMarker = L.circleMarker(ll, {
          radius: 8,
          color: '#00e5ff',
          fillColor: '#0d9488',
          fillOpacity: 1,
          weight: 2,
        })
          .bindTooltip('You')
          .addTo(sessionMap);
        sessionMap.setView(ll, Math.max(sessionMap.getZoom(), 15));
      } else {
        sessionMapMarker.setLatLng(ll);
        if (sessionMapFollow) {
          sessionMap.setView(ll, Math.max(sessionMap.getZoom(), 15), { animate: true });
        }
      }
    }
  }

  function refreshSpeedChart(): void {
    const canvas = root.querySelector('[data-speed-chart]') as HTMLCanvasElement | null;
    if (!canvas || fsTab !== 'speed') return;
    const now = Date.now();
    const samples = getSessionSpeedSamplesSmoothed(now);
    const points = samples.map((s) => ({
      x: (s.t - now) / 60_000,
      y: s.speedMps * 3.6,
    }));
    const s = loadSettings();
    const boat = parseBoatClass(s.boatClass, s.deviceId, s.athleteId);
    const bandPcts = [60, 70, 80, 90];
    const prognosticBands = boat
      ? bandPcts
          .map((pct) => {
            const mps = speedMpsForPrognostic(pct, boat);
            return mps != null && Number.isFinite(mps)
              ? { pct, yKmh: mps * 3.6 }
              : null;
          })
          .filter((b): b is { pct: number; yKmh: number } => b != null)
      : [];
    const lastMps =
      samples.length > 0 ? samples[samples.length - 1].speedMps : null;
    const pct =
      lastMps != null && boat ? prognosticPercent(lastMps, boat) : null;
    drawSpeedTimeChart(canvas, points, {
      title: 'Speed vs time (last 8 min)',
      yLabel: 'km/h',
      xLabel: 'min',
      color: speedChartColorForPrognostic(pct),
      prognosticBands,
    });
  }

  function setFsTab(tab: FsTab): void {
    // Portrait only supports fullscreen metrics; graph/map are landscape-only.
    const next = !isLandscapeOrientation() && tab !== 'metrics' ? 'metrics' : tab;
    fsTab = next;
    root.querySelectorAll('[data-fs-tab]').forEach((btn) => {
      btn.setAttribute(
        'aria-selected',
        btn.getAttribute('data-fs-tab') === next ? 'true' : 'false',
      );
    });
    root.querySelectorAll('[data-fs-panel]').forEach((panel) => {
      panel.classList.toggle(
        'is-active',
        panel.getAttribute('data-fs-panel') === next,
      );
    });
    refreshFsPanels();
  }

  function refreshFsPanels(): void {
    if (fsTab === 'speed') refreshSpeedChart();
    if (fsTab === 'map') ensureSessionMap();
  }

  function updateLiveHud(): void {
    if (!recording || view !== 'record') return;
    const stats = controller?.getStats();
    const elapsed = sessionStartedAt != null ? Date.now() - sessionStartedAt : 0;
    const elapsedText = formatElapsed(elapsed);

    setHudText('[data-hud-timer]', elapsedText);
    setHudText('[data-hud-timer-metric]', elapsedText);

    const spm = stats?.strokeRate;
    if (spm != null && spm > 0) strokeRateAvg.push(spm);
    const avgSpm = strokeRateAvg.average();
    const displaySpm =
      spm != null && spm > 0
        ? String(Math.round(spm))
        : avgSpm != null && avgSpm > 0
          ? String(Math.round(avgSpm))
          : '—';
    setHudText('[data-hud-spm]', displaySpm);

    setHudText('[data-hud-hr]', stats?.lastHr != null ? String(stats.lastHr) : '—');
    setHudText('[data-hud-distance]', formatDistanceM(stats?.distanceM));

    const liveSpm =
      spm != null && spm > 0 ? spm : avgSpm != null && avgSpm > 0 ? avgSpm : null;
    speedAvg.setStrokeRate(liveSpm);
    if (stats?.speedMps != null && stats.speedMps >= 0.15) {
      speedAvg.push(stats.speedMps);
    }
    const avgMps = speedAvg.average();
    const s = loadSettings();
    const boat = parseBoatClass(s.boatClass, s.deviceId, s.athleteId);
    setHudText('[data-hud-split]', formatSplit500m(avgMps));
    setHudText(
      '[data-hud-prog]',
      avgMps != null && boat ? formatPrognostic(avgMps, boat) ?? '—' : '—',
    );

    if (stats?.speedMps != null && stats.speedMps >= 0) {
      const t = stats.lastGps?.t ?? Date.now();
      pushSessionSpeedSample({
        t,
        speedMps: stats.speedMps,
        lat: stats.lastGps?.lat,
        lon: stats.lastGps?.lon,
        strokeRateSpm: liveSpm,
      });
    }

    const paceProgPct =
      avgMps != null && boat ? prognosticPercent(avgMps, boat) : null;
    const splitSec = splitSecFromMps(avgMps);
    updateSpectrumRail(
      root.querySelector('[data-rail-speed]') as HTMLElement | null,
      splitSec != null ? splitSecToT(splitSec) : undefined,
      {
        fillColor:
          paceProgPct != null
            ? speedChartColorForPrognostic(paceProgPct)
            : undefined,
      },
    );
    const hr = stats?.lastHr;
    const hrT = hr != null && hr > 0 ? hrToT(hr) : undefined;
    updateSpectrumRail(
      root.querySelector('[data-rail-hr]') as HTMLElement | null,
      hrT,
      {
        // Same band thresholds as pace prognostic: 60–70 green … ≥90 red.
        fillColor:
          hrT != null ? speedChartColorForPrognostic(hrT * 100) : undefined,
      },
    );

    const capsizeEl = root.querySelector('[data-hud-capsize]');
    if (capsizeEl) {
      if (capsizeActive) capsizeEl.removeAttribute('hidden');
      else capsizeEl.setAttribute('hidden', '');
    }

    const hazardEl = root.querySelector('[data-hud-hazard]') as HTMLElement | null;
    if (hazardEl) {
      const warning =
        stats?.inHazardZone && stats.hazardWarning?.trim()
          ? stats.hazardWarning.trim()
          : '';
      const textEl = hazardEl.querySelector('[data-hud-hazard-text]');
      if (warning) {
        hazardEl.removeAttribute('hidden');
        if (textEl) textEl.textContent = warning;
      } else {
        hazardEl.setAttribute('hidden', '');
        if (textEl) textEl.textContent = '';
      }
    }

    const regattaEl = root.querySelector('[data-hud-regatta]');
    if (regattaEl) {
      const text = stats?.regattaMessage?.text?.trim();
      const textEl = regattaEl.querySelector('[data-hud-regatta-text]');
      if (text) {
        regattaEl.removeAttribute('hidden');
        if (textEl) textEl.textContent = text;
      } else {
        regattaEl.setAttribute('hidden', '');
        if (textEl) textEl.textContent = '';
      }
    }

    const zoneEl = root.querySelector('[data-hud-zone]');
    if (zoneEl) {
      const label = zoneEl.querySelector('.session-zone-badge__label');
      const sub = zoneEl.querySelector('.session-zone-badge__sub');
      if (!stats?.lastGps) {
        zoneEl.setAttribute('data-zone', 'unknown');
        if (label) label.textContent = 'Locating…';
        if (sub) sub.textContent = '';
      } else if (stats.inBoatPark) {
        const zoneName = stats.boatParkName?.trim() || 'Geofence zone';
        const lake = stats.restrictionKind === 'lake';
        zoneEl.setAttribute('data-zone', lake ? 'outside_lake' : 'boat_park');
        if (label) {
          label.textContent = stats.recordingSuppressed
            ? lake
              ? `${zoneName} · outside · paused`
              : `${zoneName} · paused`
            : lake
              ? `${zoneName} · outside`
              : zoneName;
        }
        if (sub) sub.textContent = '';
      } else {
        zoneEl.setAttribute('data-zone', 'on_water');
        if (label) label.textContent = 'On water';
        if (sub) sub.textContent = '';
      }
    }

    const channelEl = root.querySelector('[data-hud-channel]');
    if (channelEl) {
      const label = channelEl.querySelector('.session-channel-badge__label');
      const sub = channelEl.querySelector('.session-channel-badge__sub');
      const gps = stats?.lastGps;
      if (gps) {
        const course = courseFromTrack(channelCoursePrev, {
          lat: gps.lat,
          lon: gps.lon,
        });
        if (course != null) channelCourseDeg = course;
        channelCoursePrev = { lat: gps.lat, lon: gps.lon };
        const status = evaluateChannelStatus(
          gps.lat,
          gps.lon,
          channelCourseDeg,
          getCachedGeofences(),
        );
        channelEl.setAttribute('data-channel', status.id);
        channelEl.removeAttribute('hidden');
        if (label) label.textContent = status.label;
        if (sub) sub.textContent = status.sub;
      } else {
        channelEl.setAttribute('data-channel', 'unknown');
        if (label) label.textContent = 'Flow pattern…';
        if (sub) sub.textContent = '';
      }
    }

    const pending = root.querySelector('[data-pending]');
    if (pending) pending.textContent = String(stats?.pendingOutbox ?? 0);

    const statsBar = root.querySelector('.hub-stats-bar');
    if (statsBar) statsBar.innerHTML = recordStatsBar(stats);

    if (fsTab === 'speed') refreshSpeedChart();
    if (fsTab === 'map' && sessionMap) updateSessionMapOverlay();
    updateHrIndicator();
  }

  function startHudTimer(): void {
    stopHudTimer();
    updateLiveHud();
    hudTickTimer = setInterval(() => updateLiveHud(), 1000);
  }

  function ensureHistoryPanel(): HistoryPanel {
    if (!historyPanel) {
      historyPanel = new HistoryPanel(
        () => loadSettings(),
        (msg, err) => pushLog(msg, Boolean(err)),
      );
    }
    return historyPanel;
  }

  function render() {
    destroySessionMap();
    historyPanel?.prepareForRender(view);
    if (view === 'settings') {
      root.innerHTML = settingsHtml();
    } else if (view === 'history') {
      root.innerHTML = historyHtml();
    } else {
      root.innerHTML = recordHtml();
    }
    bind();
    if (view === 'history') {
      const historyRoot = root.querySelector('[data-history-root]') as HTMLElement | null;
      if (historyRoot) {
        ensureHistoryPanel().mount(historyRoot);
        ensureHistoryPanel().onHistoryTabShown();
      }
    }
    if (recording && view === 'record') {
      updateLiveHud();
      refreshFsPanels();
    }
  }

  /** Rebuild UI unless Settings/History is open (avoids wiping form focus / map). */
  function renderUnlessSettings(): void {
    if (view === 'settings') {
      refreshLogPre();
      void updatePending();
      return;
    }
    if (view === 'history') {
      void updatePending();
      return;
    }
    render();
  }

  function fleetOptionsEqual(a: FleetConfig, b: FleetConfig): boolean {
    if (a.coaches.length !== b.coaches.length || a.boats.length !== b.boats.length) {
      return false;
    }
    for (let i = 0; i < a.coaches.length; i++) {
      if (a.coaches[i].id !== b.coaches[i].id || a.coaches[i].name !== b.coaches[i].name) {
        return false;
      }
    }
    for (let i = 0; i < a.boats.length; i++) {
      if (
        a.boats[i].id !== b.boats[i].id ||
        a.boats[i].label !== b.boats[i].label ||
        a.boats[i].boatClass !== b.boats[i].boatClass
      ) {
        return false;
      }
    }
    return true;
  }

  /** Refresh coach/boat dropdowns in place after a background fleet-config fetch. */
  function patchFleetSelects(config: FleetConfig): void {
    if (view !== 'settings') return;
    const form = root.querySelector('[data-settings-form]') as HTMLFormElement | null;
    if (!form) return;
    const coachSel = form.querySelector('[name="coachId"]') as HTMLSelectElement | null;
    const boatSel = form.querySelector('[name="boatId"]') as HTMLSelectElement | null;
    const coachName = form.querySelector('[name="coachName"]') as HTMLInputElement | null;
    const boatClass = form.querySelector('[name="boatClass"]') as HTMLInputElement | null;
    const keepCoach = coachSel?.value ?? '';
    const keepBoat = boatSel?.value ?? '';

    if (coachSel) {
      coachSel.innerHTML =
        `<option value="">— select coach —</option>` +
        config.coaches
          .map(
            (c) =>
              `<option value="${esc(c.id)}" data-name="${esc(c.name)}"${keepCoach === c.id ? ' selected' : ''}>${esc(c.name)}</option>`,
          )
          .join('');
      if (keepCoach && [...coachSel.options].some((o) => o.value === keepCoach)) {
        coachSel.value = keepCoach;
      }
    }
    if (boatSel) {
      boatSel.innerHTML =
        `<option value="">— select boat —</option>` +
        config.boats
          .map(
            (b) =>
              `<option value="${esc(b.id)}" data-class="${esc(b.boatClass)}"${keepBoat === b.id ? ' selected' : ''}>${esc(b.label)}</option>`,
          )
          .join('');
      if (keepBoat && [...boatSel.options].some((o) => o.value === keepBoat)) {
        boatSel.value = keepBoat;
      }
    }
    if (coachSel && coachName) {
      const opt = coachSel.selectedOptions[0];
      coachName.value = opt?.dataset.name || opt?.textContent?.trim() || coachName.value;
    }
    if (boatSel && boatClass) {
      const opt = boatSel.selectedOptions[0];
      if (opt?.dataset.class) boatClass.value = opt.dataset.class;
    }
  }

  async function refreshFleetConfigInBackground(): Promise<void> {
    const prev = fleetConfigCache ?? getCachedFleetConfig();
    const next = await fetchFleetConfig(true);
    fleetConfigCache = next;
    if (view === 'settings' && !fleetOptionsEqual(prev, next)) {
      patchFleetSelects(next);
    }
  }

  function hubHeader(): string {
    return `
      <header class="hub-topbar hub-topbar--recorder">
        <div class="hub-topbar-inner">
          <div class="hub-topbar-brands">
            <img src="${asset('assets/crewsight/crewsight-logo-full-color.png')}" alt="CrewSight" class="hub-crewsight-logo hub-crewsight-logo--recorder" width="300" height="300" />
          </div>
          <p class="hub-tagline hub-tagline--title">Rowing GPS Tracker</p>
        </div>
      </header>
    `;
  }

  function mainNavHtml(): string {
    if (recording) return '';
    const item = (id: View, label: string) =>
      `<button type="button" class="recorder-tab ${view === id ? 'active' : ''}" data-nav="${id}">${label}</button>`;
    return `
      <nav class="recorder-tabs" aria-label="Main">
        ${item('record', 'Record')}
        ${item('history', 'History')}
        ${item('settings', 'Settings')}
      </nav>
    `;
  }

  function hubFooter(): string {
    const version = buildVersionLabel();
    return `
      <footer class="ahd-footer">
        <p class="ahd-footer__line">
          CrewSight ·
          <a href="${asset('install-native.html')}">Install Android app</a> ·
          <a href="${asset('dashboard.html')}" target="_blank" rel="noopener">CrewSight Manager</a>
        </p>
        ${version ? `<p class="ahd-footer__version">${esc(version)}</p>` : ''}
        ${mainNavHtml()}
      </footer>
    `;
  }

  function recordStatsBar(stats: ReturnType<RecorderController['getStats']> | undefined): string {
    const name = settings.deviceId || '—';
    const coach = settings.athleteId?.trim() || '—';
    const boat =
      fleetConfigCache?.boats.find((b) => b.id === settings.boatId)?.label ||
      (settings.boatClass ? settings.boatClass : '—');
    const status = capsizeActive ? 'CAPSIZE' : recording ? 'Recording' : 'Idle';
    const statusClass = capsizeActive
      ? 'hub-stats-item--danger'
      : recording
        ? 'hub-stats-item--accent'
        : '';
    const gps = stats?.lastGps
      ? `${stats.lastGps.lat.toFixed(4)}, ${stats.lastGps.lon.toFixed(4)}`
      : 'No GPS fix';
    const spm =
      stats?.strokeRate != null
        ? `${stats.strokeRate} spm`
        : recording
          ? 'SPM —'
          : '';
    const bg =
      recording && backgroundStatus === 'background'
        ? 'Background'
        : recording && settings.enableBackgroundRecording
          ? 'Background ready'
          : '';
    let zone = '';
    if (recording && stats?.lastGps) {
      zone = stats.inBoatPark
        ? `${stats.boatParkName?.trim() || 'Geofence zone'}${stats.recordingSuppressed ? ' · paused' : ''}`
        : 'On water';
    } else if (recording) {
      zone = 'Locating…';
    }
    const np = stats?.nativePulse;
    let gpsDiag = '';
    if (recording && np?.serviceRunning && np.enableGps) {
      const up = np.lastGpsSampleOfferedAgoMs ?? np.lastGpsUploadAgoMs ?? -1;
      const fused = np.lastFusedDeliveryAgoMs ?? -1;
      const interval = np.gpsIntervalMs ?? 1000;
      const uploadStale = up >= interval * 3;
      const fusedStale = fused >= 15_000;
      if (uploadStale || fusedStale) {
        const upSec = up >= 0 ? Math.round(up / 1000) : '?';
        const fusedSec = fused >= 0 ? Math.round(fused / 1000) : '?';
        gpsDiag = `GPS↑${upSec}s fused↑${fusedSec}s`;
        const lastFixMs = np.lastGps?.fixMs;
        const uploadT = np.lastGps?.t;
        if (lastFixMs != null && uploadT != null && uploadT > lastFixMs) {
          gpsDiag += ` lag↑${Math.round((uploadT - lastFixMs) / 1000)}s`;
        }
        if ((np.heartbeatGpsCount ?? 0) > 0) {
          gpsDiag += ` hbGps=${np.heartbeatGpsCount}`;
        }
      }
    }
    return `
      <span class="hub-stats-item ${statusClass}">${status}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">Name: ${esc(name)}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">Coach: ${esc(coach)}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">Boat: ${esc(boat)}</span>
      ${zone ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item ${stats?.inBoatPark ? 'hub-stats-item--boat-park' : 'hub-stats-item--on-water'}">${esc(zone)}</span>` : ''}
      ${spm ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item">${esc(spm)}</span>` : ''}
      ${bg ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item hub-stats-item--muted">${esc(bg)}</span>` : ''}
      ${gpsDiag ? `<span class="hub-stats-sep" aria-hidden="true">·</span><span class="hub-stats-item hub-stats-item--warn">${esc(gpsDiag)}</span>` : ''}
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">${gps}</span>
    `;
  }

  function spectrumRailsHtml(): string {
    return `
      <div class="spectrum-rail spectrum-rail--speed" data-rail-speed aria-label="Pace spectrum: fast 1:15 top, slow 2:30 bottom">
        <span class="spectrum-rail__marker" data-rail-marker></span>
        <span class="spectrum-rail__legend">Pace</span>
        <span class="spectrum-rail__fast">1:15</span>
        <span class="spectrum-rail__slow">2:30</span>
      </div>
      <div class="spectrum-rail spectrum-rail--hr" data-rail-hr aria-label="Heart rate spectrum: 200 top, 100 bottom">
        <span class="spectrum-rail__marker" data-rail-marker></span>
        <span class="spectrum-rail__legend">HR</span>
        <span class="spectrum-rail__fast">200</span>
        <span class="spectrum-rail__slow">100</span>
      </div>
    `;
  }

  function metricsBlockHtml(
    variant: 'hero' | 'column' | 'ticket' | 'overlay',
  ): string {
    const wrapClass =
      variant === 'hero'
        ? 'session-metrics-block session-metrics-block--hero'
        : variant === 'ticket'
          ? 'session-metrics-block session-metrics-block--ticket'
          : variant === 'overlay'
            ? 'session-metrics-block session-metrics-block--overlay'
            : 'session-metrics-block session-metrics-block--column';
    if (variant === 'overlay') {
      return `
      <div class="${wrapClass}">
        <div class="session-metric session-metric--pace-overlay">
          <span class="session-metric__value" data-hud-split>—</span>
          <span class="session-metric__sep" aria-hidden="true">–</span>
          <span class="session-metric__prog" data-hud-prog>—</span>
        </div>
        <div class="session-live-hud__metrics session-live-hud__metrics--overlay">
          <div class="session-metric session-metric--timer">
            <span class="session-metric__value" data-hud-timer-metric>0:00</span>
            <span class="session-metric__label">Time</span>
          </div>
          <div class="session-metric session-metric--spm">
            <span class="session-metric__value" data-hud-spm>—</span>
            <span class="session-metric__label">SPM</span>
          </div>
          <div class="session-metric session-metric--hr">
            <span class="session-metric__value" data-hud-hr>—</span>
            <span class="session-metric__label">HR <span class="hr-indicator hr-indicator--inline" data-hr-indicator data-connected="0" title="HR not connected"><span class="hr-indicator__dot" aria-hidden="true"></span></span></span>
          </div>
          <div class="session-metric session-metric--distance">
            <span class="session-metric__value" data-hud-distance>—</span>
            <span class="session-metric__label">Dist</span>
          </div>
        </div>
      </div>`;
    }
    return `
      <div class="${wrapClass}">
        ${
          variant === 'hero'
            ? `<div class="session-metric session-metric--pace-hero">
                <span class="session-metric__value" data-hud-split>—</span>
                <span class="session-metric__prog" data-hud-prog>—</span>
                <span class="session-metric__label">Pace /500m <span class="session-metric__sub">10s avg</span></span>
              </div>
              <div class="session-live-hud__metrics session-live-hud__metrics--secondary">
                <div class="session-metric session-metric--timer">
                  <span class="session-metric__value" data-hud-timer-metric>0:00</span>
                  <span class="session-metric__label">Time</span>
                </div>
                <div class="session-metric session-metric--distance">
                  <span class="session-metric__value" data-hud-distance>—</span>
                  <span class="session-metric__label">Distance</span>
                </div>
                <div class="session-metric session-metric--spm">
                  <span class="session-metric__value" data-hud-spm>—</span>
                  <span class="session-metric__label">Strokes /min</span>
                </div>
                <div class="session-metric session-metric--hr">
                  <span class="session-metric__value" data-hud-hr>—</span>
                  <span class="session-metric__label">HR <span class="hr-indicator hr-indicator--inline" data-hr-indicator data-connected="0" title="HR not connected"><span class="hr-indicator__dot" aria-hidden="true"></span></span></span>
                </div>
              </div>`
            : `<div class="session-live-hud__metrics">
                <div class="session-metric session-metric--timer">
                  <span class="session-metric__value" data-hud-timer-metric>0:00</span>
                  <span class="session-metric__label">Time</span>
                </div>
                <div class="session-metric session-metric--distance">
                  <span class="session-metric__value" data-hud-distance>—</span>
                  <span class="session-metric__label">Distance</span>
                </div>
                <div class="session-metric session-metric--spm">
                  <span class="session-metric__value" data-hud-spm>—</span>
                  <span class="session-metric__label">Strokes /min</span>
                </div>
                <div class="session-metric session-metric--hr">
                  <span class="session-metric__value" data-hud-hr>—</span>
                  <span class="session-metric__label">HR <span class="hr-indicator hr-indicator--inline" data-hr-indicator data-connected="0" title="HR not connected"><span class="hr-indicator__dot" aria-hidden="true"></span></span></span>
                </div>
                <div class="session-metric session-metric--pace">
                  <span class="session-metric__value" data-hud-split>—</span>
                  <span class="session-metric__prog" data-hud-prog>—</span>
                  <span class="session-metric__label">Pace /500m</span>
                </div>
              </div>`
        }
      </div>
    `;
  }

  function liveHudHtml(): string {
    const liveStats = controller?.getStats();
    const regattaText = liveStats?.regattaMessage?.text?.trim() || '';
    const hazardText = liveStats?.inHazardZone
      ? liveStats.hazardWarning?.trim() || ''
      : '';
    const landscape = isLandscapeOrientation();
    if (!landscape && fsTab !== 'metrics') fsTab = 'metrics';
    return `
      <section class="session-live-hud" aria-live="polite">
        <div class="session-fs-chrome">
          <span class="session-fs-timer" data-hud-timer>0:00</span>
          <nav class="session-fs-tabs" aria-label="Session view" ${landscape ? '' : 'hidden'}>
            <button type="button" class="session-fs-tab" data-fs-tab="metrics" aria-selected="${fsTab === 'metrics' ? 'true' : 'false'}">Metrics</button>
            <button type="button" class="session-fs-tab" data-fs-tab="speed" aria-selected="${fsTab === 'speed' ? 'true' : 'false'}">Graph</button>
            <button type="button" class="session-fs-tab" data-fs-tab="map" aria-selected="${fsTab === 'map' ? 'true' : 'false'}">Map</button>
          </nav>
          <div class="session-fs-chrome__actions">
            <div
              class="session-channel-badge"
              data-hud-channel
              data-channel="unknown"
              role="status"
              aria-live="polite"
            >
              <span class="session-channel-badge__label">Flow pattern…</span>
              <span class="session-channel-badge__sub"></span>
            </div>
            <button type="button" class="hub-btn hub-btn--danger session-fs-chrome__stop" data-action="stop">Stop</button>
          </div>
        </div>
        <div class="session-live-hud__alert" data-hud-capsize ${capsizeActive ? '' : 'hidden'} role="alert">
          ⚠ CAPSIZE — boat tipped. Check crew now.
        </div>
        <div class="session-live-hud__hazard" data-hud-hazard ${hazardText ? '' : 'hidden'} role="alert" aria-live="assertive">
          <span class="session-live-hud__hazard-label">⚠ Hazard zone</span>
          <span class="session-live-hud__hazard-text" data-hud-hazard-text>${hazardText ? esc(hazardText) : ''}</span>
        </div>
        <div class="session-live-hud__regatta" data-hud-regatta ${regattaText ? '' : 'hidden'} role="status" aria-live="polite">
          <span class="session-live-hud__regatta-label">Regatta control</span>
          <p class="session-live-hud__regatta-text" data-hud-regatta-text>${regattaText ? esc(regattaText) : ''}</p>
        </div>
        <div class="session-fs-panel ${fsTab === 'metrics' ? 'is-active' : ''}" data-fs-panel="metrics">
          <div class="session-zone-badge" data-hud-zone data-zone="unknown" aria-live="polite">
            <span class="session-zone-badge__label">Locating…</span>
            <span class="session-zone-badge__sub"></span>
          </div>
          ${metricsBlockHtml('hero')}
        </div>
        <div class="session-fs-panel session-fs-panel--split session-fs-panel--media ${fsTab === 'speed' ? 'is-active' : ''}" data-fs-panel="speed">
          <div class="session-speed-chart-wrap">
            <canvas data-speed-chart aria-label="Speed versus time last 8 minutes"></canvas>
          </div>
          <div class="session-metrics-overlay" aria-label="Session metrics">
            ${metricsBlockHtml('overlay')}
          </div>
        </div>
        <div class="session-fs-panel session-fs-panel--map session-fs-panel--media ${fsTab === 'map' ? 'is-active' : ''}" data-fs-panel="map">
          <div class="session-map-stage">
            <div class="session-map-wrap" data-session-map></div>
            <button type="button" class="session-map-follow ${sessionMapFollow ? 'is-active' : ''}" data-map-follow aria-pressed="${sessionMapFollow ? 'true' : 'false'}">${sessionMapFollow ? 'Following' : 'Follow'}</button>
            <div class="session-metrics-overlay" aria-label="Session metrics">
              ${metricsBlockHtml('overlay')}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function wrapRecordingStage(body: string): string {
    return `
      <div class="session-stage session-stage--fullscreen" data-session-stage>
        ${spectrumRailsHtml()}
        <div class="session-stage__inner">${body}</div>
      </div>
    `;
  }

  function recordIdleHtml(): string {
    const s = loadSettings();
    const armed = Boolean(standby);
    const standbyLine = armed ? standbyStatus?.message || 'Standby on' : '';
    const standbyHazard = armed ? standbyStatus?.hazardWarning?.trim() || '' : '';
    const standbyInfo =
      'Standby watches boat-park geofences and auto-starts a session when you leave the park. Recording pauses inside the park and can auto-stop when you re-enter.';
    return `
      <section class="hub-panel actions actions--idle session-actions-panel">
        <div class="session-standby-hazard" data-standby-hazard ${standbyHazard ? '' : 'hidden'} role="alert" aria-live="assertive">
          <span class="session-standby-hazard__label">⚠ Hazard zone</span>
          <span class="session-standby-hazard__text" data-standby-hazard-text>${standbyHazard ? esc(standbyHazard) : ''}</span>
        </div>
        <button type="button" class="hub-btn hub-btn--primary hub-btn-lg" data-action="start">Start session</button>
        ${
          s.geofenceSessionControl !== false
            ? `<div class="standby-row">
                <button type="button" class="hub-btn ${armed ? 'hub-btn--danger' : 'hub-btn--ghost'} hub-btn-lg" data-action="toggle-standby">${armed ? 'End standby' : 'Standby'}</button>
                <button type="button" class="info-btn" data-info-toggle aria-label="About Standby">i</button>
                <p class="info-help" hidden>${esc(standbyInfo)}</p>
              </div>`
            : ''
        }
        ${standbyLine ? `<p class="poll-line session-standby-hint">${esc(standbyLine)}</p>` : '<p class="poll-line session-standby-hint" hidden></p>'}
        <button type="button" class="hub-btn hub-btn--ghost" data-action="clear-session">Clear session</button>
      </section>
    `;
  }

  function historyHtml(): string {
    const s = loadSettings();
    const name = s.deviceId?.trim() || '—';
    // No CrewSight title bar here — History needs the vertical space for stats/map/charts.
    return `
      <div class="ahd-recorder-shell ahd-recorder-shell--history">
        <div class="hub-stats-bar" aria-live="polite">
          <div class="hub-stats-item"><span class="hub-stats-label">Name</span><strong>${esc(name)}</strong></div>
          <div class="hub-stats-item"><span class="hub-stats-label">History</span><strong>This phone only</strong></div>
        </div>
        <div class="ahd-recorder-main ahd-recorder-main--history">
          <div class="history-panel" data-history-root></div>
        </div>
        ${hubFooter()}
      </div>
    `;
  }

  function recordRecordingControlsHtml(): string {
    return `
      <section class="hub-panel actions actions--recording session-actions-panel">
        <button type="button" class="hub-btn hub-btn--danger hub-btn-lg" data-action="stop">Stop session</button>
        <div class="hr-connect-row">
          <button type="button" class="hub-btn" data-action="connect-hr">Connect HR monitor</button>
          <span class="hr-indicator" data-hr-indicator data-connected="0" title="HR not connected">
            <span class="hr-indicator__dot" aria-hidden="true"></span>
            <span data-hr-indicator-text>HR off</span>
          </span>
        </div>
      </section>
    `;
  }

  function recordHtml(): string {
    const stats = controller?.getStats();
    const shellClass = recording ? 'ahd-recorder-shell ahd-recorder-shell--recording' : 'ahd-recorder-shell';
    const shell = `
      <div class="${shellClass}">
        ${hubHeader()}
        <div class="hub-stats-bar" aria-live="polite">${recordStatsBar(stats)}</div>
        ${recording ? liveHudHtml() : ''}
        <div class="ahd-recorder-main ${recording ? 'ahd-recorder-main--recording' : 'ahd-recorder-main--idle'}">
          ${recording ? recordRecordingControlsHtml() : recordIdleHtml()}
        </div>
        ${hubFooter()}
      </div>
    `;
    return recording ? wrapRecordingStage(shell) : shell;
  }

  function settingsField(
    label: string,
    info: string,
    inputHtml: string,
  ): string {
    return `
      <div class="form-row">
        <div class="form-row__meta">
          <span class="form-row__label">${label}</span>
          <button type="button" class="info-btn" data-info-toggle aria-label="About ${label}">i</button>
        </div>
        ${inputHtml}
        <p class="form-row__help info-help" hidden>${esc(info)}</p>
      </div>
    `;
  }

  function settingsHtml(): string {
    const s = loadSettings();
    const fleet = fleetConfigCache ?? defaultFleetConfig();
    const sampleSec = sampleRateSecFromSettings(s);
    const selectedCoachId =
      s.coachId ||
      fleet.coaches.find((c) => c.name === s.athleteId)?.id ||
      '';
    const selectedBoatId = s.boatId || '';
    const coachOptions = fleet.coaches
      .map(
        (c) =>
          `<option value="${esc(c.id)}" data-name="${esc(c.name)}"${selectedCoachId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`,
      )
      .join('');
    const boatOptions = fleet.boats
      .map(
        (b) =>
          `<option value="${esc(b.id)}" data-class="${esc(b.boatClass)}"${selectedBoatId === b.id ? ' selected' : ''}>${esc(b.label)}</option>`,
      )
      .join('');
    const geofenceInfo =
      'When enabled, use Standby on the Record screen to auto-start when leaving the boat park. Recording is suppressed inside the park and can auto-stop when you re-enter.';
    return `
      <div class="ahd-recorder-shell">
        ${hubHeader()}
        <div class="ahd-recorder-main ahd-recorder-main--settings">
          <div class="ahd-toolbar">
            <h1>Settings</h1>
            <div class="ahd-toolbar-actions">
              <button type="button" class="hub-btn" data-nav="record">Back</button>
            </div>
          </div>
          <form class="hub-panel form" data-settings-form>
            <h2 class="hub-section-title">Crew &amp; upload</h2>
            ${settingsField(
              'Name',
              'Label for this phone on the live map and in session history (e.g. M4x JS).',
              `<input name="deviceId" value="${esc(s.deviceId)}" required placeholder="M4x JS" />`,
            )}
            ${settingsField(
              'Coach',
              'Coach for this outing — options are managed in CrewSight Manager → Setup → Coaches & Boats.',
              `<select name="coachId" aria-label="Coach">
                <option value="">— select coach —</option>
                ${coachOptions}
              </select>
              <input type="hidden" name="coachName" value="${esc(s.athleteId)}" />`,
            )}
            ${settingsField(
              'Boat',
              'Fleet boat for this outing. Prognostic pace uses the boat class (e.g. Karapiro - 1X).',
              `<select name="boatId" required aria-label="Boat">
                <option value="">— select boat —</option>
                ${boatOptions}
              </select>
              <input type="hidden" name="boatClass" value="${esc(s.boatClass)}" />`,
            )}
            ${settingsField(
              'URL',
              'Server address where GPS and sensor samples are uploaded. Use the CrewSight ingest endpoint for your club.',
              `<input name="ingestUrl" value="${esc(s.ingestUrl)}" placeholder="https://rowing-app-recorder-pwa.vercel.app/api/ingest" />`,
            )}
            ${settingsField(
              'Password',
              'Access password (ingest token) required by the server. Ask your club admin if you do not have one.',
              `<input class="form-input-light" name="ingestToken" type="password" value="${esc(s.ingestToken)}" autocomplete="off" />`,
            )}
            ${settingsField(
              'Sample interval',
              'How often GPS and sensors are sampled, in seconds. Lower values use more battery but give finer tracks (e.g. 1 = once per second).',
              `<input class="form-input-light" name="sampleRateSec" type="number" min="0.5" step="0.5" value="${sampleSec}" inputmode="decimal" />`,
            )}
            <fieldset class="fieldset checks">
              <legend>Sensors</legend>
              <label class="check"><input type="checkbox" name="enableGps" ${s.enableGps ? 'checked' : ''} /> GPS</label>
              <label class="check"><input type="checkbox" name="enableMotion" ${s.enableMotion ? 'checked' : ''} /> Accelerometer</label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend class="fieldset-legend-with-info">
                Heart rate
                <button type="button" class="info-btn" data-info-toggle aria-label="About heart rate">i</button>
              </legend>
              <p class="info-help" hidden>${esc(
                'Put on a Bluetooth heart-rate strap and tap Connect HR monitor to pick it from the list. The last strap is remembered so later Connect / session start can reconnect without picking again (Android). You can pair here before starting a session.',
              )}</p>
              <label class="check"><input type="checkbox" name="enableHr" ${s.enableHr ? 'checked' : ''} /> Enable heart rate</label>
              <div class="hr-connect-row">
                <button type="button" class="hub-btn hub-btn--primary" data-action="connect-hr">Connect HR monitor</button>
                <span class="hr-indicator" data-hr-indicator data-connected="0" title="HR not connected">
                  <span class="hr-indicator__dot" aria-hidden="true"></span>
                  <span data-hr-indicator-text>HR off</span>
                </span>
              </div>
              <p class="form-hint">Tap Connect to pair now — works before or during a session. Last strap is remembered on this phone.</p>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Background recording</legend>
              <label class="check"><input type="checkbox" name="enableBackgroundRecording" ${s.enableBackgroundRecording !== false ? 'checked' : ''} ${IS_NATIVE ? 'disabled' : ''} /> ${IS_NATIVE ? 'Always on in native app' : 'Allow background (best effort)'}</label>
              <label class="check"><input type="checkbox" name="keepScreenOn" ${s.keepScreenOn !== false ? 'checked' : ''} /> Keep screen on while recording</label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend class="fieldset-legend-with-info">
                Geofence session control
                <button type="button" class="info-btn" data-info-toggle aria-label="About geofence session control">i</button>
              </legend>
              <p class="info-help" hidden>${esc(geofenceInfo)}</p>
              <label class="check"><input type="checkbox" name="geofenceSessionControl" ${s.geofenceSessionControl !== false ? 'checked' : ''} /> Auto start/stop via boat-park geofences</label>
            </fieldset>
            <div class="form-actions">
              <button type="submit" class="hub-btn hub-btn--primary">Save settings</button>
              ${IS_NATIVE ? '<button type="button" class="hub-btn" data-action="phone-setup">Phone permissions &amp; battery</button>' : ''}
              <button type="button" class="hub-btn" data-action="clear-session">Clear session</button>
            </div>
          </form>
          <section class="hub-panel" data-stroke-debug-panel>
            <h2 class="hub-section-title">Stroke rate debug</h2>
            <p class="form-hint">
              Captures full-rate accelerometer + detected stroke markers on this phone
              (not the sparse cloud upload). Do short steady pieces at different rates,
              then export JSON and open it in <code>stroke-debug.html</code> on a computer.
            </p>
            <p class="form-hint" data-stroke-debug-status></p>
            <div class="form-actions">
              <button type="button" class="hub-btn hub-btn--primary" data-action="stroke-debug-30">Record 30s</button>
              <button type="button" class="hub-btn hub-btn--primary" data-action="stroke-debug-60">Record 60s</button>
              <button type="button" class="hub-btn hub-btn--danger" data-action="stroke-debug-stop">Stop &amp; export</button>
              <button type="button" class="hub-btn" data-action="stroke-debug-export">Export last</button>
            </div>
          </section>
          ${logPanelHtml()}
        </div>
        ${hubFooter()}
      </div>
    `;
  }

  function updateHrIndicator(): void {
    const st = getHrConnectionStatus();
    root.querySelectorAll('[data-hr-indicator]').forEach((el) => {
      el.setAttribute('data-connected', st.connected ? '1' : '0');
      const label = st.connected
        ? `HR connected${st.name ? `: ${st.name}` : ''}${st.lastBpm != null ? ` · ${st.lastBpm}` : ''}`
        : st.savedDevice
          ? `HR not connected (remembered: ${st.savedDevice.name})`
          : 'HR not connected';
      el.setAttribute('title', label);
      el.setAttribute('aria-label', label);
      const text = el.querySelector('[data-hr-indicator-text]');
      if (text) {
        text.textContent = st.connected
          ? st.lastBpm != null
            ? `HR ${st.lastBpm}`
            : 'HR on'
          : 'HR off';
      }
    });
    if (st.connected && st.lastBpm != null) {
      setHudText('[data-hud-hr]', String(st.lastBpm));
    }
  }

  async function connectHrMonitor(): Promise<void> {
    const form = root.querySelector('[data-settings-form]') as HTMLFormElement | null;
    const hrCheck = form?.querySelector('[name="enableHr"]') as HTMLInputElement | null;
    if (hrCheck) hrCheck.checked = true;

    const next = { ...loadSettings(), enableHr: true };
    saveSettings(next);
    settings = next;

    // Open the BLE picker immediately (must stay in the user-gesture chain).
    try {
      if (recording && controller) {
        await controller.connectHr();
      } else {
        await pairHeartRate((m) => pushLog(m, false));
      }
    } catch (e) {
      pushLog(
        `HR connect failed: ${e instanceof Error ? e.message : String(e)}`,
        false,
      );
    }
    updateHrIndicator();
    refreshLogPre();
  }

  function clearStandbyUi(): void {
    if (nativeStandbyPollTimer) {
      clearInterval(nativeStandbyPollTimer);
      nativeStandbyPollTimer = null;
    }
    if (!IS_NATIVE) {
      standby?.stop();
    }
    standby = null;
    standbyStatus = null;
  }

  async function stopStandby(): Promise<void> {
    clearStandbyUi();
    if (IS_NATIVE) {
      const native = await getNativeActiveSession();
      if (native?.standbyArmed && !native.active) {
        await disarmNativeGeofenceStandby();
      }
    }
  }

  function syncStandbyHazardBanner(warning: string | null | undefined): void {
    const el = root.querySelector('[data-standby-hazard]') as HTMLElement | null;
    if (!el) return;
    const text = warning?.trim() || '';
    const textEl = el.querySelector('[data-standby-hazard-text]');
    if (text) {
      el.removeAttribute('hidden');
      if (textEl) textEl.textContent = text;
    } else {
      el.setAttribute('hidden', '');
      if (textEl) textEl.textContent = '';
    }
  }

  function applyStandbyStatus(st: StandbyStatus | NativeStandbyStatus): void {
    const hazardWarning =
      'hazardWarning' in st ? (st as StandbyStatus).hazardWarning ?? null : null;
    standbyStatus = {
      armed: st.armed,
      inside: st.inside,
      zoneName: st.zoneName,
      message: st.message,
      hazardWarning,
    };
    if (!recording && view === 'record') {
      const hint = root.querySelector('.session-standby-hint');
      if (hint) {
        hint.textContent = st.message;
        hint.hidden = !st.message;
      }
      syncStandbyHazardBanner(hazardWarning);
      const btn = root.querySelector('[data-action="toggle-standby"]');
      if (btn) {
        btn.textContent = 'End standby';
        btn.classList.add('hub-btn--danger');
        btn.classList.remove('hub-btn--ghost');
      }
    }
  }

  async function syncGeofencesToNative(s: ReturnType<typeof loadSettings>): Promise<void> {
    if (!IS_NATIVE) return;
    try {
      const list = await fetchGeofences(s.ingestUrl, s.ingestToken, true, 8000);
      await setNativeGeofences(
        list.map((g) => ({
          name: g.name,
          kind: g.kind,
          shapeType: g.shapeType,
          centerLat: g.centerLat,
          centerLon: g.centerLon,
          radiusM: g.radiusM,
          polygonCoords: g.polygonCoords,
          enabled: g.enabled,
          economyIntervalSec: g.economyIntervalSec,
          disableCapsize: g.disableCapsize,
          suppressRecording: g.suppressRecording,
          autoStopOnEnter: g.autoStopOnEnter,
          autoStartOnExit: g.autoStartOnExit,
          sessionDwellSec: g.sessionDwellSec,
        })),
      );
    } catch (e) {
      pushLog(
        `Geofence sync failed: ${e instanceof Error ? e.message : String(e)}`,
        false,
      );
    }
  }

  function startNativeStandbyPoll(): void {
    if (!IS_NATIVE || nativeStandbyPollTimer) return;
    nativeStandbyPollTimer = setInterval(() => {
      void (async () => {
        const native = await getNativeActiveSession();
        if (native?.active && !recording) {
          await tryAutoResume('Native geofence auto-started session — restoring controls…');
          return;
        }
        const st = await getNativeStandbyStatus();
        if (st?.armed) {
          applyStandbyStatus(st);
        } else if (!recording && nativeStandbyPollTimer) {
          clearInterval(nativeStandbyPollTimer);
          nativeStandbyPollTimer = null;
          standbyStatus = null;
          renderUnlessSettings();
        }
      })();
    }, 2000);
  }

  async function adoptNativeStandbyUi(message?: string): Promise<void> {
    standby = {
      stop: () => {
        void stopStandby();
      },
      getStatus: () =>
        standbyStatus ?? {
          armed: true,
          inside: false,
          zoneName: null,
          message: message ?? 'Geofence standby armed',
        },
    };
    const st = await getNativeStandbyStatus();
    if (st?.armed) {
      applyStandbyStatus(st);
    } else if (message) {
      standbyStatus = {
        armed: true,
        inside: false,
        zoneName: null,
        message,
      };
    }
    startNativeStandbyPoll();
    render();
  }

  async function armStandby(): Promise<void> {
    if (recording) {
      pushLog('Stop the session before arming geofence standby.');
      return;
    }
    if (standby) {
      pushLog('Geofence standby is already armed.');
      render();
      return;
    }
    const s = loadSettings();
    if (s.geofenceSessionControl === false) {
      pushLog('Enable geofence session control in Settings first.');
      return;
    }
    if (!s.deviceId.trim()) {
      pushLog('Set Device ID in Settings before arming standby.');
      return;
    }
    if (!s.enableGps) {
      pushLog('Enable GPS in Settings — standby needs location.');
      return;
    }
    pushLog('Arming geofence standby…');
    if (IS_NATIVE) {
      try {
        const p = await requestNativePermissions();
        if (p.recordingSetup) {
          for (const line of recordingSetupLogLines(p.recordingSetup)) {
            pushLog(line);
          }
        }
      } catch (e) {
        pushLog(`Permissions error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      await syncGeofencesToNative(s);
      const ok = await armNativeGeofenceStandby({
        deviceId: s.deviceId,
        ingestUrl: s.ingestUrl,
        ingestToken: s.ingestToken,
        athleteId: s.athleteId,
        enableGps: s.enableGps,
        enableMotion: s.enableMotion,
        gpsIntervalMs: s.gpsIntervalMs,
      });
      if (!ok) {
        pushLog('Could not arm native geofence standby.');
        return;
      }
      pushLog('Native geofence standby armed — auto-start after leaving park.');
      await adoptNativeStandbyUi('Armed — waiting for GPS…');
      return;
    }
    try {
      standby = await startGeofenceStandby(s, {
        onLog: (msg) => pushLog(msg),
        onStatus: (st) => {
          applyStandbyStatus(st);
        },
        onAutoStart: async () => {
          await stopStandby();
          await beginRecording({ skipPermissions: true });
        },
      });
      standbyStatus = standby.getStatus();
      pushLog(standbyStatus.message || 'Geofence standby armed.');
      render();
    } catch (e) {
      standby = null;
      standbyStatus = null;
      pushLog(`Could not arm standby: ${e instanceof Error ? e.message : String(e)}`);
      render();
    }
  }

  async function beginRecording(opts?: {
    resume?: SessionMeta;
    skipNativeStart?: boolean;
    skipPermissions?: boolean;
  }): Promise<void> {
    if (recording) return;
    clearStandbyUi();
    const s = loadSettings();
    if (IS_NATIVE && opts?.skipNativeStart) {
      await syncGeofencesToNative(s);
    }
    if (IS_NATIVE && !opts?.skipPermissions) {
      try {
        const p = await requestNativePermissions();
        if (p.recordingSetup) {
          for (const line of recordingSetupLogLines(p.recordingSetup)) {
            pushLog(line);
          }
        } else {
          if (p.notifications !== 'granted') {
            pushLog('Allow notifications for capsize alarms when the screen is off.');
          }
          if (p.location !== 'granted') {
            pushLog('Allow location (Always) for GPS while recording.');
          }
        }
      } catch (e) {
        pushLog(`Permissions error: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    sessionStartedAt = opts?.resume?.startedAt ?? Date.now();
    speedAvg.clear();
    strokeRateAvg.clear();
    if (!opts?.resume) clearSessionSpeedBuffer();
    fsTab = 'metrics';
    destroySessionMap();

    if (!opts?.resume) {
      await clearPendingOutbox();
    }

    controller = await startRecorder(
      s,
      () => updateLiveHud(),
      pushLog,
      async (n) => {
        const el = root.querySelector('[data-pending]');
        if (el) el.textContent = String(n);
        updateLiveHud();
      },
      (active) => {
        capsizeActive = active;
        updateLiveHud();
      },
      {
        onBackgroundPulse: () => void runSync(false),
        onGeofenceAutoStop: () => {
          void (async () => {
            if (!recording) return;
            pushLog('Auto-stopped — back inside boat-park geofence.');
            if (syncTimer) clearInterval(syncTimer);
            syncTimer = null;
            stopHudTimer();
            sessionStartedAt = null;
            speedAvg.clear();
            strokeRateAvg.clear();
            clearSessionSpeedBuffer();
            destroySessionMap();
            fsTab = 'metrics';
            await exitStageFullscreen();
            stopBackgroundSession();
            const settingsNow = loadSettings();
            if (IS_NATIVE && settingsNow.geofenceSessionControl !== false) {
              await controller?.stopForGeofenceStandby();
              controller = null;
              recording = false;
              capsizeActive = false;
              backgroundStatus = 'foreground';
              clearRecordingActive();
              await runSync(true);
              const transitioned = await transitionToNativeGeofenceStandby();
              if (transitioned) {
                pushLog('Native standby armed — auto-start when leaving boat park.');
                await adoptNativeStandbyUi('In boat park — leave to auto-start');
              } else {
                pushLog('Could not arm native standby — arm manually on Record screen.');
                render();
              }
              return;
            }
            await controller?.stop();
            controller = null;
            recording = false;
            capsizeActive = false;
            backgroundStatus = 'foreground';
            clearRecordingActive();
            await runSync(true);
            if (settingsNow.geofenceSessionControl !== false) {
              await armStandby();
            } else {
              render();
            }
          })();
        },
      },
      {
        resume: opts?.resume,
        skipNativeStart: opts?.skipNativeStart,
      },
    );
    if (!controller) return;

    recording = true;
    backgroundStatus = 'foreground';
    markRecordingActive(controller.sessionId, s.deviceId, sessionStartedAt);

    await startBackgroundSession(s, {
      onFlush: () => controller!.flush(),
      onSync: runSync,
      onLog: pushLog,
      onStatus: (status) => {
        backgroundStatus = status;
        renderUnlessSettings();
      },
    });

    if (s.enableHr) {
      const hr = getHrConnectionStatus();
      pushLog(
        hr.connected
          ? `Heart rate linked (${hr.name || 'strap'}).`
          : 'Heart rate on — tap Connect HR monitor to pair your strap.',
        false,
      );
    }
    const batchMs = s.enableMotion ? Math.max(s.uploadBatchMs, 8000) : s.uploadBatchMs;
    const syncInterval = Math.max(4000, Math.min(batchMs, 12000));
    syncTimer = setInterval(() => void runSync(false), syncInterval);
    void runSync(false);
    render();
    startHudTimer();
    await enterStageFullscreen();
  }

  async function tryAutoResume(reason?: string): Promise<void> {
    if (recording || resumeInFlight) return;
    resumeInFlight = true;
    try {
      if (!IS_NATIVE) {
        const interrupted = getInterruptedRecording();
        if (interrupted) {
          pushLog(
            `Previous session may have ended unexpectedly (${interrupted.deviceId}, ${new Date(interrupted.startedAt).toLocaleTimeString()}). Check upload queue.`,
          );
          clearRecordingActive();
        }
        return;
      }

      const persisted = getPersistedRecording();
      const native = await getNativeActiveSession();
      const s = loadSettings();
      if (IS_NATIVE) {
        await syncGeofencesToNative(s);
      }
      const resumeSessionId = native?.sessionId ?? persisted?.sessionId ?? '';
      const storedResume = resumeSessionId
        ? await getSession(resumeSessionId)
        : undefined;
      const decision = resolveResumeCandidate(
        native,
        persisted,
        s.deviceId,
        storedResume,
      );

      if (decision.action === 'stale') {
        pushLog(
          `Not resuming — ${decision.reason}. Tap Start for a new session.`,
        );
        void postSessionEnd(s.ingestUrl, s.ingestToken, {
          sessionId: decision.sessionId,
          deviceId: decision.deviceId,
          athleteId: s.athleteId,
          endedAt: storedResume?.endedAt ?? Date.now(),
        }).catch(() => {});
        if (native?.serviceRunning) {
          await stopNativeCapsizeMonitor();
        }
        clearRecordingActive();
        return;
      }

      if (decision.action === 'none') {
        const interrupted = getInterruptedRecording();
        if (interrupted) {
          pushLog(
            `Previous session may have ended unexpectedly (${interrupted.deviceId}, ${new Date(interrupted.startedAt).toLocaleTimeString()}). Check upload queue.`,
          );
        }
        clearRecordingActive();
        return;
      }

      if (decision.action === 'mismatch') {
        pushLog(
          `Saved recording (${decision.savedDeviceId}) does not match Device ID (${decision.settingsDeviceId}) — not resuming.`,
        );
        clearRecordingActive();
        return;
      }

      const { candidate } = decision;
      const stored = await getSession(candidate.sessionId);
      const resume: SessionMeta = stored ?? {
        sessionId: candidate.sessionId,
        deviceId: candidate.deviceId,
        athleteId: candidate.athleteId ?? s.athleteId,
        startedAt: candidate.startedAt ?? Date.now(),
      };

      pushLog(
        candidate.serviceRunning
          ? reason ??
              (native?.autoStartedSession
                ? 'Restoring auto-started recording session…'
                : 'Restoring recording session (background service still running)…')
          : 'Resuming recording session after restart…',
        false,
      );
      await beginRecording({
        resume,
        skipNativeStart: candidate.serviceRunning,
        skipPermissions: true,
      });
      if (recording) {
        pushLog('Session resumed automatically — Stop is available.');
      }
    } finally {
      resumeInFlight = false;
    }
  }

  function bind() {
    root.querySelectorAll('[data-info-toggle]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const host =
          (btn as HTMLElement).closest('.form-row, .standby-row, .fieldset') ||
          btn.parentElement;
        const help = host?.querySelector('.info-help') as HTMLElement | null;
        if (!help) return;
        help.hidden = !help.hidden;
        btn.setAttribute('aria-expanded', help.hidden ? 'false' : 'true');
      });
    });

    const goNav = (next: View) => {
      if (recording && next !== 'record') {
        pushLog('Stop the session before leaving Record.', false);
        return;
      }
      if (next === 'settings') {
        fleetConfigCache = fleetConfigCache ?? getCachedFleetConfig();
      }
      historyPanel?.prepareForRender(next);
      view = next;
      render();
      if (next === 'settings') void refreshFleetConfigInBackground();
    };

    root.querySelectorAll<HTMLButtonElement>('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.nav as View | undefined;
        if (next === 'record' || next === 'history' || next === 'settings') goNav(next);
      });
    });

    const syncFleetFormFields = () => {
      const form = root.querySelector('[data-settings-form]') as HTMLFormElement | null;
      if (!form) return;
      const coachSel = form.querySelector('[name="coachId"]') as HTMLSelectElement | null;
      const coachName = form.querySelector('[name="coachName"]') as HTMLInputElement | null;
      const boatSel = form.querySelector('[name="boatId"]') as HTMLSelectElement | null;
      const boatClass = form.querySelector('[name="boatClass"]') as HTMLInputElement | null;
      if (coachSel && coachName) {
        const opt = coachSel.selectedOptions[0];
        coachName.value = opt?.dataset.name || opt?.textContent?.trim() || '';
      }
      if (boatSel && boatClass) {
        const opt = boatSel.selectedOptions[0];
        boatClass.value = opt?.dataset.class || '';
      }
    };

    root.querySelector('[name="coachId"]')?.addEventListener('change', syncFleetFormFields);
    root.querySelector('[name="boatId"]')?.addEventListener('change', syncFleetFormFields);

    root.querySelector('[data-settings-form]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      syncFleetFormFields();
      const next = settingsFromForm(form);
      const fleet = fleetConfigCache ?? defaultFleetConfig();
      const boat = findBoat(fleet, next.boatId);
      const coach = findCoach(fleet, next.coachId || '');
      if (boat) next.boatClass = boat.boatClass;
      if (coach) next.athleteId = coach.name;
      saveSettings(next);
      settings = next;
      view = 'record';
      pushLog('Settings saved.', false);
      render();
    });

    root.querySelector('[data-action="toggle-log"]')?.addEventListener('click', () => {
      logExpanded = !logExpanded;
      render();
    });

    root.querySelector('[data-action="phone-setup"]')?.addEventListener('click', async () => {
      if (!IS_NATIVE) return;
      try {
        const setup = await prepareNativeRecordingSetup();
        if (setup) {
          for (const line of recordingSetupLogLines(setup)) {
            pushLog(line, false);
          }
          refreshLogPre();
        } else {
          pushLog('Phone setup is only available in the Android app.', false);
        }
      } catch (e) {
        pushLog(
          `Phone setup error: ${e instanceof Error ? e.message : String(e)}`,
          false,
        );
      }
    });

    root.querySelector('[data-action="stroke-debug-30"]')?.addEventListener('click', () => {
      void startStrokeDebug(30);
    });
    root.querySelector('[data-action="stroke-debug-60"]')?.addEventListener('click', () => {
      void startStrokeDebug(60);
    });
    root.querySelector('[data-action="stroke-debug-stop"]')?.addEventListener('click', () => {
      void stopStrokeDebugAndExport();
    });
    root.querySelector('[data-action="stroke-debug-export"]')?.addEventListener('click', () => {
      void stopStrokeDebugAndExport();
    });
    refreshStrokeDebugStatus();

    root.querySelectorAll('[data-action="connect-hr"]').forEach((el) => {
      el.addEventListener('click', () => {
        void connectHrMonitor();
      });
    });

    root.querySelector('[data-action="start"]')?.addEventListener('click', () => {
      void beginRecording();
    });

    root.querySelector('[data-action="toggle-standby"]')?.addEventListener('click', () => {
      if (standby) {
        void stopStandby().then(() => {
          pushLog('Geofence standby disarmed.');
          render();
        });
      } else {
        void armStandby();
      }
    });

    root.querySelectorAll('[data-action="stop"]').forEach((el) => {
      el.addEventListener('click', async () => {
        if (syncTimer) clearInterval(syncTimer);
        stopHudTimer();
        sessionStartedAt = null;
        speedAvg.clear();
        strokeRateAvg.clear();
        clearSessionSpeedBuffer();
        channelCoursePrev = null;
        channelCourseDeg = null;
        destroySessionMap();
        fsTab = 'metrics';
        await exitStageFullscreen();
        stopBackgroundSession();
        await controller?.stop();
        controller = null;
        recording = false;
        capsizeActive = false;
        backgroundStatus = 'foreground';
        clearRecordingActive();
        await runSync(true);
        render();
      });
    });

    root.querySelector('[data-map-follow]')?.addEventListener('click', () => {
      setSessionMapFollow(true);
    });

    root.querySelectorAll('[data-fs-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-fs-tab') as FsTab | null;
        if (tab === 'metrics' || tab === 'speed' || tab === 'map') setFsTab(tab);
      });
    });

    root.querySelectorAll('[data-action="clear-session"]').forEach((el) => {
      el.addEventListener('click', () => {
        void clearSession();
      });
    });

    void updatePending();
    updateHrIndicator();
  }

  subscribeHrConnection(() => {
    updateHrIndicator();
  });

  render();
  void refreshFleetConfigInBackground();
  void repairOversizedPendingOutbox().then((n) => {
    if (n > 0) pushLog(`Split ${n} oversized queued batch(es) for upload.`);
  });
  if (IS_NATIVE) {
    const onForegroundResume = () => {
      if (document.visibilityState !== 'visible') return;
      void (async () => {
        const s = loadSettings();
        if (IS_NATIVE) {
          await syncGeofencesToNative(s);
        }
        if (recording) return;
        const native = await getNativeActiveSession();
        if (native?.active) {
          await tryAutoResume('Recording still active — restoring session controls…');
          return;
        }
        if (native?.standbyArmed) {
          await adoptNativeStandbyUi();
        }
      })();
    };
    document.addEventListener('visibilitychange', onForegroundResume);

    void (async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const native = await getNativeActiveSession();
      if (native?.standbyArmed && !native.active) {
        await adoptNativeStandbyUi('Geofence standby active — leave park to auto-start');
        return;
      }
      await tryAutoResume();
    })();
  } else {
    const interrupted = getInterruptedRecording();
    if (interrupted) {
      pushLog(
        `Previous session may have ended unexpectedly (${interrupted.deviceId}, ${new Date(interrupted.startedAt).toLocaleTimeString()}). Check upload queue.`,
      );
      clearRecordingActive();
    }
  }
  pushLog('CrewSight ready. Set Device ID in Settings, then start a session.');
  if (IS_NATIVE) {
      void (async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        try {
          const p = await requestNativePermissions();
          pushLog(
            `Permissions — notifications: ${p.notifications}, location: ${p.location}, accelerometer: ${p.accelerometer}`,
            false,
          );
          refreshLogPre();
        } catch (e) {
          pushLog(
            `Permission setup error: ${e instanceof Error ? e.message : String(e)}`,
            false,
          );
          refreshLogPre();
        }
      })();
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}
