# Deployment Guide: Render

This guide provides step-by-step instructions for deploying The Model Forge to Render's free tier.

## Overview

The Model Forge will be deployed as three separate Render services:

1. **PostgreSQL Database** - Free tier (90-day trial, then $7/month)
2. **API Server** - Web Service on free tier
3. **Frontend** - Static Site on free tier

**Total Cost**: Free for 90 days, then $7/month for database only

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Render Platform                       │
│                                                          │
│  ┌──────────────┐      ┌──────────────┐                │
│  │   Frontend   │      │  API Server  │                │
│  │ Static Site  │─────▶│ Web Service  │                │
│  │ (React/Vite) │      │  (Express)   │                │
│  └──────────────┘      └──────┬───────┘                │
│                               │                          │
│                               ▼                          │
│                        ┌──────────────┐                 │
│                        │  PostgreSQL  │                 │
│                        │   Database   │                 │
│                        └──────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

## Prerequisites

- GitHub account
- Render account (sign up at https://render.com)
- Git repository with The Model Forge code

## Deployment Methods

### Method 1: Blueprint (Recommended)

Using the `render.yaml` blueprint file for automated setup.

#### Step 1: Push Code to GitHub

```bash
# Initialize git if not already done
git init
git add .
git commit -m "Initial commit"

# Add remote and push
git remote add origin https://github.com/YOUR-USERNAME/the-model-forge.git
git branch -M main
git push -u origin main
```

#### Step 2: Deploy via Render Dashboard

1. Log in to [Render Dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Blueprint"**
3. Connect your GitHub repository
4. Select the repository containing The Model Forge
5. Render will detect `render.yaml` automatically
6. Review the services to be created:
   - `model-forge-db` (PostgreSQL)
   - `model-forge-api` (Web Service)
   - `model-forge` (Static Site)
7. Click **"Apply"**

#### Step 3: Configure Environment Variables

After blueprint deployment, update the frontend service:

1. Go to `model-forge` (frontend) service
2. Navigate to **Environment** tab
3. Add environment variable:
   - Key: `VITE_API_URL`
   - Value: `https://model-forge-api.onrender.com`
4. Click **"Save Changes"**

The API service will automatically receive:
- `DATABASE_URL` (from database connection)
- `SESSION_SECRET` (auto-generated)
- `PORT` (set to 10000)

#### Step 4: Update CORS Configuration

1. Go to `model-forge-api` service
2. Navigate to **Environment** tab
3. Update `ALLOWED_ORIGINS`:
   - Value: `https://model-forge.onrender.com`
4. Click **"Save Changes"**

#### Step 5: Initialize Database Schema

After the API service is deployed:

1. Go to `model-forge-api` service
2. Click **"Shell"** tab
3. Run database migration:
   ```bash
   pnpm --filter @workspace/db run push
   ```

### Method 2: Manual Setup

If you prefer manual configuration or need more control.

#### Step 1: Create PostgreSQL Database

1. In Render Dashboard, click **"New +"** → **"PostgreSQL"**
2. Configure:
   - **Name**: `model-forge-db`
   - **Database**: `modelforge`
   - **User**: `modelforge`
   - **Region**: Oregon (or closest to you)
   - **Plan**: Free
3. Click **"Create Database"**
4. Wait for provisioning (2-3 minutes)
5. Copy the **Internal Database URL** (starts with `postgresql://`)

#### Step 2: Deploy API Server

1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub repository
3. Configure:
   - **Name**: `model-forge-api`
   - **Region**: Oregon (same as database)
   - **Branch**: `main`
   - **Root Directory**: Leave empty (monorepo root)
   - **Runtime**: Node
   - **Build Command**: `pnpm install && pnpm run build`
   - **Start Command**: `pnpm --filter @workspace/api-server run start`
   - **Plan**: Free
4. Add Environment Variables:
   - `NODE_ENV` = `production`
   - `PORT` = `10000`
   - `DATABASE_URL` = (paste Internal Database URL from Step 1)
   - `SESSION_SECRET` = (generate random 32+ character string)
   - `ALLOWED_ORIGINS` = `https://model-forge.onrender.com` (update after frontend deployment)
5. Advanced Settings:
   - **Health Check Path**: `/api/health`
   - **Auto-Deploy**: Yes
6. Click **"Create Web Service"**
7. Wait for build and deployment (5-10 minutes)

#### Step 3: Initialize Database Schema

1. Once API service is running, click **"Shell"** tab
2. Run:
   ```bash
   pnpm --filter @workspace/db run push
   ```
3. Verify success message

#### Step 4: Deploy Frontend

1. Click **"New +"** → **"Static Site"**
2. Connect your GitHub repository
3. Configure:
   - **Name**: `model-forge`
   - **Region**: Oregon
   - **Branch**: `main`
   - **Root Directory**: Leave empty
   - **Build Command**: `pnpm install && pnpm --filter @workspace/model-forge run build`
   - **Publish Directory**: `artifacts/model-forge/dist/public`
4. Add Environment Variables:
   - `NODE_ENV` = `production`
   - `PORT` = `3000`
   - `BASE_PATH` = `/`
   - `VITE_API_URL` = `https://model-forge-api.onrender.com`
5. Advanced Settings:
   - **Auto-Deploy**: Yes
6. Click **"Create Static Site"**
7. Wait for build and deployment (5-10 minutes)

#### Step 5: Update API CORS

Now that you have the frontend URL:

1. Go back to `model-forge-api` service
2. Navigate to **Environment** tab
3. Update `ALLOWED_ORIGINS` to: `https://model-forge.onrender.com`
4. Click **"Save Changes"** (triggers redeploy)

## Post-Deployment Configuration

### Configure Custom Domain (Optional)

For each service:

1. Go to service settings
2. Navigate to **Custom Domains** tab
3. Click **"Add Custom Domain"**
4. Follow DNS configuration instructions

### Enable Auto-Deploy

Ensure auto-deploy is enabled for continuous deployment:

1. Go to each service
2. Navigate to **Settings** tab
3. Under **Build & Deploy**, ensure **"Auto-Deploy"** is **Yes**

### Set Up Notifications (Optional)

1. Go to **Account Settings** → **Notifications**
2. Configure email or Slack notifications for:
   - Deploy failures
   - Service health issues

## Environment Variables Reference

### API Server (`model-forge-api`)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NODE_ENV` | Yes | Runtime environment | `production` |
| `PORT` | Yes | Server port | `10000` |
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgresql://user:pass@host/db` |
| `SESSION_SECRET` | Yes | Secret for session signing | Random 32+ char string |
| `ALLOWED_ORIGINS` | Yes | CORS allowed origins | `https://model-forge.onrender.com` |

### Frontend (`model-forge`)

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NODE_ENV` | Yes | Build environment | `production` |
| `PORT` | Yes | Dev server port (build only) | `3000` |
| `BASE_PATH` | Yes | Application base path | `/` |
| `VITE_API_URL` | Yes | API server URL | `https://model-forge-api.onrender.com` |

## Monitoring and Maintenance

### View Logs

1. Go to service in Render Dashboard
2. Click **"Logs"** tab
3. View real-time logs or filter by time range

### Monitor Service Health

1. Go to service in Render Dashboard
2. View **"Metrics"** tab for:
   - CPU usage
   - Memory usage
   - Request rate
   - Response times

### Database Management

1. Go to `model-forge-db` in Dashboard
2. Click **"Connect"** for connection details
3. Use tools like pgAdmin or psql to connect:
   ```bash
   psql postgresql://user:pass@host/db
   ```

### Backup Database

Render automatically backs up free tier databases, but you can create manual backups:

1. Go to database service
2. Click **"Backups"** tab
3. Click **"Create Backup"**

## Troubleshooting

### Build Failures

**Issue**: Build fails with "pnpm: command not found"

**Solution**: Render should auto-detect pnpm from `package.json`. If not:
1. Add to build command: `npm install -g pnpm && pnpm install && pnpm run build`

**Issue**: Build fails with dependency errors

**Solution**: 
1. Clear build cache: Settings → Build & Deploy → Clear Build Cache
2. Trigger manual deploy

### Runtime Errors

**Issue**: API returns 500 errors

**Solution**:
1. Check logs for error details
2. Verify `DATABASE_URL` is set correctly
3. Ensure database schema is initialized: `pnpm --filter @workspace/db run push`

**Issue**: Frontend shows "Failed to fetch"

**Solution**:
1. Verify `VITE_API_URL` points to correct API URL
2. Check API service is running
3. Verify CORS configuration in API

**Issue**: Database connection errors

**Solution**:
1. Verify database service is running
2. Check `DATABASE_URL` format
3. Ensure API and database are in same region for best performance

### Performance Issues

**Issue**: Slow response times

**Solution**:
1. Free tier services sleep after 15 minutes of inactivity
2. First request after sleep takes 30-60 seconds to wake up
3. Consider upgrading to paid tier for always-on services

**Issue**: Database connection pool exhausted

**Solution**:
1. Check for connection leaks in code
2. Adjust pool settings in `lib/db/src/index.ts`
3. Monitor active connections in database metrics

## Scaling and Upgrades

### Free Tier Limitations

- **API Server**: 
  - 512 MB RAM
  - 0.1 CPU
  - Sleeps after 15 min inactivity
  - 750 hours/month (shared across all free services)

- **Static Site**:
  - 100 GB bandwidth/month
  - Global CDN

- **Database**:
  - 1 GB storage
  - 90-day free trial
  - Then $7/month

### Upgrade Path

When you need more resources:

1. **API Server**: Upgrade to Starter ($7/month)
   - 512 MB RAM
   - Always on
   - No sleep

2. **Database**: Automatically billed after 90 days ($7/month)
   - 1 GB storage
   - Automatic backups
   - High availability

3. **Custom Domains**: Free on all plans

## CI/CD Integration

Render automatically deploys on git push when auto-deploy is enabled.

### Deploy Hooks

For manual or external triggers:

1. Go to service settings
2. Navigate to **Settings** → **Deploy Hook**
3. Copy the webhook URL
4. Use in CI/CD pipelines:
   ```bash
   curl -X POST https://api.render.com/deploy/srv-xxxxx?key=xxxxx
   ```

### GitHub Actions (Optional)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Render

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Trigger Render Deploy
        run: |
          curl -X POST ${{ secrets.RENDER_DEPLOY_HOOK }}
```

## Security Checklist

- [ ] `SESSION_SECRET` is randomly generated (32+ characters)
- [ ] `ALLOWED_ORIGINS` is set to frontend URL only
- [ ] Database credentials are not exposed in logs
- [ ] HTTPS is enabled (automatic on Render)
- [ ] Security headers are configured (via Helmet in API)
- [ ] Rate limiting is enabled (configured in API code)

## Cost Optimization

### Keep Free Tier

To stay on free tier:

1. Accept 15-minute sleep time for API
2. Use database sparingly (1 GB limit)
3. Monitor bandwidth usage on static site

### Reduce Costs

1. **Database**: After 90 days, consider:
   - Supabase free tier (500 MB, permanent)
   - Neon free tier (3 GB, permanent)
   - Self-hosted on free VM

2. **API**: Keep on free tier if:
   - Low traffic expected
   - Sleep time is acceptable
   - Under 750 hours/month

## Support and Resources

- [Render Documentation](https://render.com/docs)
- [Render Community Forum](https://community.render.com)
- [Render Status Page](https://status.render.com)
- [Render Support](https://render.com/support)

## Next Steps

After successful deployment:

1. Test all functionality:
   - User registration
   - Login/logout
   - Game save/load
   - Leaderboard
   - Password recovery

2. Set up monitoring:
   - Configure uptime monitoring (e.g., UptimeRobot)
   - Set up error tracking (e.g., Sentry)

3. Document your deployment:
   - Save service URLs
   - Document environment variables
   - Create runbook for common issues

4. Plan for scaling:
   - Monitor usage metrics
   - Set budget alerts
   - Plan upgrade timeline if needed