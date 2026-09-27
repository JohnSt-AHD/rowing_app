const store = require('./lib/ingest-store');
const db = require('./lib/db');
const { requireOrg } = require('./lib/require-org');

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  if (req.method === 'GET') {
    const boats = await db.listRegistryDevices(org.id);
    const open = await db.listOpenWalkupSessions(org.id);
    return res.status(200).json({
      ok: true,
      org: { id: org.id, slug: org.slug, name: org.name },
      boats: boats.map((b) => ({
        deviceId: b.uniqueId || b.attributes?.uniqueId || String(b.id),
        name: b.name || b.uniqueId || String(b.id),
      })),
      openSessions: open,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = readBody(req);
  const action = String(body.action || '').trim().toLowerCase();

  try {
    if (action === 'start') {
      const started = await db.startWalkupSession(org.id, {
        deviceId: body.deviceId || body.boatId,
        rowerName: body.name || body.rowerName,
      });
      return res.status(200).json({ ok: true, ...started });
    }

    if (action === 'end' || action === 'stop') {
      const ended = await db.endWalkupSession(org.id, body.sessionId);
      if (!ended) {
        return res.status(404).json({ ok: false, error: 'Session not found' });
      }
      return res.status(200).json({ ok: true, ...ended });
    }

    if (action === 'heartbeat') {
      const ok = await db.heartbeatWalkupSession(org.id, body.sessionId);
      return res.status(200).json({ ok, sessionId: body.sessionId || null });
    }

    return res.status(400).json({
      ok: false,
      error: 'Unknown action (use start, end, or heartbeat)',
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err && err.message ? err.message : 'Walk-up request failed',
    });
  }
};
