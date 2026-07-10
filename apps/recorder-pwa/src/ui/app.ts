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
  getNativeActiveSession,
  prepareNativeRecordingSetup,
  recordingSetupLogLines,
  setNativeLiveMapMode,
  stopNativeCapsizeMonitor,
} from '../lib/native-capsize-monitor';
import { resolveResumeCandidate } from '../lib/session-resume';
import { startRecorder, type RecorderController } from '../session/recorder';
import {
  startGeofenceStandby,
  type StandbyController,
  type StandbyStatus,
} from '../lib/geofence-standby';
import { clearPendingOutbox, countPendingOutbox, getSession } from '../session/store';
import { flushOutbox } from '../upload/sync';
import { repairOversizedPendingOutbox } from '../session/store';
import {
  formatSplit500m,
  formatPaceWithPrognostic,
  hrToT,
  MetricRollingAvg,
  SPEED_AVG_WINDOW_MS,
  STROKE_AVG_WINDOW_MS,
  splitSecFromMps,
  splitSecToT,
  updateSpectrumRail,
} from './session-display';

type View = 'record' | 'settings';

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
  let recording = false;
  let capsizeActive = false;
  let backgroundStatus: BackgroundStatus = 'foreground';
  let controller: RecorderController | null = null;
  let standby: StandbyController | null = null;
  let standbyStatus: StandbyStatus | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let sessionStartedAt: number | null = null;
  let hudTickTimer: ReturnType<typeof setInterval> | null = null;
  let logExpanded = false;
  let resumeInFlight = false;
  const speedAvg = new MetricRollingAvg(SPEED_AVG_WINDOW_MS, 0.15);
  const strokeRateAvg = new MetricRollingAvg(STROKE_AVG_WINDOW_MS, 0);
  const settings = loadSettings();

  document.addEventListener('fullscreenchange', () => {
    const stage = root.querySelector('[data-session-stage]');
    if (!stage) return;
    stage.classList.toggle(
      'session-stage--fullscreen',
      document.fullscreenElement === stage,
    );
    const btn = root.querySelector('[data-action="toggle-fullscreen"]');
    if (btn) {
      btn.textContent =
        document.fullscreenElement === stage ? 'Exit fullscreen' : 'Fullscreen';
    }
  });

  const logLines: string[] = [];
  const refreshLogPre = () => {
    const pre = root.querySelector('.hub-panel.log pre');
    if (pre) pre.textContent = logLines.join('\n') || 'Ready.';
  };
  const pushLog = (msg: string, rerender = true) => {
    const t = new Date().toLocaleTimeString();
    logLines.unshift(`[${t}] ${msg}`);
    if (logLines.length > 80) logLines.length = 80;
    if (rerender) render();
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
        render();
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
      void exitStageFullscreen();
      stopBackgroundSession();
      await controller?.stop();
      controller = null;
      recording = false;
      capsizeActive = false;
      backgroundStatus = 'foreground';
    }
    clearRecordingActive();
    if (IS_NATIVE) {
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
    const el = root.querySelector(sel);
    if (el) el.textContent = text;
  }

  function updateLiveHud(): void {
    if (!recording || view !== 'record') return;
    const stats = controller?.getStats();
    const elapsed = sessionStartedAt != null ? Date.now() - sessionStartedAt : 0;

    setHudText('[data-hud-timer]', formatElapsed(elapsed));

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

    if (stats?.speedMps != null && stats.speedMps >= 0.15) {
      speedAvg.push(stats.speedMps);
    }
    const avgMps = speedAvg.average();
    const s = loadSettings();
    setHudText(
      '[data-hud-split]',
      formatPaceWithPrognostic(avgMps, s.deviceId, s.athleteId),
    );

    const splitSec = splitSecFromMps(avgMps);
    updateSpectrumRail(
      root.querySelector('[data-rail-speed]') as HTMLElement | null,
      splitSec != null ? splitSecToT(splitSec) : undefined,
    );
    const hr = stats?.lastHr;
    updateSpectrumRail(
      root.querySelector('[data-rail-hr]') as HTMLElement | null,
      hr != null && hr > 0 ? hrToT(hr) : undefined,
    );

    const capsizeEl = root.querySelector('[data-hud-capsize]');
    if (capsizeEl) {
      if (capsizeActive) capsizeEl.removeAttribute('hidden');
      else capsizeEl.setAttribute('hidden', '');
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
        zoneEl.setAttribute('data-zone', 'boat_park');
        const zoneName = stats.boatParkName?.trim();
        if (label) {
          label.textContent = stats.recordingSuppressed
            ? `${zoneName || 'Geofence zone'} · paused`
            : zoneName || 'Geofence zone';
        }
        if (sub) sub.textContent = '';
      } else {
        zoneEl.setAttribute('data-zone', 'on_water');
        if (label) label.textContent = 'On water';
        if (sub) sub.textContent = '';
      }
    }

    const pending = root.querySelector('[data-pending]');
    if (pending) pending.textContent = String(stats?.pendingOutbox ?? 0);

    const statsBar = root.querySelector('.hub-stats-bar');
    if (statsBar) statsBar.innerHTML = recordStatsBar(stats);
  }

  function startHudTimer(): void {
    stopHudTimer();
    updateLiveHud();
    hudTickTimer = setInterval(() => updateLiveHud(), 1000);
  }

  function render() {
    root.innerHTML = view === 'settings' ? settingsHtml() : recordHtml();
    bind();
    if (recording && view === 'record') updateLiveHud();
  }

  function hubHeader(): string {
    return `
      <header class="hub-topbar hub-topbar--recorder">
        <div class="hub-topbar-inner">
          <div class="hub-topbar-brands">
            <img src="${asset('assets/crewsight/crewsight-logo-full-color.png')}" alt="CrewSight" class="hub-crewsight-logo hub-crewsight-logo--recorder" width="300" height="300" />
          </div>
          <p class="hub-tagline hub-tagline--title">GPS rowing recorder${IS_NATIVE ? ' · Native app' : ''}</p>
        </div>
      </header>
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
      </footer>
    `;
  }

  function recordStatsBar(stats: ReturnType<RecorderController['getStats']> | undefined): string {
    const device = settings.deviceId || '—';
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
        if ((np.heartbeatGpsCount ?? 0) > 0) {
          gpsDiag += ` hbGps=${np.heartbeatGpsCount}`;
        }
      }
    }
    return `
      <span class="hub-stats-item ${statusClass}">${status}</span>
      <span class="hub-stats-sep" aria-hidden="true">·</span>
      <span class="hub-stats-item">Device: ${esc(device)}</span>
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

  function liveHudHtml(): string {
    const regattaText = controller?.getStats()?.regattaMessage?.text?.trim() || '';
    return `
      <section class="session-live-hud" aria-live="polite">
        <div class="session-live-hud__alert" data-hud-capsize ${capsizeActive ? '' : 'hidden'} role="alert">
          ⚠ CAPSIZE — boat tipped. Check crew now.
        </div>
        <div class="session-live-hud__regatta" data-hud-regatta ${regattaText ? '' : 'hidden'} role="status" aria-live="polite">
          <span class="session-live-hud__regatta-label">Regatta control</span>
          <p class="session-live-hud__regatta-text" data-hud-regatta-text>${regattaText ? esc(regattaText) : ''}</p>
        </div>
        <div class="session-zone-badge" data-hud-zone data-zone="unknown" aria-live="polite">
          <span class="session-zone-badge__label">Locating…</span>
          <span class="session-zone-badge__sub"></span>
        </div>
        <div class="session-live-hud__metrics">
          <div class="session-metric session-metric--timer">
            <span class="session-metric__value" data-hud-timer>0:00</span>
            <span class="session-metric__label">Time</span>
          </div>
          <div class="session-metric session-metric--spm">
            <span class="session-metric__value" data-hud-spm>—</span>
            <span class="session-metric__label">Strokes /min</span>
          </div>
          <div class="session-metric">
            <span class="session-metric__value" data-hud-hr>—</span>
            <span class="session-metric__label">HR</span>
          </div>
          <div class="session-metric">
            <span class="session-metric__value" data-hud-split>—</span>
            <span class="session-metric__label">Pace /500m <span class="session-metric__sub">10s avg</span></span>
          </div>
        </div>
        <div class="session-live-hud__bar">
          <button type="button" class="hub-btn hub-btn--ghost session-live-hud__fs" data-action="toggle-fullscreen">Fullscreen</button>
        </div>
      </section>
    `;
  }

  function wrapRecordingStage(body: string): string {
    return `
      <div class="session-stage" data-session-stage>
        ${spectrumRailsHtml()}
        <div class="session-stage__inner">${body}</div>
      </div>
    `;
  }

  function recordIdleHtml(): string {
    const s = loadSettings();
    const armed = Boolean(standby);
    const standbyLine = armed
      ? standbyStatus?.message || 'Geofence standby armed'
      : s.geofenceSessionControl !== false
        ? 'Geofence standby off — arm to auto-start when leaving the boat park'
        : 'Geofence session control disabled in Settings';
    return `
      <section class="hub-panel actions actions--idle session-actions-panel">
        <button type="button" class="hub-btn hub-btn--primary hub-btn-lg" data-action="start">Start session</button>
        ${
          s.geofenceSessionControl !== false
            ? `<button type="button" class="hub-btn ${armed ? 'hub-btn--danger' : 'hub-btn--ghost'} hub-btn-lg" data-action="toggle-standby">${armed ? 'Disarm geofence standby' : 'Arm geofence standby'}</button>`
            : ''
        }
        <p class="poll-line session-standby-hint">${esc(standbyLine)}</p>
        <button type="button" class="hub-btn hub-btn--ghost" data-action="clear-session">Clear session</button>
        <button type="button" class="hub-btn" data-nav="settings">Settings</button>
      </section>
    `;
  }

  function recordRecordingControlsHtml(): string {
    return `
      <section class="hub-panel actions actions--recording session-actions-panel">
        <button type="button" class="hub-btn hub-btn--danger hub-btn-lg" data-action="stop">Stop session</button>
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

  function settingsHtml(): string {
    const s = loadSettings();
    const sampleSec = sampleRateSecFromSettings(s);
    return `
      <div class="ahd-recorder-shell">
        ${hubHeader()}
        <div class="hub-stats-bar">
          <span class="hub-stats-item hub-stats-item--accent">Settings</span>
        </div>
        <div class="ahd-recorder-main ahd-recorder-main--settings">
          <div class="ahd-toolbar">
            <h1>Settings</h1>
            <div class="ahd-toolbar-actions">
              <button type="button" class="hub-btn" data-nav="record">Back</button>
            </div>
          </div>
          <form class="hub-panel form" data-settings-form>
            <h2 class="hub-section-title">Device &amp; upload</h2>
            <label>Device ID<input name="deviceId" value="${esc(s.deviceId)}" required placeholder="CREW-01" /></label>
            <label>Athlete ID<input name="athleteId" value="${esc(s.athleteId)}" placeholder="optional" /></label>
            <label>Ingest API URL<input name="ingestUrl" value="${esc(s.ingestUrl)}" placeholder="https://rowing-app-recorder-pwa.vercel.app/api/ingest" /></label>
            <label>Ingest token<input class="form-input-light" name="ingestToken" type="password" value="${esc(s.ingestToken)}" autocomplete="off" /></label>
            <label>Sample interval (seconds)<input class="form-input-light" name="sampleRateSec" type="number" min="0.5" step="0.5" value="${sampleSec}" inputmode="decimal" /></label>
            <fieldset class="fieldset checks">
              <legend>Sensors</legend>
              <label class="check"><input type="checkbox" name="enableGps" ${s.enableGps ? 'checked' : ''} /> GPS</label>
              <label class="check"><input type="checkbox" name="enableMotion" ${s.enableMotion ? 'checked' : ''} /> Accelerometer</label>
              <label class="check"><input type="checkbox" name="enableHr" ${s.enableHr ? 'checked' : ''} /> Heart rate (BLE)</label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Fleet map</legend>
              <label class="check"><input type="checkbox" name="liveMapMode" ${s.liveMapMode ? 'checked' : ''} /> Faster phone uploads <span class="form-hint">(optional ~2.5 s GPS upload — uses more battery; dashboard smooth map does not need this)</span></label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Background recording</legend>
              <label class="check"><input type="checkbox" name="enableBackgroundRecording" ${s.enableBackgroundRecording !== false ? 'checked' : ''} ${IS_NATIVE ? 'disabled' : ''} /> ${IS_NATIVE ? 'Always on in native app' : 'Allow background (best effort)'}</label>
              <label class="check"><input type="checkbox" name="keepScreenOn" ${s.keepScreenOn !== false ? 'checked' : ''} /> Keep screen on while recording</label>
            </fieldset>
            <fieldset class="fieldset checks">
              <legend>Geofence session control</legend>
              <label class="check"><input type="checkbox" name="geofenceSessionControl" ${s.geofenceSessionControl !== false ? 'checked' : ''} /> Auto start/stop via boat-park geofences <span class="form-hint">(arm standby on Record screen; suppress recording inside park; auto-stop when re-entering)</span></label>
            </fieldset>
            <button type="submit" class="hub-btn hub-btn--primary">Save settings</button>
            ${IS_NATIVE ? '<button type="button" class="hub-btn" data-action="phone-setup">Phone permissions &amp; battery</button>' : ''}
            <button type="button" class="hub-btn" data-action="clear-session">Clear session</button>
          </form>
          ${logPanelHtml()}
        </div>
        ${hubFooter()}
      </div>
    `;
  }

  async function stopStandby(): Promise<void> {
    standby?.stop();
    standby = null;
    standbyStatus = null;
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
    }
    try {
      standby = await startGeofenceStandby(s, {
        onLog: (msg) => pushLog(msg),
        onStatus: (st) => {
          standbyStatus = st;
          if (!recording && view === 'record') {
            const hint = root.querySelector('.session-standby-hint');
            if (hint) hint.textContent = st.message;
            const btn = root.querySelector('[data-action="toggle-standby"]');
            if (btn && standby) {
              btn.textContent = 'Disarm geofence standby';
              btn.classList.add('hub-btn--danger');
              btn.classList.remove('hub-btn--ghost');
            }
          }
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
    await stopStandby();
    const s = loadSettings();
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
            stopHudTimer();
            sessionStartedAt = null;
            speedAvg.clear();
            strokeRateAvg.clear();
            void exitStageFullscreen();
            stopBackgroundSession();
            await controller?.stop();
            controller = null;
            recording = false;
            capsizeActive = false;
            backgroundStatus = 'foreground';
            clearRecordingActive();
            await runSync(true);
            const settingsNow = loadSettings();
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
        render();
      },
    });

    if (s.enableHr) pushLog('Use Connect HR strap when ready.');
    if (s.liveMapMode) {
      pushLog('Faster phone uploads on — GPS ~every 2.5 s (optional; uses more battery).');
      if (IS_NATIVE) void setNativeLiveMapMode(true);
    }
    const batchMs = s.enableMotion ? Math.max(s.uploadBatchMs, 8000) : s.uploadBatchMs;
    const syncInterval = s.liveMapMode
      ? 2000
      : Math.max(4000, Math.min(batchMs, 12000));
    syncTimer = setInterval(() => void runSync(false), syncInterval);
    void runSync(false);
    render();
    startHudTimer();
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
      const decision = resolveResumeCandidate(native, persisted, s.deviceId);

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
              'Restoring recording session (background service still running)…'
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
    root.querySelector('[data-nav="settings"]')?.addEventListener('click', () => {
      view = 'settings';
      render();
    });
    root.querySelector('[data-nav="record"]')?.addEventListener('click', () => {
      view = 'record';
      render();
    });

    root.querySelector('[data-settings-form]')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      saveSettings(settingsFromForm(form));
      pushLog('Settings saved.');
      view = 'record';
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
            pushLog(line);
          }
        } else {
          pushLog('Phone setup is only available in the Android app.');
        }
      } catch (e) {
        pushLog(`Phone setup error: ${e instanceof Error ? e.message : String(e)}`);
      }
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

    root.querySelector('[data-action="stop"]')?.addEventListener('click', async () => {
      if (syncTimer) clearInterval(syncTimer);
      stopHudTimer();
      sessionStartedAt = null;
      speedAvg.clear();
      strokeRateAvg.clear();
      void exitStageFullscreen();
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

    root.querySelector('[data-action="toggle-fullscreen"]')?.addEventListener('click', async () => {
      const stage = root.querySelector('[data-session-stage]') as HTMLElement | null;
      if (!stage) return;
      try {
        if (document.fullscreenElement === stage) {
          await document.exitFullscreen();
        } else {
          await stage.requestFullscreen();
        }
      } catch {
        pushLog('Fullscreen not supported on this device.');
      }
    });

    root.querySelectorAll('[data-action="clear-session"]').forEach((el) => {
      el.addEventListener('click', () => {
        void clearSession();
      });
    });

    void updatePending();
  }

  render();
  void repairOversizedPendingOutbox().then((n) => {
    if (n > 0) pushLog(`Split ${n} oversized queued batch(es) for upload.`);
  });
  if (IS_NATIVE) {
    const onForegroundResume = () => {
      if (document.visibilityState !== 'visible' || recording) return;
      void tryAutoResume('Recording still active — restoring session controls…');
    };
    document.addEventListener('visibilitychange', onForegroundResume);

    void (async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
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
