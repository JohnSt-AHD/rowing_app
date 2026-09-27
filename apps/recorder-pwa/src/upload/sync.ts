import type { RecorderSettings, TelemetryBatch } from '@rowing/telemetry-types';
import {
  listPendingOutbox,
  markOutboxSent,
  repairOversizedPendingOutbox,
} from '../session/store';
import { MAX_SAMPLES_PER_UPLOAD, postTelemetryBatch } from './telemetry-api';

const FLUSH_TOTAL_TIMEOUT_MS = 60_000;
/** Must cover native HTTP timeout + up to 3 retries in telemetry-api. */
const PER_BATCH_TIMEOUT_MS = 90_000;

export type FlushResult = {
  sent: number;
  failed: number;
  errors: string[];
};

export type FlushOptions = {
  /** Log progress without re-rendering the whole page. */
  onProgress?: (msg: string) => void;
  /** Start a new upload even if one is in progress (manual button). */
  force?: boolean;
  /** Max queue batches per run (keeps UI responsive). */
  maxBatches?: number;
};

let flushInFlight: Promise<FlushResult> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
        ms,
      );
    }),
  ]);
}

async function flushOutboxInner(
  settings: RecorderSettings,
  opts: FlushOptions,
): Promise<FlushResult> {
  const progress = opts.onProgress;
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  const maxBatches = opts.maxBatches ?? 40;

  progress?.('Checking queue…');
  const repaired = await repairOversizedPendingOutbox(MAX_SAMPLES_PER_UPLOAD, 12);
  if (repaired > 0) {
    progress?.(`Split ${repaired} oversized batch(es).`);
  }

  const rows = await listPendingOutbox(maxBatches);
  if (!rows.length) {
    return { sent, failed, errors };
  }

  progress?.(`Uploading ${rows.length} batch(es)…`);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row.id) continue;

    try {
      if (row.kind === 'traccar') {
        await markOutboxSent(row.id);
        sent++;
        continue;
      }

      const parsed = JSON.parse(row.payload) as {
        sessionId: string;
        samples: TelemetryBatch['samples'];
      };
      const sampleCount = parsed.samples?.length ?? 0;
      if (sampleCount === 0) {
        await markOutboxSent(row.id);
        sent++;
        continue;
      }

      progress?.(`Batch ${i + 1}/${rows.length} (${sampleCount} samples)…`);

      await withTimeout(
        postTelemetryBatch(settings.ingestUrl, settings.ingestToken, {
          sessionId: parsed.sessionId,
          deviceId: settings.deviceId,
          athleteId: settings.athleteId || undefined,
          boatId: settings.boatId || undefined,
          boatClass: settings.boatClass || undefined,
          samples: parsed.samples,
        }),
        PER_BATCH_TIMEOUT_MS,
        `Batch ${i + 1}`,
      );

      await markOutboxSent(row.id);
      sent++;
      progress?.(`Batch ${i + 1} sent.`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      const parsed = safeParsePayload(row.payload);
      const n = parsed?.samples?.length ?? '?';
      errors.push(`batch ${i + 1} (${n} samples): ${msg}`);
      progress?.(`Batch ${i + 1} failed.`);
      if (/401|403|localhost/i.test(msg)) break;
    }
  }

  return { sent, failed, errors };
}

function safeParsePayload(payload: string): { samples?: TelemetryBatch['samples'] } | null {
  try {
    return JSON.parse(payload) as { samples?: TelemetryBatch['samples'] };
  } catch {
    return null;
  }
}

export async function flushOutbox(
  settings: RecorderSettings,
  opts: FlushOptions = {},
): Promise<FlushResult> {
  if (flushInFlight && !opts.force) {
    return withTimeout(flushInFlight, 8000, 'Waiting for previous upload').catch(
      () => ({
        sent: 0,
        failed: 0,
        errors: ['Previous upload still running — wait or tap Upload again'],
      }),
    );
  }

  // Manual upload: per-batch timeouts only (so logs show each batch). Background: cap total time.
  const work = opts.onProgress
    ? flushOutboxInner(settings, opts)
    : withTimeout(flushOutboxInner(settings, opts), FLUSH_TOTAL_TIMEOUT_MS, 'Upload');

  flushInFlight = work.finally(() => {
    flushInFlight = null;
  });

  return flushInFlight;
}
