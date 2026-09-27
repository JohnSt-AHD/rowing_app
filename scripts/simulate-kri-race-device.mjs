#!/usr/bin/env node
/**
 * Simulate a test device on the RNZ RowSafe 2 km course using KRI race lane speed data.
 *
 * Posts GPS every 2 s along a smooth straight course (start → finish → start) with gps.spd
 * matching the interpolated KRI speed profile so you can compare server pathSpeedMps /
 * displaySpeedMps on the dashboard against ground-truth speed.
 *
 * Usage:
 *   node scripts/simulate-kri-race-device.mjs
 *   node scripts/simulate-kri-race-device.mjs --lane ESP1 --round-trip
 *   node scripts/simulate-kri-race-device.mjs --dry-run --max-steps 20
 *
 * Env: INGEST_TOKEN (or .env.local / .env) — defaults to "rnz" for production smoke tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOCK_PATH = path.join(os.tmpdir(), 'crewsight-kri-race-sim.lock');

function acquireSingleInstanceLock() {
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const prev = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
      if (Number.isFinite(prev) && prev > 0) {
        try {
          process.kill(prev, 0);
          throw new Error(
            `Another KRI simulator is already running (PID ${prev}). Stop it first or delete ${LOCK_PATH}`,
          );
        } catch (err) {
          if (err.code !== 'ESRCH') throw err;
        }
      }
    } catch (err) {
      if (err.message.includes('Another KRI simulator')) throw err;
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(LOCK_PATH);
      }
    } catch {
      /* ignore */
    }
  };
  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(0);
  });
}

const DEFAULT_BASE = 'https://rowing-app-recorder-pwa.vercel.app';
const DEFAULT_KRI_DATA =
  'https://ahd-livestream.vercel.app/data/kri-sample-wrcp1-m1x-h1.json';
