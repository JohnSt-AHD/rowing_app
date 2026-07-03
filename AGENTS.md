# AGENTS.md

## Cursor Cloud specific instructions

CrewSight is a Node **npm-workspaces monorepo** (a GPS rowing recorder PWA + coach PWA + Vercel serverless APIs + Capacitor native shells). `engines.node` is `20.x`; the cloud VM ships Node 22, which builds and runs the web apps fine.

Dependencies are installed by the startup update script (`npm install` at the repo root installs every workspace). See `README.md` and `docs/TESTING.md` for standard usage.

### Running the web apps (headless VM)
- Recorder PWA: `npm run dev` → http://localhost:5173
- Coach PWA: `npm run dev:coach` → http://localhost:5185
- Both Vite servers proxy `/api/*` → `http://localhost:3000` (see `apps/recorder-pwa/vite.config.ts`).
- Build: `npm run build` (builds recorder PWA and syncs `apps/recorder-pwa/api` → root `api/`). CI (`.github/workflows/ci.yml`) is just `npm ci` + `npm run build` + a `node -e "require(...)"` API-module load check.

### Backend API gotcha (important)
- The API lives in `apps/recorder-pwa/api/*.js` as **Vercel-style handlers** (`module.exports = (req, res) => ...` using `res.status().json()`, `req.query`, `req.body`).
- `npx vercel dev` requires Vercel credentials (`vercel login`/`--token`) which are **not available** in the cloud VM, so it cannot start the API here.
- To exercise `/api/*` locally without Vercel, run a tiny Node http harness that adds the `res.status/json` + `req.query/body` helpers and routes `/api/<name>` to `require('apps/recorder-pwa/api/<name>.js')`, listening on port 3000 (the Vite proxy target).
- No `POSTGRES_URL` is required: `api/lib/ingest-store.js` falls back to an in-memory store (responses report `persisted:false`, `storage:"memory"`). Postgres-only features (history, cross-instance device list) stay empty without a DB.
- Manual end-to-end check: open `/test.html` (Ping → Test ingest → List devices → GPS positions), then `/dashboard.html` to see the device on the fleet monitor.

### Lint / test / typecheck
- No ESLint/Prettier and no test framework are configured.
- `tsconfig.json` is strict but currently produces **pre-existing** `tsc --noEmit` errors in `apps/recorder-pwa` and `apps/coach-pwa`; the Vite/esbuild build does not typecheck and is unaffected. Do not treat `tsc --noEmit` as a passing gate.
- Ad-hoc smoke scripts: `node scripts/test-session-resume.mjs`, `node scripts/test-motion-analysis.js`.

### Skip on Linux
- Native targets (`native:android`, `native:ios`, `native:apk`, `coach:sync`) need Android Studio / Xcode / PowerShell — not runnable here.
- Real GPS / Web Bluetooth HR require device hardware; the app UI still loads and records can be simulated via the ingest API.
