# Quick Start: Deploy to Render (Free)

Get The Model Forge running on Render's free tier in under 15 minutes.

## Prerequisites

- GitHub account
- Render account ([sign up free](https://render.com))
- This repository pushed to GitHub

## Step-by-Step Deployment

### 1. Push to GitHub (if not already done)

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-USERNAME/the-model-forge.git
git branch -M main
git push -u origin main
```

### 2. Deploy via Render Blueprint

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Blueprint"**
3. Connect your GitHub account (if first time)
4. Select your repository: `the-model-forge`
5. Render detects `render.yaml` automatically
6. Review services:
   - ✅ `model-forge-db` (PostgreSQL)
   - ✅ `model-forge-api` (API Server)
   - ✅ `model-forge` (Frontend)
7. Click **"Apply"**
8. Wait 5-10 minutes for deployment

### 3. Configure Frontend Environment

After deployment completes:

1. Go to `model-forge` service in dashboard
2. Click **"Environment"** tab
3. Add variable:
   - **Key**: `VITE_API_URL`
   - **Value**: `https://model-forge-api.onrender.com`
4. Click **"Save Changes"** (triggers redeploy)

### 4. Update CORS Configuration

1. Go to `model-forge-api` service
2. Click **"Environment"** tab
3. Find `ALLOWED_ORIGINS` variable
4. Update value to: `https://model-forge.onrender.com`
5. Click **"Save Changes"** (triggers redeploy)

### 5. Initialize Database

1. Go to `model-forge-api` service
2. Click **"Shell"** tab (wait for service to be running)
3. Run command:
   ```bash
   pnpm --filter @workspace/db run push
   ```
4. Wait for "Schema pushed successfully" message

### 6. Test Your Deployment

1. Open: `https://model-forge.onrender.com`
2. Test features:
   - ✅ Page loads without errors
   - ✅ Create guest account
   - ✅ Play a few turns
   - ✅ Save game
   - ✅ View leaderboard
   - ✅ Register account (optional)

## Your URLs

After deployment, you'll have:

- **Frontend**: `https://model-forge.onrender.com`
- **API**: `https://model-forge-api.onrender.com`
- **Database**: Internal connection (not public)

## Important Notes

### Free Tier Limitations

- **API sleeps after 15 minutes** of inactivity
  - First request after sleep takes 30-60 seconds
  - Subsequent requests are fast
  
- **Database free for 90 days**
  - Then $7/month automatically
  - 1 GB storage limit

- **750 hours/month** shared across all free services
  - Enough for 1-2 services running 24/7

### Auto-Deploy

Changes pushed to `main` branch automatically deploy:

```bash
git add .
git commit -m "Update feature"
git push origin main
```

Watch deployment progress in Render dashboard.

## Troubleshooting

### "Service Unavailable" on first visit

**Cause**: Free tier service is waking up from sleep

**Solution**: Wait 30-60 seconds and refresh

### CORS errors in browser console

**Cause**: `ALLOWED_ORIGINS` not set correctly

**Solution**: 
1. Go to API service → Environment
2. Set `ALLOWED_ORIGINS` to exact frontend URL
3. No trailing slash: `https://model-forge.onrender.com`

### Database connection errors

**Cause**: Schema not initialized

**Solution**:
1. Go to API service → Shell
2. Run: `pnpm --filter @workspace/db run push`

### Build failures

**Cause**: Dependency or type errors

**Solution**:
1. Check logs in Render dashboard
2. Fix errors locally first
3. Test with: `pnpm run typecheck && pnpm run build`
4. Push fix to GitHub

## Next Steps

### Optional: Custom Domain

1. Go to frontend service → Settings
2. Click "Custom Domains"
3. Add your domain (e.g., `modelforge.yourdomain.com`)
4. Update DNS records as instructed
5. Update `ALLOWED_ORIGINS` in API to include custom domain

### Optional: GitHub Actions CI/CD

1. Go to API service → Settings → Deploy Hook
2. Copy webhook URL
3. Add to GitHub Secrets as `RENDER_API_DEPLOY_HOOK`
4. Repeat for frontend service as `RENDER_FRONTEND_DEPLOY_HOOK`
5. GitHub Actions will run type checks before deploying

### Monitor Your App

- **Logs**: Service → Logs tab
- **Metrics**: Service → Metrics tab
- **Health**: Check `/api/health` endpoint

## Cost Management

### Stay Free

- Accept 15-minute sleep time
- Keep database under 1 GB
- Monitor bandwidth usage

### After 90 Days

Database becomes $7/month. Alternatives:

1. **Pay for Render database** ($7/month)
   - Easiest, no changes needed
   - Automatic backups
   
2. **Switch to Supabase** (free forever)
   - 500 MB limit
   - Update `DATABASE_URL`
   
3. **Switch to Neon** (free forever)
   - 3 GB limit
   - Update `DATABASE_URL`

## Support

- **Render Docs**: https://render.com/docs
- **Render Community**: https://community.render.com
- **App Docs**: See `docs/` folder in repository

## Success! 🎉

Your app is now live and accessible worldwide. Share your URL and start playing!

**Frontend**: `https://model-forge.onrender.com`

---

For detailed documentation, see:
- [Full Deployment Guide](docs/DEPLOYMENT-RENDER.md)
- [Architecture Overview](docs/ARCHITECTURE.md)
- [API Documentation](docs/API.md)