# Workspace

## Overview

pnpm workspace monorepo using TypeScript. This project is **The Model Forge** — a turn-based ML production simulator game.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Frontend**: React + Vite + Tailwind v4 + shadcn/ui + Recharts

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### The Model Forge (`artifacts/model-forge`)
- React + Vite web app at preview path `/`
- Port: `$PORT` (21751 in dev)
- Dark terminal theme (neon green, JetBrains Mono)
- Game: 14-day turn-based ML production simulator

### API Server (`artifacts/api-server`)
- Express 5 API at `/api`
- Port: 8080
- Routes: `/api/new-session`, `/api/load-state`, `/api/save-state`, `/api/leaderboard`

## Game Architecture

### Frontend (`artifacts/model-forge/src/`)
- `pages/Game.tsx` — main game UI (event system, metrics, modals, chart, leaderboard)
- `lib/game-engine.ts` — game logic: `applyChoiceAndAdvance`, `skipEventAndAdvance`, `getEventForDay`, `generatePostMortem`
- `lib/game-types.ts` — TypeScript types + `DEFAULT_STATE`
- `index.css` — dark neon-green terminal theme

### Backend (`artifacts/api-server/src/routes/session.ts`)
- Session persistence in PostgreSQL via `sessions` table
- GET `/api/new-session` — creates UUID session ID
- GET `/api/load-state?session_id=X` — returns saved state or DEFAULT_STATE
- POST `/api/save-state` — upserts state to DB
- GET `/api/leaderboard` — returns top 10 won sessions

### DB Schema (`lib/db/src/schema/sessions.ts`)
- `sessions` table: `sessionId`, `state` (jsonb), `scenario`, `day`, `status`, `wins`, `createdAt`, `updatedAt`

### OpenAPI Spec (`lib/api-spec/openapi.yaml`)
- Contract-first: spec → codegen → React Query hooks + Zod validators
- Codegen fix: `lib/api-spec/package.json` overwrites `lib/api-zod/src/index.ts` post-codegen

## Game Design

**Win condition**: Survive 14 days without any metric hitting 0
**Loss conditions**: Precision ≤ 0, Recall ≤ 0, SLA Adherence ≤ 0, Feature Staleness > 48h, Inference Cost ≥ 100

**Metrics** (6 total):
1. Precision (starts 85%)
2. Recall (starts 80%)
3. SLA Adherence (starts 99%)
4. Feature Staleness (starts 2h, lose if >48h)
5. Inference Cost (starts 10, lose if ≥100)
6. Skew Alert (Low/Medium/High)

**Passive decay per day**: Precision −1%, Recall −1%, SLA −0.5%
**Mitigations**: Feature Store (stops staleness growth), CI/CD auto-retrain (+2% precision/day)

**Scenarios** (11): default, zillow, tay, amazon, uber, netflix, tesla, twitter, facebook, google, stripe
**User levels**: Intern (basic), ML Engineer (+ model registry), MLOps Lead (+ infrastructure + time travel debugger)

**Event pool**: 8 random events + scenario-specific events + triggered events (low precision, stale features, SLA breach)
**Future Effects**: some choices schedule delayed metric changes on future days
