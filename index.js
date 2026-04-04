'use strict';

// Load environment variables FIRST — before any other require
require('dotenv').config();

const http    = require('http');
const express = require('express');
const cors    = require('cors');

// Internal modules
const { pool }               = require('./src/db');
const { initializeFirebase } = require('./src/utils/fcm');
const { setupWebSocket }     = require('./src/websocket');
const { errorHandler }       = require('./src/middleware/errorHandler');

// Route modules
const authRoutes         = require('./src/routes/auth');
const clinicRoutes       = require('./src/routes/clinic');
const appointmentRoutes  = require('./src/routes/appointments');
const queueRoutes        = require('./src/routes/queue');
const patientRoutes      = require('./src/routes/patients');
const visitRoutes        = require('./src/routes/visits');
const drugRoutes         = require('./src/routes/drugs');
const prescriptionRoutes = require('./src/routes/prescriptions');
const walkinRoutes       = require('./src/routes/walkin');

// Periodic job
const { expireOldAppointments } = require('./src/services/appointmentService');

// ============================================================
// App setup
// ============================================================
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ============================================================
// CORS
// ============================================================
const frontendUrl = process.env.FRONTEND_URL;

if (!frontendUrl || frontendUrl === 'http://localhost:3000') {
  console.warn(
    '[CORS] WARNING: Allowing all origins. ' +
    'Set FRONTEND_URL to restrict CORS in production.'
  );
}

app.use(
  cors({
    origin: '*', // POC mode — allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);

// ============================================================
// Body parsing
// ============================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ============================================================
// Request logging (lightweight)
// ============================================================
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path} — ${new Date().toISOString()}`);
  next();
});

// ============================================================
// Routes
// ============================================================

// Public routes (no auth required)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

app.use('/auth',          authRoutes);
app.use('/clinic',        clinicRoutes);

// Protected routes
app.use('/appointments',  appointmentRoutes);
app.use('/queue',         queueRoutes);
app.use('/patients',      patientRoutes);
app.use('/visits',        visitRoutes);
app.use('/drugs',         drugRoutes);
app.use('/prescriptions', prescriptionRoutes);
app.use('/walkin',        walkinRoutes);

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler — MUST be last middleware
app.use(errorHandler);

// ============================================================
// HTTP + WebSocket server
// ============================================================
const server = http.createServer(app);
setupWebSocket(server);

// ============================================================
// Periodic jobs
// ============================================================
const EXPIRE_JOB_INTERVAL_MS = 60 * 1000; // every 60 seconds

let expireJobHandle = null;

function startPeriodicJobs() {
  expireJobHandle = setInterval(async () => {
    try {
      await expireOldAppointments();
    } catch (err) {
      console.error('[Cron] expireOldAppointments error:', err.message);
    }
  }, EXPIRE_JOB_INTERVAL_MS);

  // Don't prevent the process from exiting cleanly
  if (expireJobHandle.unref) expireJobHandle.unref();

  console.log('[Cron] Appointment expiry job started (interval: 60s)');
}

// ============================================================
// Startup
// ============================================================
async function start() {
  // Verify DB connectivity
  try {
    await pool.query('SELECT NOW()');
    console.log('[DB] PostgreSQL connection verified');
  } catch (err) {
    console.error('[DB] FATAL: Cannot connect to database:', err.message);
    process.exit(1);
  }

  // Initialize Firebase (non-fatal if credentials missing)
  initializeFirebase();

  // Start periodic jobs
  startPeriodicJobs();

  // Start listening
  server.listen(PORT, () => {
    console.log(`[Server] MedicareIQ backend listening on port ${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}/ws?token=<jwt>`);
  });
}

// ============================================================
// Graceful shutdown
// ============================================================
function shutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);

  if (expireJobHandle) clearInterval(expireJobHandle);

  server.close(async () => {
    console.log('[Server] HTTP server closed');
    try {
      await pool.end();
      console.log('[DB] Connection pool closed');
    } catch (err) {
      console.error('[DB] Error closing pool:', err.message);
    }
    console.log('[Server] Shutdown complete');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('[Server] Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ============================================================
// Uncaught exception / rejection guards
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
  // In production you'd want to alert and then restart via process manager
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  // Log but don't exit for unhandled rejections in production
  // (process managers like PM2 will restart if needed)
});

// ============================================================
// Boot
// ============================================================
start().catch((err) => {
  console.error('[FATAL] Startup failed:', err.message);
  process.exit(1);
});

module.exports = { app, server }; // exported for testing
