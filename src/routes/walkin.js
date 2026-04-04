'use strict';

const express = require('express');
const router  = express.Router();

const { authenticateStaff, requireRole } = require('../middleware/auth');
const { apiLimiter }                     = require('../middleware/rateLimiter');
const { query, getClient }               = require('../db');
const { createError }                    = require('../middleware/errorHandler');
const { broadcastToClinic }              = require('../websocket');

// All walk-in routes require staff auth (doctor or admin)
router.use(authenticateStaff);
router.use(apiLimiter);

/**
 * GET /walkin/patient?phone=+91XXXXXXXXXX
 *
 * Look up a patient by phone number.
 * Returns patient info if found, 404 if not.
 */
router.get('/patient', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const { phone } = req.query;
    if (!phone) {
      return res.status(400).json({ error: 'phone query param is required' });
    }

    // Look up patient by phone; clinic isolation is enforced at the appointment level
    const result = await query(
      `SELECT id, phone, name, gender FROM patients WHERE phone = $1`,
      [phone.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ found: false });
    }

    const p = result.rows[0];
    return res.status(200).json({
      found: true,
      patient: {
        id:     String(p.id),
        phone:  p.phone,
        name:   p.name,
        gender: p.gender,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /walkin/book
 *
 * Register a walk-in patient and immediately check them in.
 * - If patient exists (by phone): use existing record
 * - If patient is new: create with provided name/gender
 * - Assigns next token, sets status = CHECKED_IN immediately
 * - Bypasses slot capacity check (doctor is manually registering)
 *
 * Body: { phone, name?, gender? }
 */
router.post('/book', requireRole('doctor', 'admin'), async (req, res, next) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { phone, name, gender } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'phone is required' });
    }

    const clinicId = req.clinicId;
    const today = new Date().toISOString().split('T')[0];
    const now   = new Date();
    const slotTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    // Find or create patient
    let patientId;
    const existingResult = await client.query(
      `SELECT id FROM patients WHERE phone = $1`,
      [phone.trim()]
    );

    if (existingResult.rows.length > 0) {
      patientId = existingResult.rows[0].id;
      if (name || gender) {
        await client.query(
          `UPDATE patients SET
             name       = COALESCE($2, name),
             gender     = COALESCE($3, gender),
             updated_at = NOW()
           WHERE id = $1`,
          [patientId, name || null, gender || null]
        );
      }
    } else {
      if (!name || !name.trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'name is required for a new patient' });
      }
      const insertResult = await client.query(
        `INSERT INTO patients (phone, name, gender)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [phone.trim(), name.trim(), gender || null]
      );
      patientId = insertResult.rows[0].id;
    }

    // Check for existing active appointment today scoped to this clinic
    const dupCheck = await client.query(
      `SELECT id FROM appointments
       WHERE clinic_id = $1
         AND patient_id = $2
         AND appointment_date = $3
         AND status NOT IN ('CANCELLED','EXPIRED','DONE','DISPENSED','SKIPPED')
       LIMIT 1`,
      [clinicId, patientId, today]
    );
    if (dupCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Patient already has an active appointment today' });
    }

    // Atomic token assignment per clinic per date
    const tokenResult = await client.query(
      `INSERT INTO token_counters (clinic_id, date, last_token)
       VALUES ($1, $2, 1)
       ON CONFLICT (clinic_id, date) DO UPDATE
         SET last_token = token_counters.last_token + 1
       RETURNING last_token`,
      [clinicId, today]
    );
    const tokenNumber = parseInt(tokenResult.rows[0].last_token, 10);

    // Insert appointment as CHECKED_IN immediately (walk-in is already at the clinic)
    const apptResult = await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, appointment_date, slot_time, token_number, status, checked_in_at)
       VALUES ($1, $2, $3, $4, $5, 'CHECKED_IN', NOW())
       RETURNING *`,
      [clinicId, patientId, today, slotTime, tokenNumber]
    );

    const appointment = apptResult.rows[0];

    // Fetch the created patient details for response
    const patientResult = await client.query(
      `SELECT id, phone, name, gender FROM patients WHERE id = $1`,
      [patientId]
    );
    const patient = patientResult.rows[0];

    await client.query('COMMIT');

    console.log(
      `[WalkIn] clinic=${clinicId} patient=${patientId} (${patient.name}), token=${tokenNumber}, appointment=${appointment.id}`
    );

    // Broadcast queue update
    setImmediate(async () => {
      try {
        const queueSnapshot = await require('../services/queueService').getTodayQueue(clinicId);
        broadcastToClinic(clinicId, 'queue:updated', { queue: queueSnapshot });
      } catch {}
    });

    return res.status(201).json({
      appointment: {
        id:              String(appointment.id),
        tokenNumber:     appointment.token_number,
        status:          appointment.status,
        appointmentDate: today,
        slotTime,
      },
      patient: {
        id:     String(patient.id),
        phone:  patient.phone,
        name:   patient.name,
        gender: patient.gender,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
