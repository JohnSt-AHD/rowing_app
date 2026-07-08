/**
 * Vercel build: build PWA workspaces, then ensure ./dist exists at repo root
 * (Vercel outputDirectory is "dist").
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDist = path.join(root, 'apps', 'recorder-pwa', 'dist');
const coachDist = path.join(root, 'apps', 'coach-pwa', 'dist');
const rootDist = path.join(root, 'dist');

console.log('[vercel-build] root:', root);

execSync('node scripts/sync-brand-assets.mjs', {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

execSync('npm run build --workspace=recorder-pwa', {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

execSync('npm run build --workspace=coach-pwa', {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

if (!fs.existsSync(path.join(appDist, 'index.html'))) {
  console.error('[vercel-build] Missing', path.join(appDist, 'index.html'));
  process.exit(1);
}

if (!fs.existsSync(path.join(coachDist, 'index.html'))) {
  console.error('[vercel-build] Missing', path.join(coachDist, 'index.html'));
  process.exit(1);
}

fs.rmSync(rootDist, { recursive: true, force: true });
fs.cpSync(appDist, rootDist, { recursive: true });
fs.cpSync(coachDist, path.join(rootDist, 'manager'), { recursive: true });

const appApi = path.join(root, 'apps', 'recorder-pwa', 'api');
const rootApi = path.join(root, 'api');
if (fs.existsSync(appApi) && fs.existsSync(rootApi)) {
  fs.cpSync(appApi, rootApi, { recursive: true });
  console.log('[vercel-build] Synced apps/recorder-pwa/api → api/');
}

if (!fs.existsSync(path.join(rootDist, 'index.html'))) {
  console.error('[vercel-build] Failed to create dist/index.html');
  process.exit(1);
}

if (!fs.existsSync(path.join(rootDist, 'manager', 'index.html'))) {
  console.error('[vercel-build] Failed to create dist/manager/index.html');
  process.exit(1);
}

console.log('[vercel-build] OK — dist/index.html + dist/manager/index.html ready');
