const store = require('./lib/ingest-store');
const db = require('./lib/db');
const { requireOrg } = require('./lib/require-org');

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return {};
}

function boatLabel(deviceId, name) {
  const id = String(deviceId || '').trim();
  const n = String(name || '').trim();
  if (n && n !== id) return n;
  return id;
}

async function loadBoats(orgId) {
  /** @type {Map<string, string>} */
  const byId = new Map();

  try {
    const registry = await db.listRegistryDevices(orgId);
    for (const b of registry || []) {
      const id = String(b.uniqueId || b.attributes?.uniqueId || '').trim();
      if (!id) continue;
      byId.set(id, boatLabel(id, b.name));
    }
  } catch (err) {
    console.error('[walkup] listRegistryDevices failed:', err);
  }

  // History list is the same source Manager uses and is known-good in prod.
  try {
    const history = await store.listHistoryDevices(orgId);
    for (const d of history || []) {
      const id = String(d.uniqueId || d.deviceId || '').trim();
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, boatLabel(id, d.name));
    }
  } catch (err) {
    console.error('[walkup] listHistoryDevices failed:', err);
  }

  return [...byId.entries()]
    .map(([deviceId, name]) => ({ deviceId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  if (req.method === 'GET') {
    try {
      const boats = await loadBoats(org.id);
      let openSessions = [];
      try {
        openSessions = await db.listOpenWalkupSessions(org.id);
      } catch (err) {
        console.error('[walkup] listOpenWalkupSessions failed:', err);
      }
      return res.status(200).json({
        ok: true,
        org: { id: org.id, slug: org.slug, name: org.name },
        boats,
        openSessions,
      });
    } catch (err) {
      console.error('[walkup] GET failed:', err);
      return res.status(500).json({
        ok: false,
        error: err && err.message ? err.message : 'Could not load boats',
      });
    }
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
    console.error('[walkup] POST failed:', err);
    return res.status(400).json({
      ok: false,
      error: err && err.message ? err.message : 'Walk-up request failed',
    });
  }
};
