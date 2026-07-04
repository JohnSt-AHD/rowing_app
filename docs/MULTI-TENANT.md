# Multi-tenant clubs (Option B)

One Vercel deployment, separate fleets per rowing club. Each club has its own **ingest token**; the API scopes all data by org.

## How it works

```
Phone / Manager (token A)  ──►  resolve org "club-a"  ──►  only club-a devices & history
Phone / Manager (token B)  ──►  resolve org "club-b"  ──►  only club-b devices & history
```

- Same **Ingest API URL** for everyone: `https://your-app.vercel.app/api/ingest`
- Different **Ingest token** per club in recorder + CrewSight Manager Settings
- Device IDs (`H6`, `CREW-01`) only need to be unique **within** a club

## Setup on Vercel

### Existing single-club deploy (migration)

If you already use `INGEST_TOKEN`:

1. Deploy this version.
2. On first request, the API creates org `default` with your existing `INGEST_TOKEN`.
3. Existing Postgres rows are assigned to `default`.
4. No phone changes if they already use that token.

### Multiple clubs — env bootstrap

Set **ORG_TOKENS** on Vercel (JSON object: slug → plain token):

```json
{
  "default": "your-existing-rnz-token",
  "karapiro": "karapiro-secret-token-here",
  "auckland": "auckland-secret-token-here"
}
```

Redeploy after changing env vars.

Optional: **ORG_TOKEN_PEPPER** — extra salt for token hashing (defaults to built-in pepper).

Legacy **INGEST_TOKEN** still works for org `default` during transition.

### Add a club later (Postgres CLI)

```bash
POSTGRES_URL=... node scripts/create-org.mjs \
  --slug waikato \
  --name "Waikato RC" \
  --token "long-random-secret"
```

Share the token only with that club’s coaches and devices.

## Club onboarding checklist

| Step | Who |
|------|-----|
| Create org + token | RNZ admin |
| Recorder Settings → Ingest token | Each phone in the club |
| CrewSight Manager Settings → Ingest token | Coaches |
| Device ID per boat | Unique within club only |

## Security

- Tokens are stored **hashed** in `rnz_orgs` (SHA-256 with pepper).
- Deletes, history, geofences, and live fleet are all scoped by org.
- **Delete all** in the dashboard only clears **that org’s** data.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 on Manager | Token must match one org in `rnz_orgs` / `ORG_TOKENS` |
| See another club’s boats | Wrong token on device or Manager — tokens must not be shared across clubs |
| Empty fleet after deploy | Redeploy after setting `ORG_TOKENS`; confirm Postgres connected |
