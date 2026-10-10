import {
  exportStrokeDebugJson,
  StrokeDebugCapture,
} from './stroke-debug-capture';

const APP_VERSION = import.meta.env.VITE_APP_VERSION || '0.1.0';
const APP_VERSION_CODE = import.meta.env.VITE_APP_VERSION_CODE || '';
const versionLabel = APP_VERSION_CODE
  ? `v${APP_VERSION} (${APP_VERSION_CODE})`
  : `v${APP_VERSION}`;

const capture = new StrokeDebugCapture();
const logLines: string[] = [];

const root = document.querySelector('#app');
if (!root) throw new Error('#app missing');

root.innerHTML = `
  <h1>CrewSight Stroke Debug</h1>
  <p class="sub">
    Separate debug app — records full-rate accelerometer and detected strokes.
    Installs alongside the normal CrewSight client.
  </p>
  <div class="panel">
    <label for="deviceId">Label (optional)</label>
    <input id="deviceId" value="John" placeholder="e.g. John / erg / boat" />
    <label for="note">Note (optional)</label>
    <input id="note" placeholder="e.g. 24 spm piece" />
    <div class="status" data-status>Idle — record 30–60s at a steady rate, then export JSON.</div>
    <div class="actions">
      <button type="button" class="primary" data-action="30">Record 30s</button>
      <button type="button" class="primary" data-action="60">Record 60s</button>
      <button type="button" class="danger" data-action="stop">Stop &amp; export</button>
      <button type="button" data-action="export">Export last</button>
    </div>
  </div>
  <div class="panel">
    <pre class="log" data-log>Ready.</pre>
  </div>
  <p class="version">CrewSight Stroke Debug ${versionLabel}</p>
`;

const statusEl = root.querySelector('[data-status]') as HTMLElement;
const logEl = root.querySelector('[data-log]') as HTMLElement;
const deviceInput = root.querySelector('#deviceId') as HTMLInputElement;
const noteInput = root.querySelector('#note') as HTMLInputElement;

function pushLog(msg: string): void {
  const t = new Date().toLocaleTimeString();
  logLines.unshift(`[${t}] ${msg}`);
  if (logLines.length > 60) logLines.length = 60;
  logEl.textContent = logLines.join('\n');
}

function refreshStatus(): void {
  const st = capture.getStatus();
  const last = capture.getLastExport();
  if (st.active) {
    const spm =
      st.strokeRate != null && st.strokeRate > 0
        ? `${Math.round(st.strokeRate)} spm`
        : 'calibrating…';
    statusEl.textContent = `Recording ${st.elapsedSec}s · ${st.remainingSec}s left · ${st.sampleCount} samples · ${spm}${st.calibrated ? '' : ' · hold still to calibrate'}`;
    return;
  }
  if (last) {
    const spm =
      last.replay.strokeRate != null
        ? `${Math.round(last.replay.strokeRate)} spm`
        : 'no rate';
    statusEl.textContent = `Last capture: ${last.sampleCount} samples · ${spm} · ${last.replay.markers.length} markers — export ready`;
    return;
  }
  statusEl.textContent =
    'Idle — record 30–60s at a steady rate, then export JSON.';
}

async function start(durationSec: number): Promise<void> {
  if (capture.isActive()) {
    pushLog('Already recording.');
    return;
  }
  const ok = await capture.start({
    durationSec,
    deviceId: deviceInput.value.trim() || 'debug',
    label: noteInput.value.trim(),
    appVersion: versionLabel,
    motionIntervalMs: 40,
    onLog: pushLog,
    onStatus: () => refreshStatus(),
  });
  if (ok) refreshStatus();
}

async function stopAndExport(): Promise<void> {
  const exp = capture.isActive()
    ? await capture.stop()
    : capture.getLastExport();
  refreshStatus();
  if (!exp) {
    pushLog('No capture to export yet.');
    return;
  }
  try {
    const how = await exportStrokeDebugJson(exp);
    pushLog(
      how === 'shared'
        ? 'Shared — save the JSON (Files / Drive / email).'
        : how === 'downloaded'
          ? 'Downloaded — check Files / Downloads.'
          : 'JSON copied to clipboard.',
    );
  } catch (e) {
    pushLog(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

root.querySelector('[data-action="30"]')?.addEventListener('click', () => {
  void start(30);
});
root.querySelector('[data-action="60"]')?.addEventListener('click', () => {
  void start(60);
});
root.querySelector('[data-action="stop"]')?.addEventListener('click', () => {
  void stopAndExport();
});
root.querySelector('[data-action="export"]')?.addEventListener('click', () => {
  void stopAndExport();
});

refreshStatus();
pushLog('Stroke debug ready. This app is separate from CrewSight.');
