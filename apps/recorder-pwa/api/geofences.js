const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');

/**
 * GET /api/geofences — list boat park / economy zones (recorder + dashboard)
 * POST /api/geofences — create geofence (dashboard, auth required)
 * DELETE /api/geofences?id= — remove geofence
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    const org = await requireOrg(req, res);
    if (!org) return;
    try {
      const geofences = await store.listGeofences(org.id);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        persisted: store.hasDb(),
        geofences,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
      const geofence = await store.createGeofence(org.id, body);
      if (!geofence) {
        return res.status(503).json({
          ok: false,
          error: 'No database — add POSTGRES_URL on Vercel to store geofences.',
        });
      }
      return res.status(201).json({ ok: true, geofence });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const id = req.query?.id;
      const deleted = await store.deleteGeofence(org.id, id);
      if (!deleted) {
        return res.status(404).json({ ok: false, error: 'Geofence not found' });
      }
      return res.status(200).json({ ok: true, deleted: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
