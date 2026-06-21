# Deployment Verification Checklist

Use this checklist to verify your deployment is working correctly.

## Pre-Deployment Verification

### Local Build Test

- [ ] `pnpm install` completes without errors
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run build` succeeds
- [ ] No TypeScript errors in output
- [ ] All packages build successfully

### Environment Variables

- [ ] `DATABASE_URL` is set and valid
- [ ] `SESSION_SECRET` is generated (32+ characters)
- [ ] `ALLOWED_ORIGINS` matches frontend URL
- [ ] `PORT` is set for API server
- [ ] `VITE_API_URL` points to API server
- [ ] `BASE_PATH` is configured for frontend
- [ ] No secrets in source control

### Database

- [ ] PostgreSQL is provisioned
- [ ] Connection string is accessible
- [ ] Database is empty or ready for schema
- [ ] Connection pool settings are appropriate

## Post-Deployment Verification

### Service Health

#### API Server

- [ ] Service is running (not crashed)
- [ ] Health endpoint responds: `GET /api/health`
- [ ] Returns 200 OK status
- [ ] Response time < 2 seconds (after warmup)
- [ ] Logs show no errors
- [ ] Database connection successful

#### Frontend

- [ ] Static site is deployed
- [ ] Homepage loads without errors
- [ ] No 404 errors in browser console
- [ ] No CORS errors in browser console
- [ ] Assets load correctly (CSS, JS, images)
- [ ] Routing works (refresh on any page)

#### Database

- [ ] Schema is initialized
- [ ] Tables exist: `players`, `sessions`
- [ ] Indexes are created
- [ ] Connection pool is working

### Functional Testing

#### Guest Play

- [ ] Click "Play as Guest" button
- [ ] Game loads successfully
- [ ] Can make decisions
- [ ] Turn advances correctly
- [ ] Score updates
- [ ] Can complete a game

#### User Registration

- [ ] Click "Register" or "Sign Up"
- [ ] Registration form appears
- [ ] Can enter username and password
- [ ] Password requirements shown
- [ ] Registration succeeds
- [ ] Redirects to game or dashboard
- [ ] User is logged in

#### User Login

- [ ] Click "Login" or "Sign In"
- [ ] Login form appears
- [ ] Can enter credentials
- [ ] Login succeeds with valid credentials
- [ ] Login fails with invalid credentials
- [ ] Error message shown for invalid login
- [ ] Redirects after successful login

#### Game Save/Load

- [ ] Play a few turns as logged-in user
- [ ] Game state saves automatically
- [ ] Refresh page
- [ ] Game state persists
- [ ] Can continue from saved state
- [ ] Progress is maintained

#### Leaderboard

- [ ] Leaderboard page loads
- [ ] Shows completed games
- [ ] Sorted by score (highest first)
- [ ] Shows username, score, day
- [ ] No sensitive data exposed
- [ ] Pagination works (if applicable)

#### Password Recovery

- [ ] Click "Forgot Password"
- [ ] Recovery flow starts
- [ ] Recovery code is generated
- [ ] Can use code to reset password
- [ ] Code is single-use
- [ ] Old password no longer works
- [ ] New password works

### Security Verification

#### CORS

- [ ] API only accepts requests from allowed origins
- [ ] Cross-origin requests from other domains fail
- [ ] Preflight requests handled correctly
- [ ] Credentials included in requests

#### Authentication

- [ ] Cannot access protected endpoints without auth
- [ ] Session cookies are secure
- [ ] Session cookies are httpOnly
- [ ] Logout clears session
- [ ] Cannot reuse old session after logout

#### Rate Limiting

- [ ] Auth endpoints are rate limited
- [ ] Excessive requests return 429 status
- [ ] Rate limit resets after time period
- [ ] Different endpoints have appropriate limits

#### Input Validation

- [ ] Invalid input is rejected
- [ ] Error messages are user-friendly
- [ ] No stack traces exposed to users
- [ ] SQL injection attempts fail
- [ ] XSS attempts are sanitized

#### Headers

- [ ] `X-Frame-Options` is set
- [ ] `X-Content-Type-Options` is set
- [ ] `Referrer-Policy` is set
- [ ] `Content-Security-Policy` is set (if applicable)
- [ ] HTTPS is enforced

### Performance Verification

#### Response Times

- [ ] Homepage loads < 2 seconds
- [ ] API health check < 500ms
- [ ] Game actions < 1 second
- [ ] Leaderboard loads < 2 seconds
- [ ] Database queries < 500ms

#### Resource Usage

- [ ] API memory usage is stable
- [ ] No memory leaks detected
- [ ] CPU usage is reasonable
- [ ] Database connections don't leak
- [ ] Connection pool size is appropriate

#### Caching

- [ ] Static assets have cache headers
- [ ] API responses have appropriate cache headers
- [ ] Browser caching works correctly
- [ ] CDN caching works (if applicable)

### Error Handling

#### API Errors

- [ ] 404 for unknown endpoints
- [ ] 400 for invalid input
- [ ] 401 for unauthorized access
- [ ] 500 errors are logged
- [ ] Error responses are JSON formatted
- [ ] No sensitive data in error messages

#### Frontend Errors

- [ ] 404 page for unknown routes
- [ ] Error boundaries catch React errors
- [ ] Network errors show user-friendly messages
- [ ] Failed API calls are handled gracefully
- [ ] Loading states are shown

#### Database Errors

- [ ] Connection failures are handled
- [ ] Query errors are logged
- [ ] Transactions roll back on error
- [ ] Connection pool recovers from errors

### Monitoring Setup

#### Logging

- [ ] API logs are accessible
- [ ] Log level is appropriate (info in production)
- [ ] Errors are logged with context
- [ ] No sensitive data in logs
- [ ] Logs are structured (JSON)

#### Metrics

- [ ] Can view service metrics
- [ ] CPU usage is tracked
- [ ] Memory usage is tracked
- [ ] Request rate is tracked
- [ ] Error rate is tracked

#### Alerts

- [ ] Uptime monitoring configured (optional)
- [ ] Error rate alerts configured (optional)
- [ ] Resource usage alerts configured (optional)
- [ ] Deployment notifications configured (optional)

## Platform-Specific Checks

### Render

- [ ] All services show "Live" status
- [ ] Auto-deploy is enabled
- [ ] Deploy hooks are configured (optional)
- [ ] Custom domains configured (optional)
- [ ] SSL certificates are active
- [ ] Environment variables are set correctly

### Database

- [ ] Backup schedule is configured
- [ ] Connection limit is appropriate
- [ ] Storage usage is monitored
- [ ] Free tier limits are understood

## Post-Verification Tasks

### Documentation

- [ ] Deployment URLs documented
- [ ] Environment variables documented
- [ ] Access credentials stored securely
- [ ] Runbook created for common issues
- [ ] Team members have access

### Monitoring

- [ ] Set up external uptime monitoring
- [ ] Configure error tracking (Sentry, etc.)
- [ ] Set up log aggregation (optional)
- [ ] Create dashboard for key metrics

### Maintenance

- [ ] Schedule regular health checks
- [ ] Plan for database backups
- [ ] Document upgrade path
- [ ] Set budget alerts (if applicable)

## Troubleshooting Common Issues

### Service Won't Start

**Symptoms**: Service shows "Failed" or "Crashed" status

**Check**:
- [ ] Build logs for errors
- [ ] Environment variables are set
- [ ] Database is accessible
- [ ] Port is configured correctly
- [ ] Start command is correct

### CORS Errors

**Symptoms**: Browser console shows CORS errors

**Check**:
- [ ] `ALLOWED_ORIGINS` includes frontend URL
- [ ] No trailing slashes in URLs
- [ ] Protocol matches (http vs https)
- [ ] Port is included if non-standard

### Database Connection Fails

**Symptoms**: API returns 500 errors, logs show connection errors

**Check**:
- [ ] `DATABASE_URL` is correct
- [ ] Database service is running
- [ ] Network connectivity exists
- [ ] Connection pool settings are appropriate
- [ ] Database schema is initialized

### Slow Performance

**Symptoms**: Requests take > 5 seconds

**Check**:
- [ ] Service is awake (not sleeping)
- [ ] Database queries are optimized
- [ ] Indexes are created
- [ ] Connection pooling is working
- [ ] No memory leaks

### Build Failures

**Symptoms**: Deployment fails during build

**Check**:
- [ ] Dependencies are locked (pnpm-lock.yaml)
- [ ] Build command is correct
- [ ] TypeScript errors are fixed
- [ ] Generated code is up to date
- [ ] Build cache is cleared (if needed)

## Sign-Off

Deployment verified by: _______________

Date: _______________

Issues found: _______________

Issues resolved: _______________

Production ready: [ ] Yes [ ] No

Notes:
_______________________________________
_______________________________________
_______________________________________