const store = require('./lib/ingest-store');
const { requireOrg } = require('./lib/require-org');

/**
 * GET /api/timing-lines — list course timing lines
 * POST /api/timing-lines — create line or generate split course
 * PATCH /api/timing-lines?id= — update line geometry/settings
 * DELETE /api/timing-lines?id= — remove line (or courseGroup= to remove set)
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    return res.status(204).end();
  }

  const org = await requireOrg(req, res);
  if (!org) return;

  if (req.method === 'GET') {
    try {
      const lines = await store.listTimingLines(org.id);
      return res.status(200).json({
        ok: true,
        org: org.slug,
        persisted: store.hasDb(),
        lines,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
      if (body.generateSplits) {
        const lines = await store.generateTimingSplitCourse(org.id, body);
        return res.status(201).json({ ok: true, lines });
      }
      const line = await store.createTimingLine(org.id, body);
      if (!line) {
        return res.status(503).json({
          ok: false,
          error: 'No database — add POSTGRES_URL on Vercel to store timing lines.',
        });
      }
      return res.status(201).json({ ok: true, line });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const id = req.query?.id;
      if (id == null || id === '') {
        return res.status(400).json({ ok: false, error: 'id query parameter is required' });
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
      const line = await store.updateTimingLine(org.id, id, body);
      if (!line) {
        return res.status(404).json({ ok: false, error: 'Timing line not found' });
      }
      return res.status(200).json({ ok: true, line });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const id = req.query?.id;
      const courseGroup = req.query?.courseGroup;
      if (courseGroup) {
        const n = await store.deleteTimingCourseGroup(org.id, String(courseGroup));
        return res.status(200).json({ ok: true, deleted: n });
      }
      if (id == null || id === '') {
        return res.status(400).json({ ok: false, error: 'id or courseGroup required' });
      }
      const deleted = await store.deleteTimingLine(org.id, id);
      if (!deleted) {
        return res.status(404).json({ ok: false, error: 'Timing line not found' });
      }
      return res.status(200).json({ ok: true, deleted: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
