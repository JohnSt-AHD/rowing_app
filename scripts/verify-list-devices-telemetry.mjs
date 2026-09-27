#!/usr/bin/env node
/** Simulate listDevices stroke/battery merge using production session samples. */
const https = require('https');
const { analyzeMotionWindow } = require('../api/lib/motion-analysis');

const BASE = 'https://rowing-app-recorder-pwa.vercel.app';
const TOKEN = 'rnz';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${BASE}${path}`,
      { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  for (const uid of ['M1x TM', 'W2x EH']) {
    const sessions = (await get(`/api/history?list=sessions&uniqueId=${encodeURIComponent(uid)}`)).sessions || [];
    const sid = sessions[0]?.session_id;
    const raw = await get(`/api/ingest?sessionId=${encodeURIComponent(sid)}`);
    const samples = raw.samples || [];
    const motion = samples.filter((s) => s.motion?.ax != null).slice(-90);
    const analyzed = analyzeMotionWindow(motion);
    const bats = samples.filter((s) => s.derived?.batteryPct != null);
    const lastBat = bats[bats.length - 1];
    console.log(uid, {
      motionWindow: motion.length,
      strokeRate: analyzed?.strokeRate ?? null,
      calibrated: analyzed?.calibrated ?? false,
      batteryPct: lastBat?.derived?.batteryPct ?? null,
      batteryAgeMin: lastBat ? Math.round((Date.now() - lastBat.t) / 60000) : null,
    });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
