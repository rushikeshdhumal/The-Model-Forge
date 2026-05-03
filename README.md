# The Model Forge

The Model Forge is a turn-based ML production simulator game. You play through 14 in-game days of incidents, make operational decisions, protect model quality, and try to finish with the best possible outcome.

## Platform overview

This repository is a pnpm monorepo with three main parts:

- **`artifacts/model-forge`** — the web game
- **`artifacts/api-server`** — the API server
- **`lib/*`** — shared libraries for database, API contracts, and generated client types

## Core features

- Turn-based ML operations gameplay
- Login / registration with password auth
- Guest play with optional account migration
- Password recovery using one-time recovery codes
- Username lookup during sign-in
- Save/load of game state
- Public leaderboard
- Recovery and reset flows without email

## Security and privacy

- Passwords are hashed before storage
- Recovery codes are stored as one-way hashes and are single-use
- Auth endpoints use rate limiting
- CORS is restricted to the app origin
- Helmet security headers are enabled
- Sensitive leaderboard identifiers are not exposed
- Request bodies are size-limited to reduce abuse

## Database

The app uses PostgreSQL with Drizzle.

Key tables:

- **`players`** — account credentials and session linkage
- **`sessions`** — saved game state and leaderboard data

The database layer includes indexes for common access patterns such as leaderboard reads and username/session lookups.

## Monorepo structure

```text
artifacts/
  api-server/
  model-forge/
  mockup-sandbox/
lib/
  api-client-react/
  api-spec/
  api-zod/
  db/
```

## Development

### Install

```bash
pnpm install
```

### Typecheck

```bash
pnpm run typecheck
```

### Build

```bash
pnpm run build
```

### App workflows

- **API Server**: `pnpm --filter @workspace/api-server run dev`
- **Web app**: `pnpm --filter @workspace/model-forge run dev`

## API and codegen

The API is contract-first:

1. Update the OpenAPI spec in `lib/api-spec/openapi.yaml`
2. Run codegen:

```bash
pnpm --filter @workspace/api-spec run codegen
```

This regenerates the shared Zod schemas and React Query hooks.

## Environment

Required environment variables:

- `DATABASE_URL`
- `PORT` for the API server runtime

A shared `SESSION_SECRET` secret is available for session-related work if needed.

## Notes

- Use pnpm for all package management.
- The API server reads from the shared database and serves the game under the `/api` path.
- The leaderboard and auth flows have been optimized to minimize database round-trips and payload size.
