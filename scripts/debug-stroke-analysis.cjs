#!/usr/bin/env node
const https = require('https');
const { MotionAnalyzer } = require('../api/lib/motion-analysis');

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
        res.on('end', () => resolve(JSON.parse(body)));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const uid = 'W2x EH';
  const sessions = (await get(`/api/history?list=sessions&uniqueId=${encodeURIComponent(uid)}`)).sessions || [];
  const sid = sessions[0]?.session_id;
  const raw = await get(`/api/ingest?sessionId=${encodeURIComponent(sid)}`);
  const samples = (raw.samples || []).filter((s) => s.motion?.ax != null);
  for (const n of [90, 180, 360, 600, samples.length]) {
    const slice = samples.slice(-n);
    const a = new MotionAnalyzer();
    for (const s of slice) a.process(s.t, s.motion.ax, s.motion.ay, s.motion.az);
    const m = a.getMetrics();
    const dt = slice.length > 1 ? (slice.at(-1).t - slice[0].t) / 1000 : 0;
    console.log('window', n, 'spanSec', Math.round(dt), 'peaks', a.peaks?.length ?? '?', m);
  }
})();
