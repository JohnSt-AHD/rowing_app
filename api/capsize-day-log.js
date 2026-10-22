const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');
const log = require('./lib/capsize-day-log');

/**
 * Shared NZ-day capsize log (Manager + RowSafe).
 * GET  /api/capsize-day-log
 * POST /api/capsize-day-log  { action: 'ack'|'upsert', ... }
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
      const data = await log.listDayLog(org.id);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        day: data.day,
        persisted: data.persisted,
        storage: data.storage,
        events: data.events,
      });
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
  const action = String(req.query?.action || body.action || '')
    .trim()
    .toLowerCase();

  try {
    if (action === 'ack' || action === 'acknowledge') {
      const ids = Array.isArray(body.deviceIds)
        ? body.deviceIds.map((id) => String(id))
        : body.deviceId
          ? [String(body.deviceId)]
          : null;
      await log.acknowledge(org.id, ids, body.ackedBy, body.ackSource || 'manager');
      const data = await log.listDayLog(org.id);
      return res.status(200).json({ ok: true, day: data.day, events: data.events });
    }
    if (action === 'upsert') {
      const entry = await log.upsertActive(org.id, {
        deviceId: body.deviceId,
        name: body.name,
        lat: body.lat,
        lon: body.lon,
        startedAt: body.startedAt,
      });
      return res.status(200).json({ ok: true, event: entry });
    }
    return res.status(400).json({
      ok: false,
      error: 'Unknown action. Use ack or upsert.',
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
};
