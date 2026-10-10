import { analyzeMotionDebug, MotionAnalyzer } from '@rowing/motion-analysis';
import { startMotionWatcher } from '@rowing/sensor-adapters';
import type { MotionWatcher } from '@rowing/sensor-adapters/types';

export type StrokeDebugSample = {
  t: number;
  ax: number;
  ay: number;
  az: number;
};

export type StrokeDebugExport = {
  version: 1;
  kind: 'crewsight-stroke-debug';
  deviceId: string;
  label: string;
  appVersion: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  motionIntervalMs: number;
  sampleCount: number;
  samples: StrokeDebugSample[];
  liveStrokeRate: { t: number; spm: number | null }[];
  replay: {
    strokeRate: number | null;
    calibrated: boolean;
    axis: string | null;
    markerMode: string | null;
    markers: { t: number; v: number }[];
    surge: { t: number; v: number }[];
  };
};

export type StrokeDebugStatus = {
  active: boolean;
  remainingSec: number;
  elapsedSec: number;
  sampleCount: number;
  strokeRate: number | null;
  calibrated: boolean;
  markerCount: number;
};

type StartOpts = {
  durationSec: number;
  deviceId: string;
  label?: string;
  appVersion?: string;
  motionIntervalMs?: number;
  onStatus?: (s: StrokeDebugStatus) => void;
  onLog?: (msg: string) => void;
};

