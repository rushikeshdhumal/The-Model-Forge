# Operations

## Purpose

This document covers day-to-day maintenance tasks for The Model Forge: keeping the app healthy, handling common incidents, and making safe updates.

## Running services

The platform uses Replit workflows:

- **API Server** — `artifacts/api-server: API Server`
- **Web app** — `artifacts/model-forge: web`
- **Mockup sandbox** — `artifacts/mockup-sandbox: Component Preview Server`

If you change server code or dependencies, restart the relevant workflow.

## Common workflows

### Update the API contract

1. Edit `lib/api-spec/openapi.yaml`
2. Regenerate code:

```bash
pnpm --filter @workspace/api-spec run codegen
```

3. Typecheck:

```bash
pnpm run typecheck
```

### Update the database schema

1. Edit `lib/db/src/schema/*`
2. Push schema changes:

```bash
pnpm --filter @workspace/db run push
```

3. If needed, backfill existing rows with a one-off SQL statement
4. Restart the API server if route code changed

### Update the web app

1. Edit `artifacts/model-forge`
2. Typecheck the app:

```bash
pnpm --filter @workspace/model-forge exec tsc --noEmit
```

3. Refresh the browser preview if needed

## Health checks

- Confirm the web preview loads
- Confirm `/api/healthz` returns `{ "status": "ok" }`
- Check the leaderboard and auth flows after backend changes
- Watch logs for validation errors or rate-limit spikes

## Common incidents

### Blank preview

- Check the workflow is running
- Restart the workflow after dependency or server changes
- Confirm the server reads `PORT`
- Check browser console for runtime errors

### API errors

- Confirm `DATABASE_URL` is set
- Confirm the database schema matches the code
- Re-run codegen if the contract changed
- Check logs for validation or database errors

### Stale generated types

- Re-run API codegen
- Rebuild TypeScript libraries with `pnpm run typecheck:libs`

### Rate limiting is too aggressive

- Confirm `trust proxy` is enabled on the API server
- Review limiter settings before adding new public routes
- Avoid making unauthenticated endpoints too broad

## Recovery and support

- Password recovery is self-service through one-time recovery codes
- If a user loses access, they can generate a new code from a logged-in session
- If the database is unavailable, restore connectivity before retrying writes

## Safe release checklist

- Typecheck passes
- API contract regenerated if changed
- Database migrations pushed
- Workflow restarted after server changes
- Preview smoke-tested in the browser

## Logging

- Use server logs for request failures and validation issues
- Avoid logging secrets, passwords, or recovery codes
- Keep error messages generic for auth and reset flows

## Notes

- Prefer small, incremental changes
- Keep generated files out of manual edits
- Use pnpm for all commands
