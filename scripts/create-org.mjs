#!/usr/bin/env node
/**
 * Create or update a rowing club (org) and ingest token.
 *
 * Usage:
 *   POSTGRES_URL=... node scripts/create-org.mjs --slug karapiro --name "Karapiro RC" --token "secret"
 *
 * Or add clubs via Vercel env ORG_TOKENS (JSON) and redeploy — see docs/MULTI-TENANT.md
 */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    token: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || !values.slug || !values.token) {
  console.log(`Usage: node scripts/create-org.mjs --slug <slug> --name "Club name" --token <secret>

Requires POSTGRES_URL (or DATABASE_URL) in the environment.`);
  process.exit(values.help ? 0 : 1);
}

const slug = String(values.slug).trim().toLowerCase();
const name = String(values.name ?? slug).trim();
const token = String(values.token).trim();
const pepper = process.env.ORG_TOKEN_PEPPER || 'rnz-org-v1';
const tokenHash = createHash('sha256').update(`${pepper}:${token}`).digest('hex');

const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('POSTGRES_URL or DATABASE_URL required');
  process.exit(1);
}

const { sql } = await import('@vercel/postgres');

await sql`
  CREATE TABLE IF NOT EXISTS rnz_orgs (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const rows = await sql`
  INSERT INTO rnz_orgs (slug, name, token_hash)
  VALUES (${slug}, ${name}, ${tokenHash})
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    token_hash = EXCLUDED.token_hash
  RETURNING id, slug, name
`;

const org = rows.rows[0];
console.log('Org ready:');
console.log(`  id:   ${org.id}`);
console.log(`  slug: ${org.slug}`);
console.log(`  name: ${org.name}`);
console.log('');
console.log('Give coaches and recorder phones this ingest token (Settings → Ingest token).');
console.log('Same API URL for all clubs — token selects the fleet.');
