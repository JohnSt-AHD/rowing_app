const { extractBearerToken, tokensEqual } = require('./org-auth');

/**
 * Require Bearer ADMIN_TOKEN (RNZ club admin). Separate from club ingest tokens.
 * @returns {Promise<boolean>} true if authorized
 */
async function requireAdmin(req, res) {
  const configured = String(process.env.ADMIN_TOKEN || '').trim();
  if (!configured) {
    res.status(503).json({
      ok: false,
      error: 'ADMIN_TOKEN is not configured on the server',
    });
    return false;
  }
  const token = extractBearerToken(req);
  if (!token || !tokensEqual(token, configured)) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = { requireAdmin };
