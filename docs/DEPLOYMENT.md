# Deployment

## Overview

The Model Forge runs as a pnpm monorepo with a web app, an API server, and shared libraries. Deployment is handled through the existing Replit workflows and path-based routing.

## Required environment variables

### Shared

- `DATABASE_URL` — PostgreSQL connection string
- `SESSION_SECRET` — shared secret used for session-related features

### API server

- `PORT` — runtime port assigned by the platform

## Services

### Web app

- Package: `artifacts/model-forge`
- Dev command: `pnpm --filter @workspace/model-forge run dev`
- Build command: `pnpm --filter @workspace/model-forge run build`

### API server

- Package: `artifacts/api-server`
- Dev command: `pnpm --filter @workspace/api-server run dev`
- Build command: `pnpm --filter @workspace/api-server run build`

## Deployment flow

1. Ensure `DATABASE_URL` is configured.
2. Update the OpenAPI contract if the API changes.
3. Regenerate shared API code:

```bash
pnpm --filter @workspace/api-spec run codegen
```

4. Run type checks:

```bash
pnpm run typecheck
```

5. Build the workspace:

```bash
pnpm run build
```

## Database setup

Database schema changes are applied through Drizzle.

To push schema updates:

```bash
pnpm --filter @workspace/db run push
```

If you need to force-apply schema changes:

```bash
pnpm --filter @workspace/db run push-force
```

## Runtime expectations

- The API server must read `PORT` from the environment
- The web app should be served through the Replit workflow, not a root-level dev script
- All requests to backend routes should use the `/api` prefix
- The app relies on PostgreSQL being reachable via `DATABASE_URL`

## Production checklist

- Confirm the database schema is current
- Confirm generated API clients are up to date
- Confirm security headers and rate limits are enabled
- Confirm no secrets are committed to source control
- Confirm the preview or deployed app loads without console errors

## Troubleshooting

### Blank preview

- Check that the web workflow is running
- Confirm the server is binding to the provided `PORT`
- Restart the workflow after dependency or server changes

### API errors

- Check `DATABASE_URL`
- Re-run schema push if the database is out of date
- Re-run codegen if the API contract changed

### Type errors

- Rebuild generated code
- Run `pnpm run typecheck`

## Notes

- Use pnpm for all commands
- Do not edit generated API files by hand
- Prefer contract-first API changes
- Keep deployment changes in sync with the OpenAPI spec and database schema
