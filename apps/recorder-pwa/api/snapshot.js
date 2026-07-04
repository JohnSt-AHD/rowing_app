const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');

/** Traccar-compatible snapshot for traccar-overlay live maps. */
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

  const data = await store.getTraccarSnapshot(org.id, onlineSec * 1000);
  return res.status(200).json({
    ...data,
    ok: true,
    org: org.slug,
    source: 'rnz-ingest',
    persisted: store.hasDb(),
  });
};