const MAX_DURATION_SEC = 120;
const DEFAULT_INTERVAL_MS = 40;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export class StrokeDebugCapture {
  private watcher: MotionWatcher | null = null;
  private analyzer: InstanceType<typeof MotionAnalyzer> | null = null;
  private samples: StrokeDebugSample[] = [];
  private liveStrokeRate: { t: number; spm: number | null }[] = [];
  private startedAt = 0;
  private endsAt = 0;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private deviceId = '';
  private label = '';
  private appVersion = '';
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private onStatus: ((s: StrokeDebugStatus) => void) | null = null;
  private onLog: ((msg: string) => void) | null = null;
  private lastExport: StrokeDebugExport | null = null;
  private active = false;

  isActive(): boolean {
    return this.active;
  }

  getLastExport(): StrokeDebugExport | null {
    return this.lastExport;
  }

  getStatus(): StrokeDebugStatus {
    const now = Date.now();
    const remainingSec = this.active
      ? Math.max(0, Math.ceil((this.endsAt - now) / 1000))
      : 0;
    const elapsedSec = this.active
      ? Math.max(0, Math.floor((now - this.startedAt) / 1000))
      : 0;
    const m = this.analyzer?.getMetrics();
    const dbg = this.analyzer?.getStrokeDebug();
    return {
      active: this.active,
      remainingSec,
      elapsedSec,
      sampleCount: this.samples.length,
      strokeRate: m?.strokeRate ?? null,
      calibrated: m?.calibrated ?? false,
      markerCount: dbg?.markers.length ?? 0,
    };
  }

  private emitStatus(): void {
    this.onStatus?.(this.getStatus());
  }

  async start(opts: StartOpts): Promise<boolean> {
    if (this.active) {
      opts.onLog?.('Stroke debug already running.');
      return false;
    }

    const durationSec = Math.min(
      MAX_DURATION_SEC,
      Math.max(10, Math.round(opts.durationSec)),
    );
    this.intervalMs = Math.max(20, opts.motionIntervalMs ?? DEFAULT_INTERVAL_MS);
    this.deviceId = opts.deviceId.trim() || 'unknown';
    this.label = (opts.label ?? '').trim();
    this.appVersion = opts.appVersion ?? '';
    this.onStatus = opts.onStatus ?? null;
    this.onLog = opts.onLog ?? null;
    this.samples = [];
    this.liveStrokeRate = [];
    this.lastExport = null;
    this.analyzer = new MotionAnalyzer({ bufferMs: (durationSec + 5) * 1000 });
    this.startedAt = Date.now();
    this.endsAt = this.startedAt + durationSec * 1000;
    this.active = true;

    this.onLog?.(
      `Capturing ${durationSec}s at ~${Math.round(1000 / this.intervalMs)} Hz. Hold still ~2s, then row a steady rate.`,
    );

    try {
      this.watcher = await startMotionWatcher(
        (r) => {
          if (!this.active || !this.analyzer) return;
          const sample: StrokeDebugSample = {
            t: r.t,
            ax: round3(r.ax),
            ay: round3(r.ay),
            az: round3(r.az),
          };
          this.samples.push(sample);
          this.analyzer.process(sample.t, sample.ax, sample.ay, sample.az);
          const m = this.analyzer.getMetrics();
          this.liveStrokeRate.push({ t: sample.t, spm: m.strokeRate });
        },
        this.intervalMs,
        (msg) => this.onLog?.(`Motion: ${msg}`),
        { enableBackground: true },
      );
    } catch (e) {
      this.active = false;
      this.onLog?.(
        `Failed to start: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }

    this.emitStatus();
    this.tickTimer = setInterval(() => this.emitStatus(), 250);
    this.stopTimer = setTimeout(() => {
      void this.stop({ auto: true });
    }, durationSec * 1000);

    return true;
  }

  async stop(opts?: { auto?: boolean }): Promise<StrokeDebugExport | null> {
    if (!this.active && !this.samples.length) return this.lastExport;

    this.active = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) {
      try {
        await Promise.resolve(watcher.stop());
      } catch {
        /* ignore */
      }
    }

    const endedAt = Date.now();
    const replay = analyzeMotionDebug(this.samples, {
      bufferMs: Math.max(120_000, endedAt - this.startedAt + 1000),
    });

    const exp: StrokeDebugExport = {
      version: 1,
      kind: 'crewsight-stroke-debug',
      deviceId: this.deviceId,
      label: this.label,
      appVersion: this.appVersion,
      startedAt: this.startedAt,
      endedAt,
      durationSec: Math.round((endedAt - this.startedAt) / 1000),
      motionIntervalMs: this.intervalMs,
      sampleCount: this.samples.length,
      samples: this.samples,
      liveStrokeRate: this.liveStrokeRate,
      replay: {
        strokeRate: replay.strokeRate,
        calibrated: replay.calibrated,
        axis: replay.axis,
        markerMode: replay.markerMode,
        markers: replay.markers,
        surge: replay.surge,
      },
    };
    this.lastExport = exp;
    this.analyzer = null;
    this.emitStatus();

    const spm =
      exp.replay.strokeRate != null
        ? `${Math.round(exp.replay.strokeRate)} spm`
        : 'no rate';
    this.onLog?.(
      `${opts?.auto ? 'Finished' : 'Stopped'}: ${exp.sampleCount} samples · ${spm} · ${exp.replay.markers.length} markers (${exp.replay.markerMode ?? '?'} / ${exp.replay.axis ?? '?'}). Export the JSON.`,
    );
    return exp;
  }
}

export async function exportStrokeDebugJson(
  data: StrokeDebugExport,
): Promise<'shared' | 'downloaded' | 'copied'> {
  const name = `crewsight-stroke-debug-${data.deviceId.replace(/[^\w.-]+/g, '_')}-${data.startedAt}.json`;
  const text = JSON.stringify(data);
  const blob = new Blob([text], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });

  const nav = navigator as Navigator & {
    share?: (data: ShareData & { files?: File[] }) => Promise<void>;
    canShare?: (data: ShareData & { files?: File[] }) => boolean;
  };

  if (typeof nav.share === 'function') {
    try {
      const shareData: ShareData & { files?: File[] } = {
        title: 'CrewSight stroke debug',
        text: `${data.deviceId} · ${data.durationSec}s · ${data.replay.strokeRate ?? '—'} spm`,
        files: [file],
      };
      if (!nav.canShare || nav.canShare(shareData)) {
        await nav.share(shareData);
        return 'shared';
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return 'shared';
      }
    }
  }

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'downloaded';
  } catch {
    /* fall through */
  }

  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    throw new Error('Could not share, download, or copy the debug JSON');
  }
}
