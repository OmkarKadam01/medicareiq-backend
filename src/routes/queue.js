'use strict';

const express = require('express');
const router  = express.Router();

const { authenticateStaff, requireRole } = require('../middleware/auth');
const { apiLimiter }                     = require('../middleware/rateLimiter');
const {
  getTodayQueue,
  callNextPatient,
  skipPatient,
}                                        = require('../services/queueService');

// All queue routes require staff authentication
router.use(authenticateStaff);
router.use(apiLimiter);

/**
 * GET /queue/today
 *
 * Returns the full queue for today, sorted by token number.
 * Accessible to all authenticated staff.
 */
router.get('/today', async (req, res, next) => {
  try {
    const queue = await getTodayQueue();

    // Keep legacy format for old clients and new format for current clients
    const patients = queue.map(appointment => ({
      appointmentId: appointment.id.toString(),
      tokenNumber: appointment.token_number,
      patientId: appointment.patient_id.toString(),
      patientName: appointment.patient_name,
      age: null,
      gender: null,
      status: appointment.status,
      slotTime: appointment.slot_time,
      checkedInAt: appointment.checked_in_at,
      calledAt: appointment.called_at
    }));

    const currentToken = queue
      .filter(a => ['IN_CONSULTATION', 'DONE'].includes(a.status))
      .sort((a, b) => b.token_number - a.token_number)[0]?.token_number || null;

    const avgConsultTimeMins = 10;

    return res.status(200).json({
      date: new Date().toISOString().split('T')[0],
      patients,
      currentToken,
      avgConsultTimeMins,
      queue: patients,
      count: patients.length
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /queue/call-next
 *
 * Mark the next CHECKED_IN patient as IN_CONSULTATION.
 * Doctor role only.
 */
router.post('/call-next', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const appointment = await callNextPatient(req.staffId);
    return res.status(200).json({
      message: `Token #${appointment.token_number} called`,
      appointment,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /queue/skip/:appointmentId
 *
 * Skip a specific patient in the queue.
 * Doctor role only.
 */
router.post('/skip/:appointmentId', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const appointmentId = parseInt(req.params.appointmentId, 10);
    if (isNaN(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointment ID' });
    }

    const appointment = await skipPatient(appointmentId);
    return res.status(200).json({
      message: `Token #${appointment.token_number} skipped`,
      appointment,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
