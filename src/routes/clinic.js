'use strict';

const express = require('express');
const router  = express.Router();

const { query }              = require('../db');
const { getAvailableSlots }  = require('../services/appointmentService');
const { getRollingAvgConsultTime } = require('../services/queueService');
const { getConnectedClientCount }  = require('../websocket');

/**
 * GET /health
 *
 * Public health check endpoint.
 * Returns 200 with server status, timestamp, and connection count.
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    wsConnections: getConnectedClientCount(),
  });
});

/**
 * GET /clinic/status
 *
 * Public endpoint — returns current clinic status for patients.
 * Response: { isOpen, queueLength, nextAvailableDate, avgWaitMinutes }
 */
router.get('/status', async (req, res, next) => {
  try {
    // Fetch clinic config
    const configResult = await query(
      `SELECT is_open, opening_time, closing_time FROM clinic_config LIMIT 1`,
      []
    );

    if (configResult.rows.length === 0) {
      return res.status(503).json({ error: 'Clinic configuration not available' });
    }

    const config = configResult.rows[0];
    const today  = new Date().toISOString().split('T')[0];

    // Count today's active queue length (checked-in patients)
    const queueResult = await query(
      `SELECT COUNT(*) AS queue_length
       FROM appointments
       WHERE appointment_date = $1
         AND status IN ('CHECKED_IN', 'IN_CONSULTATION')`,
      [today]
    );
    const queueLength = parseInt(queueResult.rows[0].queue_length, 10);

    // Rolling average consult time
    let avgWaitMinutes = 10;
    try {
      avgWaitMinutes = await getRollingAvgConsultTime();
    } catch {
      // Non-critical; use default
    }

    // Find next available date (today or future) with open slots
    let nextAvailableDate = null;
    const maxDaysAhead = 7;

    for (let i = 0; i < maxDaysAhead; i++) {
      const checkDate = new Date();
      checkDate.setDate(checkDate.getDate() + i);
      const checkDateStr = checkDate.toISOString().split('T')[0];

      try {
        const slots = await getAvailableSlots(checkDateStr);
        if (slots.length > 0) {
          nextAvailableDate = checkDateStr;
          break;
        }
      } catch {
        // Skip this date
      }
    }

    return res.status(200).json({
      isOpen:            config.is_open,
      openingTime:       config.opening_time,
      closingTime:       config.closing_time,
      queueLength,
      nextAvailableDate,
      avgWaitMinutes,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
