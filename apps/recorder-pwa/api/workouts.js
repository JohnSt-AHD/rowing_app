const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');
const lib = require('./lib/workouts-store');

/**
 * Shared workout library for the org token.
 * GET  /api/workouts
 * POST /api/workouts  { workouts: [...] }
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    return res.status(204).end();
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  if (req.method === 'GET') {
    try {
      const data = await lib.listWorkouts(org.id);
      return res.status(200).json({ ok: true, org: org.slug, ...data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
  }
  body = body || {};
  try {
    const data = await lib.saveWorkouts(org.id, body.workouts);
    return res.status(200).json({ ok: true, org: org.slug, ...data });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
};
