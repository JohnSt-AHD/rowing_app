const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');
const { getCachedMapPositionsResponse } = require('./lib/map-positions-cache');

/** Latest GPS positions for dashboard map (online + stale offline). */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  const onlineSec = Math.min(
    600,
    Math.max(30, Number(req.query?.onlineSec) || 120),
  );
  const staleSec = Math.min(
    86400,
    Math.max(onlineSec, Number(req.query?.staleSec) || 3600),
  );

  const predictMode = store.parsePredictMode(req.query?.predictMode);

  const payload = await getCachedMapPositionsResponse({
    org,
    onlineSec,
    staleSec,
    predictMode,
  });

  if (payload.cache?.hit) {
    res.setHeader('X-Map-Positions-Cache', 'HIT');
  } else if (payload.cache?.enabled) {
    res.setHeader('X-Map-Positions-Cache', 'MISS');
  } else {
    res.setHeader('X-Map-Positions-Cache', 'OFF');
  }

  return res.status(200).json(payload);
};
