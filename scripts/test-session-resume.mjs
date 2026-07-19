/**
 * Logic tests for native session auto-resume (screen-off / minimize / reopen).
 * Run: node scripts/test-session-resume.mjs
 */

const SESSION_MAX_AGE_MS = 20 * 60 * 60 * 1000;
const RESUME_MAX_IDLE_MS = 6 * 60 * 60 * 1000;

function canAutoResume(native, persisted) {
  return (
    Boolean(native?.active && native.sessionId && native.deviceId) ||
    Boolean(persisted?.sessionId && persisted.deviceId)
  );
}

function isSessionTooOldToResume(startedAt, serviceRunning, now = Date.now()) {
  if (!startedAt || !Number.isFinite(startedAt)) return false;
  if (now - startedAt > SESSION_MAX_AGE_MS) return true;
  if (!serviceRunning && now - startedAt > RESUME_MAX_IDLE_MS) return true;
  return false;
}

function resolveResumeCandidate(
  native,
  persisted,
  settingsDeviceId,
  stored,
  now = Date.now(),
) {
  if (!canAutoResume(native, persisted)) {
    return { action: 'none' };
  }
  const useNative = Boolean(native?.active && native.sessionId && native.deviceId);
  const sessionId = useNative ? native.sessionId : persisted.sessionId;
  const deviceId = useNative ? native.deviceId : persisted.deviceId;
  if (settingsDeviceId.trim() !== deviceId.trim()) {
    return { action: 'mismatch', savedDeviceId: deviceId, settingsDeviceId };
  }
  if (stored?.endedAt) {
    return {
      action: 'stale',
      reason: 'previous session was stopped',
      sessionId,
      deviceId,
    };
  }
  const startedAt = stored?.startedAt ?? native?.startedAt ?? persisted?.startedAt;
  const serviceRunning = Boolean(native?.serviceRunning);
  if (isSessionTooOldToResume(startedAt, serviceRunning, now)) {
    return {
      action: 'stale',
      reason: serviceRunning ? 'session exceeded maximum length' : 'session idle too long',
      sessionId,
      deviceId,
    };
  }
  return {
    action: 'resume',
    candidate: {
      sessionId,
      deviceId,
      startedAt,
      athleteId: native?.athleteId,
      serviceRunning,
    },
  };
}

const now = 1_700_000_000_000;

const cases = [
  {
    name: 'minimized — service still running, persisted in localStorage',
    native: {
      active: true,
      serviceRunning: true,
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: now - 60_000,
    },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: now - 60_000,
    },
    settingsDeviceId: 'CREW-01',
    stored: { startedAt: now - 60_000 },
    expect: { action: 'resume', skipNativeStart: true },
  },
  {
    name: 'service running but localStorage lost (WebView wiped)',
    native: {
      active: true,
      serviceRunning: true,
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: now - 120_000,
    },
    persisted: null,
    settingsDeviceId: 'CREW-01',
    stored: { startedAt: now - 120_000 },
    expect: { action: 'resume', skipNativeStart: true },
  },
  {
    name: 'phone reboot — persisted only, service not running',
    native: { active: false, serviceRunning: false },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: now - 30 * 60 * 1000,
    },
    settingsDeviceId: 'CREW-01',
    stored: { startedAt: now - 30 * 60 * 1000 },
    expect: { action: 'resume', skipNativeStart: false },
  },
  {
    name: 'intentional stop — nothing persisted',
    native: { active: false, serviceRunning: false },
    persisted: null,
    settingsDeviceId: 'CREW-01',
    stored: null,
    expect: { action: 'none' },
  },
  {
    name: 'device ID changed in settings — do not resume',
    native: {
      active: true,
      serviceRunning: true,
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
    },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: now - 60_000,
    },
    settingsDeviceId: 'CREW-99',
    stored: { startedAt: now - 60_000 },
    expect: { action: 'mismatch' },
  },
  {
    name: 'stopped session — endedAt set locally',
    native: { active: false, serviceRunning: false },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: now - 60_000,
    },
    settingsDeviceId: 'CREW-01',
    stored: { startedAt: now - 60_000, endedAt: now - 30_000 },
    expect: { action: 'stale' },
  },
  {
    name: 'multi-day stale session with service still running',
    native: {
      active: true,
      serviceRunning: true,
      sessionId: 'old-session',
      deviceId: 'CREW-01',
      startedAt: now - 4 * 24 * 60 * 60 * 1000,
    },
    persisted: {
      sessionId: 'old-session',
      deviceId: 'CREW-01',
      startedAt: now - 4 * 24 * 60 * 60 * 1000,
    },
    settingsDeviceId: 'CREW-01',
    stored: { startedAt: now - 4 * 24 * 60 * 60 * 1000 },
    expect: { action: 'stale' },
  },
  {
    name: 'idle overnight without service — stale after 6h',
    native: { active: false, serviceRunning: false },
    persisted: {
      sessionId: 'abc-123',
      deviceId: 'CREW-01',
      startedAt: now - 7 * 60 * 60 * 1000,
    },
    settingsDeviceId: 'CREW-01',
    stored: { startedAt: now - 7 * 60 * 60 * 1000 },
    expect: { action: 'stale' },
  },
];

let failed = 0;
for (const c of cases) {
  const result = resolveResumeCandidate(
    c.native,
    c.persisted,
    c.settingsDeviceId,
    c.stored,
    now,
  );
  const ok =
    result.action === c.expect.action &&
    (c.expect.action !== 'resume' ||
      result.candidate.serviceRunning === c.expect.skipNativeStart);
  if (!ok) {
    failed++;
    console.error('FAIL:', c.name);
    console.error('  expected', c.expect);
    console.error('  got', result);
  } else {
    console.log('ok:', c.name);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} resume logic tests passed.`);
