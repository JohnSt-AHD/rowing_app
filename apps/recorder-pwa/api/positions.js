const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');

module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  const onlineSec = Math.min(
    120,
    Math.max(5, Number(req.query?.onlineSec) || 30),
  );

  if (store.hasDb()) {
    try {
      const snap = await store.getTraccarSnapshot(org.id, onlineSec * 1000);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        polledAt: Date.now(),
        onlineThresholdSec: onlineSec,
        positions: snap.positions.map((p) => ({
          uniqueId: p.deviceName || p.attributes?.uniqueId,
          deviceId: p.deviceId,
          numericDeviceId: p.deviceId,
          latitude: p.latitude,
          longitude: p.longitude,
          accuracy: p.accuracy,
          speed: p.speed,
          course: p.course,
          altitude: p.altitude,
          fixTime: p.fixTime,
          deviceTime: p.deviceTime,
          attributes: p.attributes,
        })),
        persisted: true,
      });
    } catch (err) {
      console.error('[positions] DB failed:', err);
    }
  }

  const payload = store.getPositionsSnapshot(org.id, onlineSec * 1000);
  return res.status(200).json({ ok: true, org: org.slug, ...payload, persisted: false });
};
