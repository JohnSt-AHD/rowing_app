import type { IngestResponse, TelemetryBatch } from '@rowing/telemetry-types';

const IS_NATIVE = import.meta.env.VITE_PLATFORM === 'native';

/** Stay under server limit (500) and keep POST bodies small on mobile networks. */
export const MAX_SAMPLES_PER_UPLOAD = IS_NATIVE ? 50 : 120;

const UPLOAD_TIMEOUT_MS = IS_NATIVE ? 25_000 : 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeIngestUrl(url: string): string {
  const u = url.trim();
  if (!u) return u;
  try {
    const parsed = new URL(u);
    if (parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    }
    return parsed.toString();
  } catch {
    return u;
  }
}

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /failed to fetch|network|timeout|aborted|ECONNRESET|ETIMEDOUT/i.test(msg) ||
    /ingest failed (502|503|504|429)/i.test(msg)
  );
}

function checksumString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildIdempotencyKey(batch: TelemetryBatch): string {
  const n = batch.samples.length;
  const first = n > 0 ? Number(batch.samples[0]?.t ?? 0) : 0;
  const last = n > 0 ? Number(batch.samples[n - 1]?.t ?? 0) : 0;
  const shape = batch.samples
    .map((s) => `${s.gps ? 'g' : ''}${s.motion ? 'm' : ''}${s.hr ? 'h' : ''}${s.derived ? 'd' : ''}`)
    .join('');
  return `rnz-${checksumString(`${batch.sessionId}|${batch.deviceId}|${first}|${last}|${n}|${shape}`)}`;
}

function buildSessionEndIdempotencyKey(req: SessionEndRequest): string {
  return `rnz-end-${checksumString(`${req.sessionId}|${req.endedAt ?? 0}`)}`;
}

function idempotencyKeyForBody(body: unknown): string {
  if (
    body &&
    typeof body === 'object' &&
    (body as { action?: string }).action === 'end' &&
    typeof (body as SessionEndRequest).sessionId === 'string'
  ) {
    return buildSessionEndIdempotencyKey(body as SessionEndRequest);
  }
  return buildIdempotencyKey(body as TelemetryBatch);
}

async function postOnceNative(
  ingestUrl: string,
  token: string,
  body: unknown,
): Promise<IngestResponse> {
  const idempotencyKey = idempotencyKeyForBody(body);
  const { CapacitorHttp } = await import('@capacitor/core');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Idempotency-Key': idempotencyKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await CapacitorHttp.post({
    url: normalizeIngestUrl(ingestUrl),
    headers,
    data: body,
    connectTimeout: UPLOAD_TIMEOUT_MS,
    readTimeout: UPLOAD_TIMEOUT_MS,
  });

  if (response.status < 200 || response.status >= 300) {
    const detail =
      typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data ?? {});
    throw new Error(`Ingest failed ${response.status}: ${detail.slice(0, 200)}`);
  }

  if (response.data && typeof response.data === 'object') {
    return response.data as IngestResponse;
  }
  if (typeof response.data === 'string' && response.data.length) {
    return JSON.parse(response.data) as IngestResponse;
  }
  const batch = body as TelemetryBatch;
  return {
    ok: true,
    received: Array.isArray(batch.samples) ? batch.samples.length : 0,
    sessionId: batch.sessionId,
  };
}

async function postOnceFetch(
  ingestUrl: string,
  token: string,
  body: unknown,
): Promise<IngestResponse> {
  const idempotencyKey = idempotencyKeyForBody(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Idempotency-Key': idempotencyKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const payload = JSON.stringify(body);
  const useKeepalive = !IS_NATIVE && payload.length < 60_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(normalizeIngestUrl(ingestUrl), {
      method: 'POST',
      headers,
      body: payload,
      keepalive: useKeepalive,
      signal: controller.signal,
    });
  } catch (e) {
    const hint =
      ingestUrl.includes('localhost') || ingestUrl.includes('127.0.0.1')
        ? ' Ingest URL points at localhost — open Settings and set the Vercel ingest URL.'
        : IS_NATIVE
          ? ' Native HTTP also failed — check mobile data/Wi‑Fi.'
          : '';
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new Error(
      aborted
        ? `Upload timed out after ${UPLOAD_TIMEOUT_MS / 1000}s.${hint}`
        : `Failed to fetch (${msg}).${hint}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ingest failed ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json() as Promise<IngestResponse>;
}

async function postOnce(
  ingestUrl: string,
  token: string,
  body: unknown,
): Promise<IngestResponse> {
  if (IS_NATIVE) {
    try {
      return await postOnceNative(ingestUrl, token, body);
    } catch (nativeErr) {
      try {
        return await postOnceFetch(ingestUrl, token, body);
      } catch {
        throw nativeErr;
      }
    }
  }
  return postOnceFetch(ingestUrl, token, body);
}

/** POST a batch, splitting samples into safe-sized chunks. */
export async function postTelemetryBatch(
  ingestUrl: string,
  token: string,
  batch: TelemetryBatch,
): Promise<IngestResponse> {
  const url = normalizeIngestUrl(ingestUrl);
  const samples = batch.samples;
  if (samples.length <= MAX_SAMPLES_PER_UPLOAD) {
    return postOnceWithRetry(url, token, batch);
  }

  let last: IngestResponse = { ok: true, sessionId: batch.sessionId, received: 0 };
  for (let i = 0; i < samples.length; i += MAX_SAMPLES_PER_UPLOAD) {
    const chunk = samples.slice(i, i + MAX_SAMPLES_PER_UPLOAD);
    last = await postOnceWithRetry(url, token, { ...batch, samples: chunk });
  }
  return last;
}

async function postOnceWithRetry(
  ingestUrl: string,
  token: string,
  body: unknown,
): Promise<IngestResponse> {
  const delays = [0, 1200, 3500];
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i];
    if (delay > 0) {
      const jitter = Math.floor(Math.random() * 400);
      await sleep(delay + jitter);
    }
    try {
      return await postOnce(ingestUrl, token, body);
    } catch (e) {
      lastErr = e;
      if (!isRetryableError(e) || i === delays.length - 1) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export type SessionEndRequest = {
  sessionId: string;
  deviceId: string;
  athleteId?: string;
  endedAt?: number;
};

/** Tell the ingest API a session has ended (sets server ended_at). */
export async function postSessionEnd(
  ingestUrl: string,
  token: string,
  req: SessionEndRequest,
): Promise<IngestResponse> {
  const body = {
    action: 'end',
    sessionId: req.sessionId,
    deviceId: req.deviceId,
    athleteId: req.athleteId,
    endedAt: req.endedAt ?? Date.now(),
  };
  return postOnceWithRetry(normalizeIngestUrl(ingestUrl), token, body);
}

/** Minimal POST for Settings connectivity test. */
export async function testIngestConnection(
  ingestUrl: string,
  token: string,
  deviceId: string,
): Promise<string> {
  const id = deviceId.trim() || 'connectivity-test';
  const batch: TelemetryBatch = {
    sessionId: crypto.randomUUID(),
    deviceId: id,
    samples: [{ t: Date.now(), gps: { lat: -37.93, lon: 175.55 } }],
  };
  const res = await postTelemetryBatch(ingestUrl, token, batch);
  return `OK — server received ${res.received ?? 1} sample(s)`;
}
