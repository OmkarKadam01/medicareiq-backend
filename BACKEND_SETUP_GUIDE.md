# MedicareIQ Backend Setup & Deployment Guide

## Overview
This guide provides step-by-step instructions to set up and deploy the MedicareIQ backend API to **Render** (as specified in the PRD). The backend is built with Node.js, Express, PostgreSQL, and includes WebSocket support for real-time features.

**Hosting Platform**: Render (free tier)  
**Database**: Neon PostgreSQL (free tier)  
**Estimated Time**: 1-2 days  
**Prerequisites**: Git, Node.js 20+, npm, and a GitHub account  
**Platform**: Windows (commands optimized for Windows PowerShell)

**Important Notes for Render Hosting:**
- Render provides automatic SSL/TLS certificates
- WebSocket connections work on Render (wss:// protocol)
- Free tier includes 750 hours/month, auto-sleep after 15 minutes of inactivity
- Environment variables are securely managed in Render dashboard
- Build and deployment are automated from GitHub

---

## Step 1: Prerequisites Setup

### 1.1 Install Required Software
```bash
# Check Node.js version (must be 20+)
node --version
npm --version

# If not installed:
# 1. Download from https://nodejs.org/ (LTS version recommended)
# 2. Run the installer
# 3. Restart your terminal/PowerShell
```

### 1.2 Install Git (if not already installed)
```bash
git --version

# If not installed:
# Download from https://git-scm.com/download/win
# Or install via winget: winget install --id Git.Git -e --source winget
```

### 1.2 Clone Repository
```bash
cd "d:\Android Projects\VS Poject"
git clone <your-repo-url> medicareiq-backend
cd medicareiq-backend
```

### 1.3 Install Dependencies
```bash
npm install
```

---

## Step 2: Database Setup (PostgreSQL on Neon)

### 2.1 Create Neon Account
1. Go to [neon.tech](https://neon.tech)
2. Sign up with GitHub/Google or email
3. Verify your email

### 2.2 Create Database
1. Click "Create a project"
2. Choose:
   - **Project name**: `medicareiq-db`
   - **Region**: Select closest to your users (e.g., `us-east-1`)
   - **PostgreSQL version**: Latest (15+)
3. Click "Create project"

### 2.3 Get Connection Details
1. In your Neon dashboard, go to "Connection Details"
2. Copy the **Connection string** (it looks like: `postgresql://username:password@hostname/dbname?sslmode=require`)
3. **Important**: This string includes your password - keep it secure!

### 2.4 Test Database Connection
```bash
# Install PostgreSQL client (optional, for testing)
# Windows: Download from https://www.postgresql.org/download/windows/
# Or use online tools like https://www.elephantsql.com/ for testing

# Test connection (replace with your actual connection string)
# Using psql if installed
postgresql://neondb_owner:npg_oZYb8wJtXW2m@ep-little-leaf-aneg9gwf-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require

psql "postgresql://neondb_owner:npg_oZYb8wJtXW2m@ep-little-leaf-aneg9gwf-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require" -c "SELECT version();"

# Alternative: Use a GUI tool like pgAdmin or DBeaver
```

---

## Step 3: Environment Configuration

### 3.1 Create Environment File
Create a `.env` file in the `medicareiq-backend` directory:

```bash
# In PowerShell/Command Prompt
type nul > .env
# Or create the file manually in VS Code
```

Edit `.env` with your actual values:

```env
# Database
DATABASE_URL=postgresql://your-username:your-password@your-hostname/your-dbname?sslmode=require

# JWT Secrets (generate random strings)
JWT_SECRET=your-super-secure-jwt-secret-here-minimum-32-characters
JWT_REFRESH_SECRET=your-super-secure-refresh-secret-here-minimum-32-characters

# Server
PORT=3000
NODE_ENV=development

# CORS (for local development)
FRONTEND_URL=http://localhost:3000

# Firebase (optional - for push notifications)
# Get these from Firebase Console -> Project Settings -> Service Accounts
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
```

### 3.2 Generate Secure JWT Secrets
```bash
# Windows PowerShell method
[System.Web.Security.Membership]::GeneratePassword(32, 0)

# Or use Node.js (works on Windows)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Alternative: Use online random string generator
# Visit: https://www.random.org/strings/
# Generate 1 string, length 32, format base64
```

### 3.3 Firebase Setup (Optional for POC)
If you want push notifications:

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project: `medicareiq-fcm`
3. Enable Authentication (Phone) and Cloud Messaging
4. Go to Project Settings → Service Accounts
5. Generate new private key → Download JSON
6. Extract values for `.env`:
   - `project_id`
   - `private_key` (with `\n` for line breaks)
   - `client_email`

---

## Step 4: Database Migration

### 4.1 Run Migration Script
```bash
# Make sure you're in the backend directory
cd "d:\Android Projects\VS Poject\medicareiq-backend"

# Run the migration (connects to your DATABASE_URL)
# Windows PowerShell - make sure DATABASE_URL environment variable is set
$env:DATABASE_URL = "your-connection-string-here"
node -e "
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  
  const sqlPath = path.join(__dirname, 'migrations', '001_initial.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await client.query(sql);
  
  console.log('Migration completed successfully!');
  await client.end();
}

migrate().catch(console.error);
"
```

### 4.2 Verify Migration
```bash
# Connect to database and check tables
# If psql is installed
psql "%DATABASE_URL%" -c "\dt"

# Should show tables: patients, staff, clinic_config, drugs, appointments, visits, prescriptions
```

### 4.3 Seed Default Clinic Config
The migration includes default clinic configuration. Verify:

```sql
-- Connect to your database
psql "%DATABASE_URL%" -c "SELECT * FROM clinic_config;"

-- Should show 1 row with default values
```

---

## Step 5: Local Development & Testing

### 5.1 Start Development Server
```bash
# Start with nodemon (auto-restart on changes)
npm run dev

# Or start normally
npm start
```

Expected output:
```
[DB] PostgreSQL connection verified
[FCM] WARNING: Firebase credentials not fully configured...
[Server] MedicareIQ backend listening on port 3000
[Server] Environment: development
[Server] WebSocket endpoint: ws://localhost:3000/ws?token=<jwt>
[Cron] Appointment expiry job started (interval: 60s)
```

### 5.2 Test Health Endpoint
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-04-03T...",
  "uptime": 5,
  "wsConnections": 0
}
```

### 5.3 Test Clinic Status Endpoint
```bash
curl http://localhost:3000/clinic/status
```

Expected response:
```json
{
  "isOpen": true,
  "openingTime": "09:00:00",
  "closingTime": "17:00:00",
  "queueLength": 0,
  "nextAvailableDate": "2026-04-03",
  "avgWaitMinutes": 10
}
```

### 5.4 Test Staff Login (Optional)
First, create a staff account in database:

```sql
-- Connect to database
psql "$DATABASE_URL"

-- Insert a test staff member (password will be 'admin123')
INSERT INTO staff (username, password_hash, name, role, is_active) 
VALUES ('admin', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'Admin User', 'admin', true);
```

Then test login:
```bash
curl -X POST http://localhost:3000/auth/staff/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'
```

Expected: JWT tokens in response.

---

## Step 6: Deployment to Render

**Why Render?** As specified in the PRD, Render is used for hosting because it provides:
- Free tier suitable for POC development
- Automatic SSL certificates
- WebSocket support for real-time features
- PostgreSQL database integration
- Easy GitHub integration for CI/CD

### 6.1 Prepare Repository
1. Commit your changes:
```bash
git add .
git commit -m "Setup MedicareIQ backend with database and environment"
git push origin main
```

2. Make sure repository is public or connected to your GitHub account

### 6.2 Create Render Account
1. Go to [render.com](https://render.com)
2. Sign up with GitHub (recommended for easy repo connection)
3. Connect your GitHub account

### 6.3 Create Web Service
1. Click "New" → "Web Service"
2. Connect your GitHub repository: `your-username/medicareiq-backend`
3. Configure service:
   - **Name**: `medicareiq-backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
   - **Region**: Select closest to your users

### 6.4 Configure Environment Variables
In Render dashboard, go to your service → "Environment":

Add these environment variables (copy from your local `.env`):
```
DATABASE_URL=postgresql://your-username:your-password@your-hostname/your-dbname?sslmode=require
JWT_SECRET=your-super-secure-jwt-secret-here-minimum-32-characters
JWT_REFRESH_SECRET=your-super-secure-refresh-secret-here-minimum-32-characters
NODE_ENV=production
FRONTEND_URL=https://your-play-store-app-url.com
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
```

### 6.5 Deploy
1. Click "Create Web Service"
2. Render will:
   - Clone your repository
   - Run `npm install`
   - Start the service with `npm start`
3. Wait for build and deployment (5-10 minutes)
4. Get your service URL: `https://medicareiq-backend.onrender.com`

### 6.6 Verify Deployment
```bash
# Test health endpoint
curl https://medicareiq-backend.onrender.com/health

# Test clinic status
curl https://medicareiq-backend.onrender.com/clinic/status

# Test WebSocket endpoint (should be accessible)
# wss://medicareiq-backend.onrender.com/ws
```

**Render Free Tier Notes:**
- Service sleeps after 15 minutes of inactivity
- First request after sleep may take 30-50 seconds
- 750 hours/month free, then $7/month
- Automatic HTTPS included
- Logs available in Render dashboard

---

## Step 7: Post-Deployment Configuration

### 7.1 Update Clinic Configuration
Connect to your database and update clinic settings:

```sql
-- Update clinic location (replace with actual coordinates)
UPDATE clinic_config SET 
  clinic_lat = 28.6139000,  -- New Delhi coordinates (example)
  clinic_lng = 77.2090000,
  geofence_radius_m = 300,
  checkin_window_mins = 15
WHERE id = 1;
```

### 7.2 Test Full Flow
1. **Staff Login**: Test staff authentication
2. **Patient Registration**: Test Firebase OTP flow
3. **Appointment Booking**: Test slot availability and booking
4. **WebSocket**: Test real-time queue updates
5. **Geofencing**: Test check-in validation

### 7.3 Monitoring
- Check Render logs for errors
- Monitor database connections (Neon free tier: 10 max)
- Set up uptime monitoring if needed

---

## Troubleshooting

### Database Connection Issues
```bash
# Test connection (Windows)
psql "%DATABASE_URL%" -c "SELECT 1;"

# Check SSL mode
# Make sure ?sslmode=require is in your DATABASE_URL

# If psql is not in PATH, use full path
# "C:\Program Files\PostgreSQL\15\bin\psql.exe" "%DATABASE_URL%" -c "SELECT 1;"
```

### Build Failures on Render
- Check build logs in Render dashboard
- Ensure all dependencies are in `package.json`
- Verify Node.js version (20+) in Render settings
- Check that `npm install` completes without errors

### WebSocket Issues on Render
- WebSocket endpoint: `wss://your-render-url.onrender.com/ws`
- Free tier Render may sleep - first request may be slow (30-50s)
- WebSocket connections are supported on Render
- Check browser developer tools for connection errors

### Render Service Sleeping
- Free tier services sleep after 15 minutes of inactivity
- First request after sleep takes longer to respond
- This is normal behavior for free tier
- Consider upgrading to paid tier for production use

### Environment Variables on Render
- Variables are set in Render dashboard, not in `.env` file
- Changes require re-deployment (automatic on push)
- Sensitive data is encrypted and secure

### Firebase Issues
- Verify service account key format (with `\n` for line breaks)
- Check Firebase project permissions

---

## Security Notes

- **Never commit `.env` to Git** - it's in `.gitignore`
- **Use strong JWT secrets** - minimum 32 characters
- **Render provides automatic SSL/TLS** - all connections are HTTPS
- **Environment variables are encrypted** in Render dashboard
- **Database connections are secure** with SSL mode
- **Regular backup** - Neon provides automatic backups
- **Monitor usage** - Free tiers have limits (750 hours/month on Render)

---

## Next Steps

After backend deployment:
1. **Update Android apps** with your Render backend URL:
   - Patient App: Update API base URL to `https://medicareiq-backend.onrender.com`
   - Clinic App: Update API base URL to `https://medicareiq-backend.onrender.com`
   - WebSocket URL: `wss://medicareiq-backend.onrender.com/ws`

2. **Test end-to-end flow** with mobile apps
3. **Configure Firebase** for push notifications
4. **Set up monitoring** and alerts in Render dashboard
5. **Consider upgrading** from free tier when ready for production

For questions or issues, check the backend logs and database queries.</content>
<parameter name="filePath">d:\Android Projects\VS Poject\medicareiq-backend\BACKEND_SETUP_GUIDE.md