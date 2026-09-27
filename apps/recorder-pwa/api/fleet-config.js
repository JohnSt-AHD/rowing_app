const store = require('./lib/ingest-store');
const db = require('./lib/db');
const { requireOrg } = require('./lib/require-org');
const { memoryDefaults } = require('./lib/fleet-config-defaults');

function readBody(req) {
  if (req.body && typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body && typeof req.body === 'object' ? req.body : {};
}

/**
 * GET /api/fleet-config — coaches + boats for recorder settings and manager
 * POST /api/fleet-config — create coach or boat { type, ...fields }
 * PATCH /api/fleet-config?id=&type= — update boat
 * DELETE /api/fleet-config?id=&type= — remove coach or boat
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    const org = await requireOrg(req, res);
    if (!org) return;
    try {
      const config = db.hasDb()
        ? await db.getFleetConfig(org.id)
        : memoryDefaults();
      return res.status(200).json({
        ok: true,
        org: org.slug,
        persisted: db.hasDb(),
        ...config,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  if (!db.hasDb()) {
    return res.status(503).json({
      ok: false,
      error: 'No database — add POSTGRES_URL on Vercel to manage coaches and boats.',
    });
  }

  const body = readBody(req);
  const type = String(body.type || req.query?.type || '').trim().toLowerCase();

  if (req.method === 'POST') {
    try {
      if (type === 'coach') {
        const coach = await db.createCoach(org.id, body);
        return res.status(201).json({ ok: true, coach });
      }
      if (type === 'boat') {
        const boat = await db.createBoat(org.id, body);
        return res.status(201).json({ ok: true, boat });
      }
      return res.status(400).json({ ok: false, error: 'type must be coach or boat' });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const id = req.query?.id;
      if (type !== 'boat') {
        return res.status(400).json({ ok: false, error: 'PATCH supports type=boat only' });
      }
      const boat = await db.updateBoat(org.id, id, body);
      if (!boat) return res.status(404).json({ ok: false, error: 'Boat not found' });
      return res.status(200).json({ ok: true, boat });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const id = req.query?.id;
      if (!id) return res.status(400).json({ ok: false, error: 'id query parameter is required' });
      let deleted = false;
      if (type === 'coach') deleted = await db.deleteCoach(org.id, id);
      else if (type === 'boat') deleted = await db.deleteBoat(org.id, id);
      else return res.status(400).json({ ok: false, error: 'type must be coach or boat' });
      if (!deleted) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.status(200).json({ ok: true, deleted: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
