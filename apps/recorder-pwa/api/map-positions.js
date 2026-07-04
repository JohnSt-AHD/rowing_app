const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');

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

  const positions = await store.getMapPositions(
    org.id,
    onlineSec * 1000,
    staleSec * 1000,
    { predictMode },
  );

  return res.status(200).json({
    ok: true,
    org: org.slug,
    polledAt: Date.now(),
    predictMode,
    onlineThresholdSec: onlineSec,
    staleThresholdSec: staleSec,
    activeCount: positions.filter((p) => p.online).length,
    positionCount: positions.length,
    positions,
    persisted: store.hasDb(),
  });
};
