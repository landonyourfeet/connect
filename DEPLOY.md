# Switching the Grok robot from FUB → OKCREAL Connect
# Only 3 env var changes in Railway — zero code changes in server.js

## Step 1: Deploy the CRM as a NEW Railway service
- Create a new service in Railway, same project
- Connect the crm/ folder as its own repo (or subfolder)
- Add a PostgreSQL database to the project
- Set env vars on the CRM service:
    DATABASE_URL    = (Railway PostgreSQL URL — auto-injected)
    CRM_API_KEY     = okcreal-connect-robot-key   ← you pick this
    JWT_SECRET      = some-long-random-string
    ADMIN_EMAIL     = jodi@okcreal.com
    ADMIN_PASSWORD  = (your chosen password)
    ADMIN_NAME      = Jodi
    PORT            = 4000

## Step 2: Change 3 env vars on the ROBOT service (server.js)
Old:
    FUB_API_KEY = your-fub-key
    (no FUB_BASE_URL since it hardcodes https://api.followupboss.com)

New — add these to the robot's Railway env vars:
    FUB_API_KEY  = okcreal-connect-robot-key    ← matches CRM_API_KEY above
    FUB_BASE_URL = https://your-crm.railway.app  ← your CRM service URL

## Step 3: Add FUB_BASE_URL support to server.js
Find this line in server.js (around line 30):
    const fubAPI = axios.create({
      baseURL: 'https://api.followupboss.com/v1',

Change to:
    const fubAPI = axios.create({
      baseURL: (process.env.FUB_BASE_URL || 'https://api.followupboss.com') + '/v1',

That's it. The robot will now talk to your CRM instead of FUB.
Cancel FUB. Save $400/month.

## Staff login
URL: https://your-crm.railway.app
Default login: admin@okcreal.com / OKCReal2024!  (change on first login)

## Add team members
POST /api/users  (admin only) with { name, email, password, role: 'agent' }
Or I can add a team management screen — just ask.
