# Deployment

## Overview

The Model Forge is a full-stack application built as a pnpm monorepo with three main components:

- **Web app** (`artifacts/model-forge`) - React + Vite frontend
- **API server** (`artifacts/api-server`) - Express backend
- **Database** (`lib/db`) - PostgreSQL with Drizzle ORM

This document covers platform-agnostic deployment requirements. For platform-specific guides, see:

- **[Render Deployment Guide](./DEPLOYMENT-RENDER.md)** - Free tier deployment (recommended)
- **Replit** - Original deployment platform (deprecated)

## Architecture

```
┌─────────────┐
│   Browser   │
└──────┬──────┘
       │ HTTPS
       ▼
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Frontend   │─────▶│ API Server  │─────▶│  PostgreSQL │
│ Static Site │ /api │   Express   │ SQL  │  Database   │
└─────────────┘      └─────────────┘      └─────────────┘
```

## Required Environment Variables

### API Server

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NODE_ENV` | Yes | Runtime environment | `production` |
| `PORT` | Yes | Server port | `10000` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `SESSION_SECRET` | Yes | Secret for session signing (32+ chars) | Random string |
| `ALLOWED_ORIGINS` | Yes | CORS allowed origins (comma-separated) | `https://app.example.com` |

### Frontend

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NODE_ENV` | Yes | Build environment | `production` |
| `PORT` | Build only | Dev server port | `3000` |
| `BASE_PATH` | Yes | Application base path | `/` |
| `VITE_API_URL` | Yes | API server URL | `https://api.example.com` |

## Build Commands

### Full Workspace Build

```bash
# Install dependencies
pnpm install

# Type check all packages
pnpm run typecheck

# Build all packages
pnpm run build
```

### Individual Package Builds

```bash
# Build API server
pnpm --filter @workspace/api-server run build

# Build frontend
pnpm --filter @workspace/model-forge run build

# Generate API client code (if OpenAPI spec changed)
pnpm --filter @workspace/api-spec run codegen
```

## Database Setup

### Initialize Schema

```bash
# Push schema to database
pnpm --filter @workspace/db run push

# Force push (drops existing tables)
pnpm --filter @workspace/db run push-force
```

### Connection Requirements

- PostgreSQL 12 or higher
- Connection string format: `postgresql://user:password@host:port/database`
- Recommended: Connection pooling enabled
- Minimum: 1 GB storage for free tier

## Deployment Checklist

Before deploying to production:

- [ ] All environment variables are configured
- [ ] Database is provisioned and accessible
- [ ] Database schema is initialized (`pnpm --filter @workspace/db run push`)
- [ ] API client code is up to date (`pnpm --filter @workspace/api-spec run codegen`)
- [ ] Type checks pass (`pnpm run typecheck`)
- [ ] Build succeeds (`pnpm run build`)
- [ ] `SESSION_SECRET` is randomly generated (32+ characters)
- [ ] `ALLOWED_ORIGINS` is set to frontend URL only
- [ ] CORS configuration matches frontend domain
- [ ] Security headers are enabled (Helmet)
- [ ] Rate limiting is configured
- [ ] No secrets are committed to source control

## Runtime Requirements

### API Server

- Node.js 18 or higher
- Reads `PORT` from environment
- Serves API endpoints under `/api` prefix
- Health check endpoint: `/api/health`
- Requires PostgreSQL connection via `DATABASE_URL`

### Frontend

- Static files served from `artifacts/model-forge/dist/public`
- SPA routing: All routes should serve `index.html`
- API requests proxied to backend or configured via `VITE_API_URL`
- Requires `BASE_PATH` for proper asset loading

### Database

- PostgreSQL 12+
- Tables: `players`, `sessions`
- Indexes for username lookup, session joins, leaderboard queries
- Connection pooling recommended (max 10 connections)

## Development Workflow

### Local Development

```bash
# Terminal 1: Start API server
pnpm --filter @workspace/api-server run dev

# Terminal 2: Start frontend
pnpm --filter @workspace/model-forge run dev
```

### API Contract Changes

When updating the API:

1. Update `lib/api-spec/openapi.yaml`
2. Regenerate client code:
   ```bash
   pnpm --filter @workspace/api-spec run codegen
   ```
3. Update API server implementation
4. Update frontend to use new endpoints/types

## Deployment Strategies

### Option 1: Separate Services (Recommended)

Deploy frontend and backend as separate services:

- **Frontend**: Static site hosting (Vercel, Netlify, Render)
- **Backend**: Web service (Render, Railway, Fly.io)
- **Database**: Managed PostgreSQL (Render, Supabase, Neon)

**Pros**: Better scaling, independent deployments, CDN for frontend
**Cons**: More configuration, CORS setup required

