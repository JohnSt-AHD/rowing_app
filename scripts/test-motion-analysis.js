import { MotionAnalyzer, analyzeMotionWindow } from '../packages/motion-analysis/index.js';

/**
 * Synthetic hull surge: catch check (negative), drive double-peak, finish dip, recovery.
 * Matches published boat-acceleration structure (Kleshnev / Holt).
 */
function synthHullStrokeSamples(spm, seconds, hz, { flipAxis = false } = {}) {
  const intervalMs = 60000 / spm;
  const samples = [];
  const n = Math.floor(seconds * hz);
  for (let i = 0; i < n; i++) {
    const t = i * (1000 / hz);
    const phase = (t % intervalMs) / intervalMs; // 0..1 within stroke
    let surge = 0;
    if (phase < 0.08) {
      // Catch / front reversal — deep negative check
      surge = -2.8 * Math.sin((phase / 0.08) * Math.PI);
    } else if (phase < 0.22) {
      // First drive peak (legs)
      const p = (phase - 0.08) / 0.14;
      surge = 1.6 * Math.sin(p * Math.PI);
    } else if (phase < 0.32) {
      // Mid-drive dip between double peaks
      surge = 0.25;
    } else if (phase < 0.55) {
      // Main drive / boat acceleration peak
      const p = (phase - 0.32) / 0.23;
      surge = 2.2 * Math.sin(p * Math.PI);
    } else if (phase < 0.62) {
      // Finish dip
      const p = (phase - 0.55) / 0.07;
      surge = -0.9 * Math.sin(p * Math.PI);
    } else {
      // Recovery — mild positive boat accel as rower slides
      const p = (phase - 0.62) / 0.38;
      surge = 0.7 * Math.sin(p * Math.PI);
    }
    if (flipAxis) surge = -surge;
    samples.push({
      t,
      motion: { ax: surge, ay: 0.05, az: 9.81 },
    });
  }
  return samples;
}

function expectSpm(label, samples, target, tol = 3) {
  const metrics = analyzeMotionWindow(samples);
  console.log(`${label}: ${metrics.strokeRate} spm (expect ~${target})`);
  if (
    metrics.strokeRate == null ||
    metrics.strokeRate < target - tol ||
    metrics.strokeRate > target + tol
  ) {
    console.error(`${label}: stroke rate out of expected range`);
    process.exit(1);
  }
}

// Old simplistic positive-only pulse (regression for simple waveform).
function synthLegacyPulse(spm, seconds, hz) {
  const intervalMs = 60000 / spm;
  const samples = [];
  const n = Math.floor(seconds * hz);
  for (let i = 0; i < n; i++) {
    const t = i * (1000 / hz);
    const phase = (t % intervalMs) / intervalMs;
    const surge = phase < 0.15 ? 2.5 : -0.2;
    samples.push({ t, motion: { ax: surge, ay: 0.1, az: 9.81 } });
  }
  return samples;
}

expectSpm('Hull pattern 24spm', synthHullStrokeSamples(24, 10, 25), 24);
expectSpm('Hull pattern 32spm', synthHullStrokeSamples(32, 10, 25), 32);
expectSpm(
  'Hull pattern flipped axis 24spm',
  synthHullStrokeSamples(24, 10, 25, { flipAxis: true }),
  24,
);
expectSpm('Legacy pulse 24spm', synthLegacyPulse(24, 8, 20), 24);

// Capsize uses a slow gravity EMA — hold inverted long enough for gz to flip.
const capsize = new MotionAnalyzer();
for (let i = 0; i < 80; i++) {
  capsize.process(i * 50, 0, 0, 9.81);
}
for (let i = 0; i < 120; i++) {
  capsize.process(4000 + i * 50, 0, 0, -9.5);
}
console.log('Capsize test (expect true):', capsize.getMetrics().capsize);
if (!capsize.getMetrics().capsize) {
  console.error('Capsize not detected');
  process.exit(1);
}

console.log('motion-analysis OK');