const DEFAULT_DEVICE = 'TEST-KRI-RACE';
const DEFAULT_LANE = 'ESP1';
const DEFAULT_COURSE = '2 km course';
const REPORT_INTERVAL_MS = 2000;
const DEFAULT_TURN_DWELL_SEC = 4;
const DEFAULT_LAP_PAUSE_SEC = 2;
const INGEST_RETRY_ATTEMPTS = 5;
const EARTH_RADIUS_M = 6371000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const opts = {
    base: DEFAULT_BASE,
    kriData: DEFAULT_KRI_DATA,
    deviceId: DEFAULT_DEVICE,
    lane: DEFAULT_LANE,
    courseGroup: DEFAULT_COURSE,
    intervalMs: REPORT_INTERVAL_MS,
    roundTrip: true,
    dryRun: false,
    compare: true,
    loop: false,
    turnDwellSec: DEFAULT_TURN_DWELL_SEC,
    lapPauseSec: DEFAULT_LAP_PAUSE_SEC,
    maxSteps: Infinity,
    token: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--round-trip') opts.roundTrip = true;
    else if (a === '--one-way') opts.roundTrip = false;
    else if (a === '--loop') opts.loop = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-compare') opts.compare = false;
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--data') opts.kriData = argv[++i];
    else if (a === '--device') opts.deviceId = argv[++i];
    else if (a === '--lane') opts.lane = argv[++i];
    else if (a === '--course') opts.courseGroup = argv[++i];
    else if (a === '--interval') opts.intervalMs = Number(argv[++i]);
    else if (a === '--turn-dwell') opts.turnDwellSec = Number(argv[++i]);
    else if (a === '--lap-pause') opts.lapPauseSec = Number(argv[++i]);
    else if (a === '--max-steps') opts.maxSteps = Number(argv[++i]);
    else if (a === '--token') opts.token = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/simulate-kri-race-device.mjs [options]
  --lane ESP1          KRI boat id (default ESP1, rank-1 M1x heat)
  --device TEST-KRI-RACE
  --round-trip         Outbound + return (default)
  --one-way            Start → finish only
  --loop               Repeat round trips until stopped
  --interval 2000      Ms between uploads (default 2000)
  --turn-dwell 4       Seconds at finish line before return leg
  --lap-pause 2        Seconds at start line between laps
  --max-steps N        Stop after N samples (for smoke tests)
  --dry-run            Print path only, no ingest
  --no-compare         Skip polling /api/devices for speed comparison
  --base URL           API base (default production recorder PWA)
  --data URL           KRI speed JSON (default WC M1x H1 sample)
`);
      process.exit(0);
    }
  }
  return opts;
}

function readEnvToken() {
  if (process.env.INGEST_TOKEN) return process.env.INGEST_TOKEN;
  for (const file of ['.env.local', '.env.vercel.local', '.env']) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*INGEST_TOKEN\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[1].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) return value;
    }
  }
  return 'rnz';
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function destinationLatLon(lat, lon, bearingDeg, distM) {
  if (!Number.isFinite(distM) || distM <= 0) return { lat, lon };
  const δ = distM / EARTH_RADIUS_M;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: toDeg(φ2), lon: toDeg(λ2) };
}

function lineMidpoint(line) {
  return {
    lat: (Number(line.lat1) + Number(line.lat2)) / 2,
    lon: (Number(line.lon1) + Number(line.lon2)) / 2,
  };
}

function fmtMps(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const split500 = v > 0 ? 500 / v : null;
  const splitStr =
    split500 != null
      ? `${Math.floor(split500 / 60)}:${String(Math.round(split500 % 60)).padStart(2, '0')}/500`
      : '';
  return `${v.toFixed(2)} m/s${splitStr ? ` (${splitStr})` : ''}`;
}

function pctErr(actual, expected) {
  if (actual == null || expected == null || !Number.isFinite(actual) || expected <= 0) return null;
  return ((actual - expected) / expected) * 100;
}

async function fetchJson(url, token, options = {}) {
  const retries = options.retries ?? 3;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const headers = {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      };
      const { retries: _r, ...fetchOpts } = options;
      const res = await fetch(url, { ...fetchOpts, headers });
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text.slice(0, 300) };
      }
      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(data).slice(0, 400)}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < retries) {
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

function buildSpeedInterpolator(points) {
  const sorted = [...points].sort((a, b) => a.distance - b.distance);
  const maxD = sorted[sorted.length - 1]?.distance ?? 2000;
  return {
    maxDistanceM: maxD,
    at(distanceM) {
      const d = Math.max(0, Math.min(maxD, distanceM));
      if (d <= sorted[0].distance) return sorted[0].speed;
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const next = sorted[i];
        if (d <= next.distance) {
          const span = next.distance - prev.distance;
          if (span <= 0) return next.speed;
          const t = (d - prev.distance) / span;
          return prev.speed + t * (next.speed - prev.speed);
        }
      }
      return sorted[sorted.length - 1].speed;
    },
  };
}

function buildCourse(lines, courseGroup) {
  const groupLines = lines
    .filter((l) => l.courseGroup === courseGroup && l.enabled !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  if (!groupLines.length) {
    throw new Error(`No timing lines for courseGroup="${courseGroup}"`);
  }
  const start = groupLines.find((l) => l.lineType === 'start') ?? groupLines[0];
  const finish =
    groupLines.find((l) => l.lineType === 'finish') ??
    groupLines[groupLines.length - 1];
  const courseM = Number(finish.distanceM ?? 2000);
  const bearing = Number(start.courseBearingDeg ?? finish.courseBearingDeg);
  if (!Number.isFinite(courseM) || courseM < 100) {
    throw new Error(`Invalid course distance ${courseM}`);
  }
  if (!Number.isFinite(bearing)) throw new Error('courseBearingDeg missing on timing lines');
  const origin = lineMidpoint(start);
  return { origin, bearing, courseM, start, finish, lines: groupLines };
}

async function postSample(base, token, sessionId, deviceId, sample) {
  const body = JSON.stringify({
    sessionId,
    deviceId,
    athleteId: 'KRI-SIM-M1X',
    samples: [sample],
  });
  return fetchJson(`${base}/api/ingest`, token, {
    method: 'POST',
    body,
    retries: INGEST_RETRY_ATTEMPTS,
  });
}

async function fetchDeviceSpeed(base, token, deviceId) {
  const data = await fetchJson(
    `${base}/api/devices?windowSec=180&onlineSec=300&includeMetrics=1`,
    token,
  );
  return (data.devices || []).find((d) => d.deviceId === deviceId) ?? null;
}

function frameAt(course, speedAt, distanceM, leg) {
  const speedMps = speedAt(distanceM);
  const point = destinationLatLon(
    course.origin.lat,
    course.origin.lon,
    course.bearing,
    distanceM,
  );
  const hdg =
    leg === 'return'
      ? (course.bearing + 180) % 360
      : course.bearing;
  return {
    distanceM,
    speedMps,
    lat: point.lat,
    lon: point.lon,
    hdg,
    leg,
  };
}

async function dwellFixes(opts, course, speedAt, sessionId, distanceM, leg, dwellSec, label) {
  if (dwellSec <= 0) return;
  const endAt = Date.now() + dwellSec * 1000;
  while (Date.now() < endAt) {
    const frame = frameAt(course, speedAt, distanceM, leg);
    const sample = {
      t: Date.now(),
      gps: {
        lat: frame.lat,
        lon: frame.lon,
        acc: 3,
        spd: Math.min(frame.speedMps, 0.5),
        hdg: frame.hdg,
      },
      derived: { strokeRate: 0 },
    };
    if (!opts.dryRun) {
      await postSample(opts.base, opts.token, sessionId, opts.deviceId, sample);
    }
    console.log(`  … ${label} ${Math.round(distanceM)} m`);
    await sleep(opts.intervalMs);
  }
}

async function runSimulation(opts, course, speedAt, sessionId) {
  const comparisons = [];
  let step = 0;
  let distanceM = 0;
  let leg = 'outbound';
  let lastAdvanceMs = Date.now();
  let nextPostMs = Date.now();

  if (opts.lapPauseSec > 0) {
    await dwellFixes(opts, course, speedAt, sessionId, 0, 'outbound', opts.lapPauseSec, 'lap pause');
  }

  while (step < opts.maxSteps) {
    const now = Date.now();
    if (now < nextPostMs) {
      await sleep(nextPostMs - now);
    }
    const postAt = Date.now();

    step += 1;
    const frame = frameAt(course, speedAt, distanceM, leg);

    const sample = {
      t: postAt,
      gps: {
        lat: frame.lat,
        lon: frame.lon,
        acc: 3,
        spd: frame.speedMps,
        hdg: frame.hdg,
      },
      derived: { strokeRate: 32 },
    };

    const legLabel = leg === 'return' ? '←' : '→';
    const logStep = !opts.loop || step === 1 || step % 25 === 0;
    const line = `[${String(step).padStart(3)}] ${legLabel} ${Math.round(frame.distanceM)} m  true=${frame.speedMps.toFixed(2)} m/s  (${frame.lat.toFixed(5)}, ${frame.lon.toFixed(5)})`;

    if (opts.dryRun) {
      if (logStep) console.log(line);
    } else {
      try {
        const ingest = await postSample(opts.base, opts.token, sessionId, opts.deviceId, sample);
        if (!ingest.ok || Number(ingest.received) < 1) {
          console.warn(`${line}  ingest WARN: ${JSON.stringify(ingest)}`);
        }
      } catch (err) {
        console.warn(`${line}  ingest FAILED (continuing): ${err.message}`);
      }

      let compareLine = '';
      if (opts.compare) {
        await sleep(400);
        try {
          const dev = await fetchDeviceSpeed(opts.base, opts.token, opts.deviceId);
          const path = dev?.pathSpeedMps ?? null;
          const display = dev?.displaySpeedMps ?? null;
          const pathErr = pctErr(path, frame.speedMps);
          const dispErr = pctErr(display, frame.speedMps);
          comparisons.push({
            step,
            distanceM: frame.distanceM,
            trueMps: frame.speedMps,
            pathMps: path,
            displayMps: display,
            pathErrPct: pathErr,
            displayErrPct: dispErr,
          });
          compareLine = `  path=${fmtMps(path)} (${pathErr != null ? `${pathErr >= 0 ? '+' : ''}${pathErr.toFixed(1)}%` : '—'})  display=${fmtMps(display)} (${dispErr != null ? `${dispErr >= 0 ? '+' : ''}${dispErr.toFixed(1)}%` : '—'})`;
        } catch (err) {
          compareLine = `  compare failed: ${err.message}`;
        }
      }

      if (logStep) console.log(line + compareLine);
    }

    const dtSec = Math.min(15, Math.max(0.25, (postAt - lastAdvanceMs) / 1000));
    lastAdvanceMs = postAt;
    const sign = leg === 'return' ? -1 : 1;
    distanceM += sign * frame.speedMps * dtSec;

    if (leg === 'outbound') {
      if (distanceM >= course.courseM) {
        distanceM = course.courseM;
        if (opts.roundTrip) {
          if (opts.turnDwellSec > 0) {
            await dwellFixes(
              opts,
              course,
              speedAt,
              sessionId,
              distanceM,
              'return',
              opts.turnDwellSec,
              'turn',
            );
          }
          leg = 'return';
        } else {
          break;
        }
      }
    } else if (distanceM <= 0) {
      distanceM = 0;
      break;
    }

    nextPostMs = postAt + opts.intervalMs;
    if (step >= opts.maxSteps) break;
  }

  return { comparisons, steps: step };
}

async function main() {
  acquireSingleInstanceLock();
  const opts = parseArgs(process.argv);
  opts.token = opts.token || readEnvToken();

  console.log('KRI race device simulator');
  console.log(`  base=${opts.base}`);
  console.log(`  device=${opts.deviceId}  lane=${opts.lane}  interval=${opts.intervalMs}ms`);
  console.log(
    `  course="${opts.courseGroup}"  roundTrip=${opts.roundTrip}  loop=${opts.loop}  turnDwell=${opts.turnDwellSec}s  lapPause=${opts.lapPauseSec}s`,
  );

  const kri = await fetchJson(opts.kriData, '');
  const boat = (kri.boats || []).find((b) => b.id === opts.lane);
  if (!boat) {
    const ids = (kri.boats || []).map((b) => b.id).join(', ');
    throw new Error(`Lane "${opts.lane}" not in KRI data. Available: ${ids}`);
  }
  const speedAt = buildSpeedInterpolator(boat.points).at;
  console.log(
    `  KRI source: ${kri.event} ${kri.round} race ${kri.race} — ${boat.id} (rank ${boat.rank})`,
  );
  console.log(
    `  speed range: ${fmtMps(Math.min(...boat.points.map((p) => p.speed)))} … ${fmtMps(Math.max(...boat.points.map((p) => p.speed)))}`,
  );

  const timing = await fetchJson(
    `${opts.base}/api/timing-lines?courseGroup=${encodeURIComponent(opts.courseGroup)}`,
    opts.token,
  );
  const course = buildCourse(timing.lines || [], opts.courseGroup);
  console.log(
    `  course ${course.courseM} m @ bearing ${course.bearing.toFixed(1)}° from (${course.origin.lat.toFixed(5)}, ${course.origin.lon.toFixed(5)})`,
  );

  const sessionId = `kri-sim-${Date.now()}`;
  console.log(`  sessionId=${sessionId}`);
  if (opts.dryRun) console.log('  DRY RUN — no ingest posts');
  if (opts.loop) {
    console.log(`\nWatch "${opts.deviceId}" on RowSafe dashboard — course "${opts.courseGroup}"`);
    console.log('Press Ctrl+C to stop.\n');
  }

  let lap = 0;
  let allComparisons = [];
  do {
    lap += 1;
    if (opts.loop) console.log(`--- Lap ${lap} ---`);
    try {
      const { comparisons, steps } = await runSimulation(opts, course, speedAt, sessionId);
      allComparisons = allComparisons.concat(comparisons);
      if (opts.loop) {
        console.log(`Lap ${lap} complete (${steps} fixes). Restarting from start…`);
      }
    } catch (err) {
      console.warn(`Lap ${lap} error (retrying in 5s): ${err.message}`);
      await sleep(5000);
    }
  } while (opts.loop);

  if (allComparisons.length) {
    const comparisons = allComparisons;
    const withPath = comparisons.filter((c) => c.pathMps != null);
    const withDisplay = comparisons.filter((c) => c.displayMps != null);
    const avgAbs = (arr, key) => {
      const vals = arr.map((c) => Math.abs(c[key])).filter(Number.isFinite);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    console.log('\nSpeed smoothing summary (vs ground-truth gps.spd):');
    console.log(`  samples compared: ${comparisons.length}`);
    if (withPath.length) {
      console.log(
        `  pathSpeedMps (60s window): avg |error| ${avgAbs(withPath, 'pathErrPct')?.toFixed(1)}% over ${withPath.length} readings`,
      );
    }
    if (withDisplay.length) {
      console.log(
        `  displaySpeedMps (EMA α=0.2): avg |error| ${avgAbs(withDisplay, 'displayErrPct')?.toFixed(1)}% over ${withDisplay.length} readings`,
      );
    }
    console.log('\nWatch live on RowSafe dashboard (2 km course) — device:', opts.deviceId);
  } else if (!opts.dryRun && !opts.loop) {
    console.log(`\nDone. Watch device "${opts.deviceId}" on the RowSafe dashboard (select "${opts.courseGroup}").`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