### Option 2: Monolithic Deployment

Deploy as single service with backend serving frontend:

- Backend serves static files from `artifacts/model-forge/dist/public`
- Single deployment unit
- Simpler CORS configuration

**Pros**: Simpler setup, single deployment
**Cons**: Less flexible scaling, no CDN benefits

### Option 3: Serverless

Deploy backend as serverless functions:

- **Frontend**: Static hosting
- **Backend**: Serverless functions (Vercel, Netlify Functions)
- **Database**: Serverless PostgreSQL (Neon, Supabase)

**Pros**: Auto-scaling, pay-per-use
**Cons**: Cold starts, connection pooling challenges

## Platform-Specific Guides

### Render (Recommended for Free Tier)

See **[DEPLOYMENT-RENDER.md](./DEPLOYMENT-RENDER.md)** for complete guide.

**Pros**:
- Free tier available
- Easy monorepo support
- Managed PostgreSQL
- Auto-deploy from GitHub
- Blueprint (IaC) support

**Cons**:
- Free tier sleeps after 15 min inactivity
- Database free for 90 days only

### Alternative Platforms

#### Railway

- $5 free credit monthly
- Integrated PostgreSQL
- Simple monorepo deployment
- Good for small apps

#### Vercel + Supabase

- Vercel: Free frontend + serverless API
- Supabase: Free PostgreSQL (500MB)
- Requires API restructuring for serverless

#### Fly.io

- Free tier: 3 VMs, 3GB storage
- PostgreSQL included
- Docker-based deployment
- More technical setup

## Monitoring and Maintenance

### Health Checks

- API health endpoint: `GET /api/health`
- Returns 200 OK when healthy
- Checks database connectivity

### Logging

- API uses Pino for structured logging
- Log levels: error, warn, info, debug
- Production: info level recommended

### Metrics to Monitor

- API response times
- Database connection pool usage
- Error rates
- Memory usage
- CPU usage
- Request rate

### Backup Strategy

- Database: Daily automated backups
- Code: Version controlled in Git
- Environment variables: Documented securely

## Security Considerations

### Authentication

- Passwords hashed with bcrypt
- Recovery codes stored as one-way hashes
- Single-use recovery codes

### API Security

- CORS restricted to frontend origin
- Helmet security headers enabled
- Rate limiting on auth endpoints
- Request body size limits
- Input validation with Zod schemas

### Database Security

- Connection string in environment variable
- No credentials in code
- Prepared statements (SQL injection protection)
- Minimal permissions for app user

## Troubleshooting

### Build Failures

**Issue**: pnpm not found

**Solution**: Ensure pnpm is installed globally or use `npm install -g pnpm`

**Issue**: Type errors during build

**Solution**: 
1. Regenerate API client: `pnpm --filter @workspace/api-spec run codegen`
2. Run type check: `pnpm run typecheck`

### Runtime Errors

**Issue**: Database connection failed

**Solution**:
1. Verify `DATABASE_URL` is correct
2. Check database is running and accessible
3. Verify network connectivity

**Issue**: CORS errors in browser

**Solution**:
1. Verify `ALLOWED_ORIGINS` includes frontend URL
2. Check frontend is using correct API URL
3. Ensure no trailing slashes in URLs

**Issue**: 404 on frontend routes

**Solution**:
1. Configure SPA fallback to serve `index.html`
2. Verify `BASE_PATH` is set correctly

## Performance Optimization

### Frontend

- Static assets served via CDN
- Code splitting enabled (Vite default)
- Asset compression (gzip/brotli)
- Cache headers configured

### Backend

- Database connection pooling
- Query optimization with indexes
- Response compression
- Rate limiting to prevent abuse

### Database

- Indexes on frequently queried columns
- Denormalized leaderboard score
- Connection pool size tuned for workload

## Scaling Considerations

### Horizontal Scaling

- Frontend: Automatic via CDN
- Backend: Add more instances behind load balancer
- Database: Read replicas for read-heavy workloads

### Vertical Scaling

- Increase memory/CPU for API server
- Upgrade database tier for more storage/connections

### Caching

- Consider Redis for session storage
- Cache leaderboard queries
- CDN caching for static assets

## Support

For platform-specific issues, refer to:

- [Render Documentation](https://render.com/docs)
- [Railway Documentation](https://docs.railway.app)
- [Vercel Documentation](https://vercel.com/docs)
- [Fly.io Documentation](https://fly.io/docs)

For application issues:

- Check logs for error details
- Review [ARCHITECTURE.md](./ARCHITECTURE.md) for system design
- Review [API.md](./API.md) for endpoint documentation
- Review [SECURITY.md](./SECURITY.md) for security model
