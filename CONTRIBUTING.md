# Contributing

## Overview

Thanks for contributing to The Model Forge. This repo is a pnpm monorepo with a contract-first API and shared database code.

## Getting started

### Install dependencies

```bash
pnpm install
```

### Run typechecks

```bash
pnpm run typecheck
```

### Build the workspace

```bash
pnpm run build
```

## Project structure

- `artifacts/model-forge` — web game
- `artifacts/api-server` — backend API
- `lib/db` — database schema and access
- `lib/api-spec` — OpenAPI source of truth and codegen
- `lib/api-zod` / `lib/api-client-react` — generated outputs

## Working on changes

### Web app changes

- Edit code in `artifacts/model-forge`
- Typecheck with:

```bash
pnpm --filter @workspace/model-forge exec tsc --noEmit
```

### API changes

- Update the OpenAPI spec first
- Regenerate shared code:

```bash
pnpm --filter @workspace/api-spec run codegen
```

- Typecheck the API server:

```bash
pnpm --filter @workspace/api-server exec tsc --noEmit
```

### Database changes

- Edit schema files in `lib/db/src/schema`
- Push schema changes:

```bash
pnpm --filter @workspace/db run push
```

- If needed, backfill existing rows with SQL after schema updates

## Guidelines

- Use pnpm only
- Do not edit generated files by hand
- Keep API changes contract-first
- Avoid exposing secrets, tokens, or recovery codes in logs
- Prefer small, focused changes

## Pull request checklist

- Typecheck passes
- Generated code is up to date
- Database migrations are applied if needed
- UI changes are verified in the browser preview
- Backend changes are restarted and smoke-tested

## Security

- Never commit secrets or environment values
- Use the existing auth, recovery, and rate-limit patterns for new routes
- Validate all inputs at the API boundary

## Notes

If you add new docs, keep them short, direct, and linked from the root README when relevant.
