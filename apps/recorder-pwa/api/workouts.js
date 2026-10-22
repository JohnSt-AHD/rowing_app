const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');
const lib = require('./lib/workouts-store');

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') body = JSON.parse(body);
  return body || {};
}

/**
 * GET  /api/workouts
 * GET  /api/workouts?assignment=1
 * GET  /api/workouts?deviceId=
 * POST /api/workouts  { workouts } | { action: assign|progress|clear, ... }
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
      const deviceId = req.query?.deviceId ? String(req.query.deviceId).trim() : '';
      const wantAssign =
        deviceId ||
        String(req.query?.assignment || req.query?.assign || '') === '1';
      if (wantAssign) {
        const raw = await lib.getAssignment(org.id);
        const assignment = deviceId ? lib.assignmentForDevice(raw, deviceId) : raw;
        return res.status(200).json({
          ok: true,
          org: org.slug,
          assignment,
        });
      }
      const data = await lib.listWorkouts(org.id);
      return res.status(200).json({ ok: true, org: org.slug, ...data });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  const action = String(req.query?.action || body.action || '')
    .trim()
    .toLowerCase();

  try {
    if (action === 'assign') {
      const workout = body.workout;
      if (!workout || typeof workout !== 'object') {
        return res.status(400).json({ ok: false, error: 'workout is required' });
      }
      const startClock = String(body.startClock || '').trim();
      const startAtMs = Number(body.startAtMs);
      const assignment = {
        id: `asg-${Date.now().toString(36)}`,
        workout,
        deviceIds: Array.isArray(body.deviceIds)
          ? body.deviceIds.map((id) => String(id).trim()).filter(Boolean)
          : [],
        startAtMs: Number.isFinite(startAtMs) && startAtMs > 0 ? startAtMs : Date.now() + 15_000,
        startClock: startClock || '',
        tz: String(body.tz || 'Pacific/Auckland'),
        coachName: String(body.coachName || 'Coach').trim() || 'Coach',
        sentAt: Date.now(),
        progress: {},
      };
      await lib.saveAssignment(org.id, assignment);
      return res.status(200).json({ ok: true, assignment });
    }
    if (action === 'progress') {
      const deviceId = String(body.deviceId || '').trim();
      if (!deviceId) {
        return res.status(400).json({ ok: false, error: 'deviceId is required' });
      }
      const assignment = await lib.mergeProgress(org.id, deviceId, body);
      return res.status(200).json({ ok: true, assignment });
    }
    if (action === 'clear') {
      await lib.clearAssignment(org.id);
      return res.status(200).json({ ok: true, assignment: null });
    }
    const data = await lib.saveWorkouts(org.id, body.workouts);
    return res.status(200).json({ ok: true, org: org.slug, ...data });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
};
