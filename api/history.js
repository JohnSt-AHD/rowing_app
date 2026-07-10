const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');

const DELETE_ALL_CONFIRM = 'DELETE ALL RNZ DATA';

/**
 * GET /api/history — route replay, lists, dashboard format, storage stats
 * POST /api/history — delete stored telemetry (manage=1 in body)
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  if (req.method === 'GET') {
    if (req.query?.storage === 'stats') {
      const stats = await store.getStorageStats(org.id);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        persisted: store.hasDb(),
        stats,
        security: store.getDataSecurityInfo(),
      });
    }

    if (req.query?.list === 'devices') {
      const devices = await store.listHistoryDevices(org.id);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        persisted: store.hasDb(),
        devices,
      });
    }

    if (req.query?.list === 'sessions') {
      const uniqueId = req.query?.uniqueId || null;
      const sessions = await store.listSessionsHistory(org.id, uniqueId);
      return res.status(200).json({
        ok: true,
        persisted: store.hasDb(),
        sessions,
      });
    }

    if (req.query?.format === 'dashboard') {
      if (!store.hasDb()) {
        return res.status(503).json({
          ok: false,
          error: 'No database — add POSTGRES_URL on Vercel to search history.',
        });
      }

      const sessionId = req.query?.sessionId;
      let payload = null;
      if (sessionId) {
        payload = await store.getDashboardHistoryBySession(org.id, String(sessionId));
      } else {
        const from = req.query?.from;
        const to = req.query?.to;
        const uniqueId = req.query?.uniqueId;
        if (!from || !to || !uniqueId) {
          return res.status(400).json({
            ok: false,
            error: 'uniqueId, from, and to required (or sessionId)',
          });
        }
        payload = await store.getDashboardHistory(
          org.id,
          String(uniqueId),
          String(from),
          String(to),
        );
      }

      if (!payload) {
        return res.status(404).json({ ok: false, error: 'No data for this query' });
      }
      return res.status(200).json({ ok: true, persisted: true, ...payload });
    }

    const from = req.query?.from;
    const to = req.query?.to;
    if (!from || !to) {
      return res.status(400).json({
        ok: false,
        error:
          'from and to required (ISO 8601), or list=sessions / format=dashboard / storage=stats',
      });
    }

    const deviceId = req.query?.deviceId;
    const uniqueId = req.query?.uniqueId;
    if (!deviceId && !uniqueId) {
      return res.status(400).json({
        ok: false,
        error: 'deviceId (numeric) or uniqueId required',
      });
    }

    const positions = await store.getRouteHistory(
      org.id,
      deviceId,
      uniqueId,
      from,
      to,
    );
    return res.status(200).json(positions);
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

  if (body?.manage !== true && body?.manage !== '1') {
    return res.status(400).json({
      ok: false,
      error: 'POST requires manage: true for data deletion',
    });
  }

  if (!store.hasDb()) {
    return res.status(503).json({
      ok: false,
      error: 'No database — add POSTGRES_URL on Vercel to store or delete history.',
    });
  }

  const action = body?.action;
  if (!action) {
    return res.status(400).json({ ok: false, error: 'action required' });
  }

  try {
    if (action === 'deleteSession') {
      const sessionId = body?.sessionId;
      if (!sessionId) {
        return res.status(400).json({ ok: false, error: 'sessionId required' });
      }
      const result = await store.deleteStoredSession(org.id, String(sessionId));
      return res.status(200).json({ ok: true, action, result });
    }

    if (action === 'deleteDevice') {
      const uniqueId = body?.uniqueId;
      if (!uniqueId) {
        return res.status(400).json({ ok: false, error: 'uniqueId required' });
      }
      const result = await store.deleteStoredDevice(org.id, String(uniqueId));
      return res.status(200).json({ ok: true, action, result });
    }

    if (action === 'deleteRange') {
      const uniqueId = body?.uniqueId;
      const from = body?.from;
      const to = body?.to;
      if (!uniqueId || !from || !to) {
        return res.status(400).json({
          ok: false,
          error: 'uniqueId, from, and to required (ISO 8601)',
        });
      }
      const result = await store.deleteStoredRange(
        org.id,
        String(uniqueId),
        String(from),
        String(to),
      );
      return res.status(200).json({ ok: true, action, result });
    }

    if (action === 'deleteAll') {
      if (body?.confirm !== DELETE_ALL_CONFIRM) {
        return res.status(400).json({
          ok: false,
          error: `confirm must be exactly: ${DELETE_ALL_CONFIRM}`,
        });
      }
      const result = await store.deleteAllStoredData(org.id);
      return res.status(200).json({ ok: true, action, result });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('[history] manage failed:', err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
