# Database

## Overview

The Model Forge uses PostgreSQL with Drizzle. The database stores player accounts, password recovery metadata, and saved game sessions.

## Tables

### `players`

Stores account identity and credential data.

Columns:

- `username` — primary key
- `password_hash` — bcrypt hash of the login password
- `session_id` — current account-linked session
- `recovery_hash` — bcrypt hash of the latest one-time recovery code
- `created_at` — account creation time

Indexes:

- primary key on `username`
- index on `session_id` for joins and lookup flows

### `sessions`

Stores save data and leaderboard fields.

Columns:

- `session_id` — primary key
- `state` — full game save blob in JSONB
- `scenario` — scenario name
- `day` — current day reached
- `status` — game status such as `playing` or `won`
- `wins` — win counter
- `score` — denormalized leaderboard score
- `updated_at` — last save time
- `created_at` — session creation time

Indexes:

- primary key on `session_id`
- composite index on `(status, score, day)` for leaderboard reads

## Access patterns

### Registration

New accounts insert into `players` and create a matching session row in `sessions`.

### Login

Login reads only `password_hash`, `session_id`, and `username` from `players`.

### Username lookup

Username lookup uses a join between `players` and `sessions` so the app can show progress info with one query.

### Save state

Saving writes the full JSONB game state and denormalized leaderboard fields (`scenario`, `day`, `status`, `wins`, `score`).

### Load state

Loading reads the saved JSONB blob for the requested session.

### Leaderboard

Leaderboard reads use the `score` column and composite index so PostgreSQL can return top runs efficiently without extracting ranking fields from JSONB at read time.

## Migrations

Schema changes are applied with Drizzle:

```bash
pnpm --filter @workspace/db run push
```

If a schema change needs to be forced:

```bash
pnpm --filter @workspace/db run push-force
```

## Query guidance

- Select only the columns you need
- Prefer joins over multiple sequential lookups
- Avoid reading the full JSONB state unless the UI needs it
- Keep leaderboard ranking fields denormalized in columns when possible

## Notes

- `recovery_hash` is always one-way hashed and should never be logged
- `score` is stored separately from the JSONB state for performance
- Any new public data path should be reviewed for indexes and column selection
