const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');
const notify = require('./lib/capsize-notify');
const mail = require('./lib/capsize-mail');

/**
 * Capsize email alert admin + test send.
 * GET  /api/capsize-alerts — list recipients + mail readiness
 * POST /api/capsize-alerts?action=add-email|remove-email|test
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
      const list = await notify.listCapsizeNotifyEmails(org.id);
      const flags = mail.mailConfigFlags(list.emails.length);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        emails: list.emails,
        editable: list.editable,
        persisted: list.persisted,
        source: list.source,
        seedDefault: notify.DEFAULT_SEED_EMAIL,
        ...flags,
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
    if (action === 'add-email') {
      const emails = await notify.addCapsizeNotifyEmail(org.id, body.email);
      return res.status(200).json({ ok: true, emails });
    }
    if (action === 'remove-email') {
      const emails = await notify.removeCapsizeNotifyEmail(org.id, body.email);
      return res.status(200).json({ ok: true, emails });
    }
    if (action === 'test') {
      const list = await notify.listCapsizeNotifyEmails(org.id);
      let to = list.emails;
      const override = notify.normalizeEmail(body.email);
      if (override) to = [override];
      if (!to.length) {
        return res.status(400).json({
          ok: false,
          error: 'Add at least one recipient, or pass email for the test send',
        });
      }
      const result = await notify.sendCapsizeEmails({
        to,
        boat: body.boat || 'TEST BOAT (W2- KL)',
        lat: body.lat != null ? Number(body.lat) : -37.9407,
        lon: body.lon != null ? Number(body.lon) : 175.5575,
        eventMs: Date.now(),
        isTest: true,
      });
      return res.status(200).json({ ok: true, ...result });
    }
    return res.status(400).json({
      ok: false,
      error: 'Unknown action. Use add-email, remove-email, or test.',
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
};
