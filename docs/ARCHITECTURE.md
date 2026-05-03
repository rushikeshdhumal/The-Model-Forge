# Architecture

## Overview

The Model Forge is a turn-based ML production simulator built as a pnpm monorepo. It is split into a web client, an API server, shared database code, and generated API contracts.

## System layout

```text
artifacts/
  model-forge/      # React + Vite web game
  api-server/       # Express API
  mockup-sandbox/   # Design/component preview
lib/
  db/               # Drizzle schema + database access
  api-spec/         # OpenAPI source of truth + codegen
  api-zod/          # Generated Zod schemas
  api-client-react/  # Generated React Query hooks
```

## Request flow

1. The browser loads the game from `artifacts/model-forge`.
2. UI actions call generated React Query hooks from `lib/api-client-react`.
3. Hooks hit the Express API server under `/api`.
4. The API validates payloads with generated Zod schemas from `lib/api-zod`.
5. The API reads/writes PostgreSQL through Drizzle in `lib/db`.

## Core services

### Web app

- React + Vite
- Handles gameplay, dialogs, auth UI, save/load UI, and leaderboard display
- Uses generated hooks for all API calls

### API server

- Express + pino logging
- Auth, recovery, save-state, leaderboard, and session routes
- Security middleware includes CORS restrictions, Helmet, request body limits, and rate limiting

### Database

- PostgreSQL
- Tables:
  - `players` for credentials and account recovery metadata
  - `sessions` for game state and leaderboard data
- Indexed for username lookup, session join lookups, and leaderboard reads

## Data model

### `players`

- `username` primary key
- `password_hash`
- `session_id`
- `recovery_hash`
- `created_at`

### `sessions`

- `session_id` primary key
- `state` JSONB save blob
- `scenario`, `day`, `status`, `wins`
- `score` denormalized for leaderboard performance
- `updated_at`, `created_at`

## Generated artifacts

The API contract is maintained in `lib/api-spec/openapi.yaml` and generates:

- `lib/api-zod/src/generated/api.ts`
- `lib/api-client-react/src/generated/api.ts`

Do not edit generated files by hand.

## Environment and routing

- API server reads `PORT`
- Database reads `DATABASE_URL`
- The app is served through Replit’s path-based routing and shared reverse proxy
- API requests should use `/api/*`

## Performance notes

- Database queries fetch only needed columns
- Username lookup uses a single JOIN
- Leaderboard reads use a dedicated `score` column and composite index
- Save-state writes denormalize leaderboard fields at write time

## Security notes

- Passwords are bcrypt-hashed
- Recovery codes are one-time and stored hashed
- Auth endpoints are rate-limited
- CORS is restricted
- Helmet adds standard security headers
- Leaderboard no longer exposes session identifiers
