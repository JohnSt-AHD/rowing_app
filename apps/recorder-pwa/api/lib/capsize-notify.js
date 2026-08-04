/**
 * Capsize email recipient list + fire-on-raise helper.
 * Postgres when available; in-memory fallback for local/dev.
 */
const db = require('./db');
const mail = require('./capsize-mail');

const DEFAULT_SEED_EMAIL = 'j.w.storey21@gmail.com';

/** @type {Map<number, Set<string>>} */
const memoryEmailsByOrg =
  globalThis.__rnzCapsizeNotifyEmails ?? new Map();
globalThis.__rnzCapsizeNotifyEmails = memoryEmailsByOrg;

/** Dedupe recent sends across warm instances. */
const recentSendByDevice = globalThis.__rnzCapsizeEmailSent ?? new Map();
globalThis.__rnzCapsizeEmailSent = recentSendByDevice;
const SEND_DEDUP_MS = 2 * 60 * 1000;

function normalizeEmail(email) {
  const e = String(email || '')
    .trim()
    .toLowerCase();
  if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function envBootstrapEmails() {
  const raw = String(process.env.CAPSIZE_NOTIFY_EMAILS || '').trim();
  if (!raw) return [DEFAULT_SEED_EMAIL];
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((e) => normalizeEmail(e))
        .filter(Boolean),
    ),
  ];
}

function memoryList(orgId) {
  const set = memoryEmailsByOrg.get(Number(orgId));
  return set ? [...set].sort() : [];
}

function memoryEnsureSeed(orgId) {
  const id = Number(orgId);
  if (!memoryEmailsByOrg.has(id) || memoryEmailsByOrg.get(id).size === 0) {
    memoryEmailsByOrg.set(id, new Set(envBootstrapEmails()));
  }
}

async function ensureCapsizeNotifyTable() {
  if (!db.hasDb()) return;
  await db.ensureCapsizeNotifyEmailsTable();
}

/**
 * @returns {Promise<{ emails: string[], editable: boolean, persisted: boolean, source: string }>}
 */
async function listCapsizeNotifyEmails(orgId) {
  if (db.hasDb()) {
    await ensureCapsizeNotifyTable();
    let emails = await db.listCapsizeNotifyEmails(orgId);
    if (!emails.length) {
      const seed = envBootstrapEmails();
      for (const e of seed) {
        await db.addCapsizeNotifyEmail(orgId, e);
      }
      emails = await db.listCapsizeNotifyEmails(orgId);
      return {
        emails,
        editable: true,
        persisted: true,
        source: emails.length ? 'db-seeded' : 'db',
      };
    }
    return { emails, editable: true, persisted: true, source: 'db' };
  }
  memoryEnsureSeed(orgId);
  return {
    emails: memoryList(orgId),
    editable: true,
    persisted: false,
    source: 'memory',
  };
}

async function addCapsizeNotifyEmail(orgId, email) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('Enter a valid email address');
  if (db.hasDb()) {
    await ensureCapsizeNotifyTable();
    return db.addCapsizeNotifyEmail(orgId, e);
  }
  memoryEnsureSeed(orgId);
  const set = memoryEmailsByOrg.get(Number(orgId));
  set.add(e);
  return memoryList(orgId);
}

async function removeCapsizeNotifyEmail(orgId, email) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('Enter a valid email address');
  if (db.hasDb()) {
    await ensureCapsizeNotifyTable();
    return db.removeCapsizeNotifyEmail(orgId, e);
  }
  memoryEnsureSeed(orgId);
  const set = memoryEmailsByOrg.get(Number(orgId));
  set.delete(e);
  return memoryList(orgId);
}

function shouldSendForDevice(orgId, deviceId, eventMs) {
  const key = `${orgId}:${deviceId}`;
  const prev = recentSendByDevice.get(key);
  const t = Number(eventMs) || Date.now();
  if (prev != null && t - prev < SEND_DEDUP_MS) return false;
  recentSendByDevice.set(key, t);
  return true;
}

/**
 * Fire-and-forget from ingest when a sticky capsize alert newly activates.
 * @param {{ orgId: number, deviceId: string, eventMs: number, lat?: number|null, lon?: number|null }} detail
 */
async function notifyCapsizeRaised(detail) {
  const orgId = detail.orgId;
  const deviceId = String(detail.deviceId || '').trim() || 'Unknown';
  const eventMs = Number(detail.eventMs) || Date.now();
  if (!shouldSendForDevice(orgId, deviceId, eventMs)) return { skipped: true, reason: 'dedupe' };

  const { emails } = await listCapsizeNotifyEmails(orgId);
  if (!emails.length) return { skipped: true, reason: 'no-recipients' };

  const flags = mail.mailConfigFlags(emails.length);
  if (!flags.ready) return { skipped: true, reason: 'mail-not-configured' };

  try {
    const result = await mail.sendCapsizeEmails({
      to: emails,
      boat: deviceId,
      lat: detail.lat,
      lon: detail.lon,
      eventMs,
      isTest: false,
    });
    console.log(
      `[capsize-notify] emailed ${result.sent} recipient(s) for ${deviceId} id=${result.id}`,
    );
    return { ok: true, ...result };
  } catch (err) {
    console.error('[capsize-notify] send failed:', err);
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = {
  DEFAULT_SEED_EMAIL,
  normalizeEmail,
  listCapsizeNotifyEmails,
  addCapsizeNotifyEmail,
  removeCapsizeNotifyEmail,
  notifyCapsizeRaised,
  mailConfigFlags: mail.mailConfigFlags,
  sendCapsizeEmails: mail.sendCapsizeEmails,
  formatNzTime: mail.formatNzTime,
};
