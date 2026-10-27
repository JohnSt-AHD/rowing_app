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

  // Responding acks send help-on-the-way by default; crew-safe does not.
  // Escape hatch: { notifyHelp: false } or { notifyHelp: true }.
  const notifyHelp =
    body && Object.prototype.hasOwnProperty.call(body, 'notifyHelp')
      ? body.notifyHelp !== false
      : undefined;

  const result = await store.clearCapsizeAlert(org.id, deviceId, {
    ...(notifyHelp != null ? { notifyHelp } : {}),
    ackedBy: body?.ackedBy,
    ackSource: body?.ackSource,
    ackKind: body?.ackKind || body?.kind,
  });
  return res.status(200).json({ ok: true, ...result });
};
