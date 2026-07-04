const store = require('./ingest-store');

/**
 * Resolve org from request or send 401.
 * @returns {Promise<{ id: number, slug: string, name: string } | null>}
 */
async function requireOrg(req, res) {
  const org = await store.resolveOrg(req);
  if (!org) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return null;
  }
  return org;
}

module.exports = { requireOrg };
