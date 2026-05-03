# Security

## Overview

The Model Forge uses layered defenses to protect user accounts, saved game data, and the API surface.

## Authentication

- Passwords are hashed with bcrypt before storage
- Login, registration, and password recovery are rate-limited
- Auth failures return generic messages to reduce account enumeration
- Username lookup is restricted and rate-limited

## Password recovery

- Recovery codes are one-time use
- Recovery codes are stored as bcrypt hashes, never plaintext
- Generating a new recovery code invalidates the previous one
- Reset flows require both username and recovery code

## API hardening

- Helmet adds security headers
- CORS is restricted to the app origin
- Request bodies are size-limited
- The API trusts one reverse-proxy hop so client IPs can be rate-limited correctly

## Database protection

- Sensitive identifiers are not exposed in leaderboard responses
- Common access paths use indexes
- Queries fetch only the columns they need
- Large JSONB fields are avoided when possible

## Abuse prevention

- Server-side rate limiters protect auth and read/write endpoints
- Client-side lockout feedback helps users avoid repeated failed attempts
- Recovery generation is limited so valid accounts cannot be abused to rotate codes repeatedly

## Operational notes

- Keep `DATABASE_URL` and `SESSION_SECRET` private
- Regenerate API types after contract changes
- Review new routes for input validation and data exposure before release

## Remaining best practices

No system is perfectly secure. For future changes:

- prefer least-privilege data access
- avoid exposing internal IDs in API responses
- add rate limits to any new public endpoint
- keep sensitive data out of logs
- validate all user input at the API boundary
