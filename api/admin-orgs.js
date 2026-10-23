const crypto = require('crypto');
const store = require('./lib/ingest-store');
const db = require('./lib/db');
const { requireAdmin } = require('./lib/require-admin');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

function readBody(req) {
  if (req.body && typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function normalizeSlug(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase();
}

function assertValidSlug(slug) {
  if (!SLUG_RE.test(slug)) {
    throw new Error('Slug must be 2–32 chars: lowercase letters, digits, hyphens');
  }
}

const MAX_TOKEN_LEN = 256;

function newIngestToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizePlainToken(raw, required) {
  const token = String(raw ?? '').trim();
  if (!token) {
    if (required) throw new Error('Password is required');
    return '';
  }
  if (token.length > MAX_TOKEN_LEN) {
    throw new Error(`Password is too long (max ${MAX_TOKEN_LEN} characters)`);
  }
  return token;
}

function isTokenTakenError(err) {
  const msg = String(err?.message || err);
  return /token_hash|duplicate key value/i.test(msg);
}

function tokenTakenError() {
  return new Error('This password is already used by another club. Choose a different password.');
}

function orgPayload(org) {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    createdAt: org.created_at ?? org.createdAt ?? null,
  };
}

async function applyOrgToken(slug, token) {
  try {
    return await db.rotateOrgToken(slug, token);
  } catch (e) {
    if (isTokenTakenError(e)) throw tokenTakenError();
    throw e;
  }
}

/**
 * RNZ club admin (ADMIN_TOKEN).
 * GET    — list clubs (no secrets)
 * POST   — create { slug, name?, token? } | rotate { action: "rotate", slug }
 *          | set-token { action: "set-token", slug, token }
 * PATCH  — rename { slug, name }
 */
module.exports = async function handler(req, res) {
  store.cors(res);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    return res.status(204).end();
  }

  const ok = await requireAdmin(req, res);
  if (!ok) return;

  if (!db.hasDb()) {
    return res.status(503).json({
      ok: false,
      error: 'No database — add POSTGRES_URL on Vercel to manage clubs.',
    });
  }

  try {
    if (req.method === 'GET') {
      const orgs = await db.listOrgs();
      return res.status(200).json({
        ok: true,
        orgs: orgs.map((o) => ({
          id: o.id,
          slug: o.slug,
          name: o.name,
          createdAt: o.created_at ?? o.createdAt ?? null,
        })),
      });
    }

    const body = readBody(req);

    if (req.method === 'POST') {
      const action = String(body.action || req.query?.action || '')
        .trim()
        .toLowerCase();

      if (action === 'rotate') {
        const slug = normalizeSlug(body.slug);
        assertValidSlug(slug);
        const token = newIngestToken();
        const org = await applyOrgToken(slug, token);
        return res.status(200).json({
          ok: true,
          org: orgPayload(org),
          token,
          warning: 'Copy this token now — it cannot be retrieved again.',
        });
      }

      if (action === 'set-token' || action === 'set_token') {
        const slug = normalizeSlug(body.slug);
        assertValidSlug(slug);
        const token = normalizePlainToken(body.token ?? body.password, true);
        const org = await applyOrgToken(slug, token);
        return res.status(200).json({
          ok: true,
          org: orgPayload(org),
          token,
          warning: 'Copy this token now — it cannot be retrieved again.',
        });
      }

      const slug = normalizeSlug(body.slug);
      assertValidSlug(slug);
      const name = String(body.name ?? slug).trim() || slug;
      const customToken = normalizePlainToken(body.token ?? body.password, false);
      const token = customToken || newIngestToken();
      let org;
      try {
        org = await db.createOrgExclusive(slug, name, token);
      } catch (e) {
        if (isTokenTakenError(e)) throw tokenTakenError();
        throw e;
      }
      return res.status(201).json({
        ok: true,
        org: orgPayload(org),
        token,
        warning: 'Copy this token now — it cannot be retrieved again.',
      });
    }

    if (req.method === 'PATCH') {
      const slug = normalizeSlug(body.slug);
      assertValidSlug(slug);
      const name = String(body.name ?? '').trim();
      if (!name) {
        return res.status(400).json({ ok: false, error: 'name is required' });
      }
      const org = await db.updateOrgName(slug, name);
      return res.status(200).json({
        ok: true,
        org: orgPayload(org),
      });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    const msg = String(e.message || e);
    const status = /already exists|already used|not found|Slug must|Password is/i.test(msg)
      ? 400
      : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
};
