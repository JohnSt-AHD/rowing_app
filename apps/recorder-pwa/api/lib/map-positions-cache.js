/**
 * Shared cache for /api/map-positions (Vercel KV / Upstash Redis).
 * When configured, all tabs polling the same org+params share one compute every ~2s.
 */

const store = require('./ingest-store');

const DEFAULT_TTL_SEC = 2;
const LOCK_TTL_SEC = 15;
const LOCK_WAIT_MS = 3000;
const LOCK_POLL_MS = 200;

/** @returns {import('@upstash/redis').Redis | null} */
function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!globalThis.__rnzMapPositionsRedis) {
    const { Redis } = require('@upstash/redis');
    globalThis.__rnzMapPositionsRedis = new Redis({ url, token });
  }
  return globalThis.__rnzMapPositionsRedis;
}

function cacheEnabled() {
  if (process.env.MAP_POSITIONS_CACHE === '0') return false;
  return Boolean(getRedis());
}

function cacheTtlSec() {
  const n = Number(process.env.MAP_POSITIONS_CACHE_TTL_SEC);
  return Number.isFinite(n) && n >= 1 && n <= 30 ? Math.round(n) : DEFAULT_TTL_SEC;
}

function cacheKey(orgId, onlineSec, staleSec, predictMode) {
  return `map-pos:v1:${orgId}:${onlineSec}:${staleSec}:${predictMode}`;
}

function lockKey(cacheKeyStr) {
  return `${cacheKeyStr}:lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} opts
 * @param {{ id: number, slug: string }} opts.org
 * @param {number} opts.onlineSec
 * @param {number} opts.staleSec
 * @param {string} opts.predictMode
 */
async function computeMapPositionsResponse({ org, onlineSec, staleSec, predictMode }) {
  const positions = await store.getMapPositions(
    org.id,
    onlineSec * 1000,
    staleSec * 1000,
    { predictMode },
  );
  return {
    ok: true,
    org: org.slug,
    predictMode,
    onlineThresholdSec: onlineSec,
    staleThresholdSec: staleSec,
    activeCount: positions.filter((p) => p.online).length,
    positionCount: positions.length,
    positions,
    persisted: store.hasDb(),
  };
}

/**
 * @param {object} cached
 * @param {{ hit: boolean, waited?: boolean }} meta
 */
function withCacheMeta(cached, meta) {
  const ageMs =
    cached.cachedAt != null && Number.isFinite(Number(cached.cachedAt))
      ? Math.max(0, Date.now() - Number(cached.cachedAt))
      : null;
  return {
    ...cached.body,
    polledAt: Date.now(),
    cache: {
      enabled: true,
      hit: meta.hit,
      waited: Boolean(meta.waited),
      ageMs,
      ttlSec: cacheTtlSec(),
    },
  };
}

/**
 * @param {object} opts
 * @param {{ id: number, slug: string }} opts.org
 * @param {number} opts.onlineSec
 * @param {number} opts.staleSec
 * @param {string} opts.predictMode
 */
async function getCachedMapPositionsResponse(opts) {
  const redis = getRedis();
  if (!redis || !cacheEnabled()) {
    const body = await computeMapPositionsResponse(opts);
    return {
      ...body,
      polledAt: Date.now(),
      cache: { enabled: false, hit: false },
    };
  }

  const key = cacheKey(opts.org.id, opts.onlineSec, opts.staleSec, opts.predictMode);
  const ttlSec = cacheTtlSec();

  try {
    const cached = await redis.get(key);
    if (cached && typeof cached === 'object' && cached.body) {
      return withCacheMeta(cached, { hit: true });
    }
  } catch (err) {
    console.error('[map-positions-cache] read failed:', err);
  }

  const lock = lockKey(key);
  let acquired = false;
  try {
    acquired = (await redis.set(lock, '1', { nx: true, ex: LOCK_TTL_SEC })) === 'OK';
  } catch (err) {
    console.error('[map-positions-cache] lock failed:', err);
  }

  if (!acquired) {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(LOCK_POLL_MS);
      try {
        const cached = await redis.get(key);
        if (cached && typeof cached === 'object' && cached.body) {
          return withCacheMeta(cached, { hit: true, waited: true });
        }
      } catch (err) {
        console.error('[map-positions-cache] wait read failed:', err);
        break;
      }
    }
  }

  const body = await computeMapPositionsResponse(opts);
  const entry = { cachedAt: Date.now(), body };
  try {
    await redis.set(key, entry, { ex: ttlSec });
  } catch (err) {
    console.error('[map-positions-cache] write failed:', err);
  } finally {
    if (acquired) {
      try {
        await redis.del(lock);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    ...body,
    polledAt: Date.now(),
    cache: { enabled: true, hit: false, ttlSec },
  };
}

/** Default dashboard poll params — warm after GPS ingest. */
const WARM_PRESETS = [
  { onlineSec: 120, staleSec: 3600, predictMode: 'rowing' },
  { onlineSec: 120, staleSec: 3600, predictMode: 'car' },
];

/**
 * Refresh cache after ingest (fire-and-forget). Skips work when cache is cold.
 * @param {{ id: number, slug: string }} org
 * @param {object[]|undefined} samples
 */
function warmMapPositionsCacheAfterIngest(org, samples) {
  if (!cacheEnabled()) return;
  if (!Array.isArray(samples) || !samples.some((s) => s?.gps?.lat != null && s?.gps?.lon != null)) {
    return;
  }
  void (async () => {
    const redis = getRedis();
    if (!redis) return;
    const debounceKey = `map-pos:warm:v1:${org.id}`;
    try {
      const acquired = (await redis.set(debounceKey, '1', { nx: true, ex: cacheTtlSec() })) === 'OK';
      if (!acquired) return;
      for (const preset of WARM_PRESETS) {
        const key = cacheKey(org.id, preset.onlineSec, preset.staleSec, preset.predictMode);
        const body = await computeMapPositionsResponse({ org, ...preset });
        await redis.set(key, { cachedAt: Date.now(), body }, { ex: cacheTtlSec() });
      }
    } catch (err) {
      console.error('[map-positions-cache] warm failed:', err);
    }
  })();
}

module.exports = {
  cacheEnabled,
  cacheTtlSec,
  getCachedMapPositionsResponse,
  warmMapPositionsCacheAfterIngest,
};
