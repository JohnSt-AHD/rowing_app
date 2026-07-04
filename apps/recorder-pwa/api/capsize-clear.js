const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');

module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
  }

  const deviceId =
    body?.deviceId || req.query?.deviceId
      ? String(body?.deviceId || req.query?.deviceId)
      : undefined;

  const result = await store.clearCapsizeAlert(org.id, deviceId);
  return res.status(200).json({ ok: true, ...result });
};
