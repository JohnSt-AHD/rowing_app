const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');
const { validateMessageBody } = require('./lib/regatta-message');

/**
 * GET /api/messages?deviceId= — active message for recorder (org token required)
 * GET /api/messages — all active messages (dashboard, auth required)
 * POST /api/messages — send message to device (auth required)
 * DELETE /api/messages?deviceId= — clear active message (auth required)
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    return res.status(204).end();
  }

  if (req.method === 'GET') {
    try {
      const org = await requireOrg(req, res);
      if (!org) return;

      const deviceId = req.query?.deviceId;
      if (deviceId) {
        const message = await store.getActiveRegattaMessage(org.id, String(deviceId).trim());
        return res.status(200).json({
          ok: true,
          org: org.slug,
          persisted: store.hasDb(),
          message,
        });
      }

      const messages = await store.listActiveRegattaMessages(org.id);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        persisted: store.hasDb(),
        messages,
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
      const validated = validateMessageBody(body);
      if (validated.allDevices) {
        const messages = await store.broadcastRegattaMessage(
          org.id,
          validated.text,
          validated.deviceIds,
        );
        if (!messages.length) {
          return res.status(503).json({
            ok: false,
            error: 'No database — add POSTGRES_URL on Vercel to store messages.',
          });
        }
        return res.status(201).json({
          ok: true,
          broadcast: true,
          count: messages.length,
          messages,
        });
      }
      const message = await store.setRegattaMessage(org.id, validated.deviceId, validated.text);
      if (!message) {
        return res.status(503).json({
          ok: false,
          error: 'No database — add POSTGRES_URL on Vercel to store messages.',
        });
      }
      return res.status(201).json({ ok: true, message });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const deviceId = String(req.query?.deviceId ?? '').trim();
      if (!deviceId) {
        return res.status(400).json({ ok: false, error: 'deviceId required' });
      }
      const cleared = await store.clearRegattaMessage(org.id, deviceId);
      if (!cleared) {
        return res.status(404).json({ ok: false, error: 'No active message for device' });
      }
      return res.status(200).json({ ok: true, cleared: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
