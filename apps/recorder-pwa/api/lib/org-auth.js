/**
 * Resolve rowing club (org) from Bearer ingest token.
 * Each org has its own token; all API data is scoped by org_id.
 */
const crypto = require('crypto');
const db = require('./db');

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const q = req.query?.token;
  return q ? String(q).trim() : '';
}

function hashToken(token) {
  const pepper = process.env.ORG_TOKEN_PEPPER || 'rnz-org-v1';
  return crypto.createHash('sha256').update(`${pepper}:${token}`).digest('hex');
}

function tokensEqual(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ id: number, slug: string, name: string } | null>}
 */
async function resolveOrg(req) {
  const token = extractBearerToken(req);

  if (db.hasDb()) {
    await db.ensureOrgsBootstrapped();
    if (token) {
      const byHash = await db.findOrgByTokenHash(hashToken(token));
      if (byHash) return byHash;
      const legacy = String(process.env.INGEST_TOKEN || '').trim();
      if (legacy && tokensEqual(token, legacy)) {
        const def = await db.getDefaultOrg();
        if (def) return def;
      }
    }
    const authRequired = await db.isOrgAuthRequired();
    if (!authRequired) return db.getDefaultOrg();
    return null;
  }

  return db.resolveMemoryOrgFromToken(token);
}

module.exports = {
  extractBearerToken,
  hashToken,
  tokensEqual,
  resolveOrg,
};
