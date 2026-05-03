# API Reference

## Overview

The Model Forge exposes a small JSON API under `/api`. The API powers authentication, recovery, saving, loading, and leaderboard features.

All responses are JSON. Validation is contract-first through the OpenAPI spec in `lib/api-spec/openapi.yaml`.

## Common conventions

- Base path: `/api`
- Success responses return typed JSON objects
- Validation failures return `400` with `code: "VALIDATION_ERROR"`
- Auth failures return `401` with `code: "INVALID_CREDENTIALS"`
- Rate limits return `429` with `code: "RATE_LIMITED"`
- Unexpected server errors return `500`

## Endpoints

### `GET /api/healthz`

Health check endpoint.

**Response**
```json
{ "status": "ok" }
```

### `GET /api/new-session`

Creates a new anonymous session ID.

**Response**
```json
{ "sessionId": "uuid" }
```

### `GET /api/load-state?session_id=...`

Loads saved game state for a session.

**Response**
```json
{
  "state": {},
  "isDefault": true
}
```

### `POST /api/save-state`

Saves the current game state.

**Body**
```json
{
  "sessionId": "uuid",
  "state": {}
}
```

**Response**
```json
{ "success": true }
```

### `POST /api/register`

Creates a new account.

**Body**
```json
{
  "username": "player1",
  "password": "secret"
}
```

**Response**
```json
{
  "sessionId": "uuid",
  "username": "player1",
  "isNewPlayer": true
}
```

### `POST /api/login`

Logs an existing player in.

**Body**
```json
{
  "username": "player1",
  "password": "secret"
}
```

**Response**
```json
{
  "sessionId": "uuid",
  "username": "player1",
  "isNewPlayer": false
}
```

### `GET /api/check-username?username=...`

Checks whether a username exists and returns basic progress info.

**Response**
```json
{
  "exists": true,
  "day": 14,
  "scenario": "default",
  "wins": 1,
  "status": "won"
}
```

### `POST /api/generate-recovery`

Generates a one-time recovery code after verifying the current password.

**Body**
```json
{
  "username": "player1",
  "password": "secret"
}
```

**Response**
```json
{ "recoveryCode": "FORGE-XXXX-XXXX-XXXX" }
```

### `POST /api/reset-password`

Resets a password using a recovery code.

**Body**
```json
{
  "username": "player1",
  "recoveryCode": "FORGE-XXXX-XXXX-XXXX",
  "newPassword": "newSecret"
}
```

**Response**
```json
{ "success": true }
```

### `GET /api/leaderboard`

Returns top winning runs.

**Response**
```json
{
  "entries": []
}
```

## Security notes

- Passwords are never returned by the API
- Recovery codes are only shown once
- Auth and recovery routes are rate-limited
- Leaderboard entries do not expose session identifiers
- CORS and security headers are enforced server-side

## Generated client code

API changes should be made in the OpenAPI spec first, then regenerated:

```bash
pnpm --filter @workspace/api-spec run codegen
```
