'use strict';

const express = require('express');
const router  = express.Router();

const { authenticatePatient }   = require('../middleware/auth');
const { apiLimiter }            = require('../middleware/rateLimiter');
const {
  getAvailableSlots,
  bookAppointment,
  cancelAppointment,
  getPatientAppointments,
  getQueueStatus,
}                               = require('../services/appointmentService');
const { validateCheckin }       = require('../services/geofenceService');

/**
 * Map a raw DB appointment row (snake_case) to the camelCase shape
 * expected by the patient app's Appointment model.
 */
function mapAppointment(row) {
  const appointmentDate = row.appointment_date instanceof Date
    ? row.appointment_date.toISOString().split('T')[0]
    : String(row.appointment_date).split('T')[0];

  const slotTime = row.slot_time
    ? String(row.slot_time).substring(0, 5)
    : null;

  return {
    id:              String(row.id),
    appointmentDate,
    slotTime,
    tokenNumber:     row.token_number,
    status:          row.status,
    bookedAt:        row.created_at,
  };
}

// All appointment routes require patient auth
router.use(authenticatePatient);
router.use(apiLimiter);

/**
 * GET /appointments/slots?date=YYYY-MM-DD
 *
 * Get available booking slots for a given date.
 */
router.get('/slots', async (req, res, next) => {
  try {
    const { date } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date query param is required in YYYY-MM-DD format' });
    }

    // Prevent booking in the past
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return res.status(400).json({ error: 'Cannot check slots for past dates' });
    }

    // Patients book into clinic 1 by default; extend with ?clinicId= param when multi-clinic is needed
    const clinicId = parseInt(req.query.clinicId, 10) || 1;
    const slots = await getAvailableSlots(date, clinicId);
    // Return bare array matching patient app model: [{ slotTime, availableCount }]
    return res.status(200).json(slots);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /appointments
 *
 * Book a new appointment.
 * Body: { date: 'YYYY-MM-DD', slotTime: 'HH:MM' }
 */
router.post('/', async (req, res, next) => {
  try {
    const { date, slotTime } = req.body;

    if (!date || !slotTime) {
      return res.status(400).json({ error: 'date and slotTime are required' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    }

    if (!/^\d{2}:\d{2}$/.test(slotTime)) {
      return res.status(400).json({ error: 'slotTime must be in HH:MM format' });
    }

    // Prevent booking in the past
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return res.status(400).json({ error: 'Cannot book appointments for past dates' });
    }

    const clinicId = parseInt(req.body.clinicId, 10) || 1;
    const appointment = await bookAppointment(req.patientId, date, slotTime, clinicId);

    // Return bare camelCase object matching patient app Appointment model
    return res.status(201).json(mapAppointment(appointment));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /appointments/my
 *
 * Get the authenticated patient's upcoming and past appointments.
 */
router.get('/my', async (req, res, next) => {
  try {
    const { upcoming, history } = await getPatientAppointments(req.patientId);
    // Return bare camelCase array (upcoming first, then history) matching patient app model
    return res.status(200).json([...upcoming, ...history].map(mapAppointment));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /appointments/:id/queue-status
 *
 * Get queue position and estimated wait time for an appointment.
 */
router.get('/:id/queue-status', async (req, res, next) => {
  try {
    const appointmentId = parseInt(req.params.id, 10);
    if (isNaN(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointment ID' });
    }

    const status = await getQueueStatus(appointmentId, req.patientId);
    return res.status(200).json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /appointments/:id/checkin
 *
 * Geofence-validated manual check-in.
 * Body: { lat: number, lng: number }
 */
router.post('/:id/checkin', async (req, res, next) => {
  try {
    const appointmentId = parseInt(req.params.id, 10);
    if (isNaN(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointment ID' });
    }

    const { lat, lng } = req.body;

    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'lat and lng are required in request body' });
    }

    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    if (isNaN(latNum) || isNaN(lngNum)) {
      return res.status(400).json({ error: 'lat and lng must be valid numbers' });
    }

    const result = await validateCheckin(appointmentId, req.patientId, latNum, lngNum);
    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /appointments/:id
 *
 * Cancel an appointment (patient must own it; must be >30 min before slot).
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const appointmentId = parseInt(req.params.id, 10);
    if (isNaN(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointment ID' });
    }

    const appointment = await cancelAppointment(appointmentId, req.patientId, 1);
    return res.status(200).json({ message: 'Appointment cancelled successfully', appointment });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
