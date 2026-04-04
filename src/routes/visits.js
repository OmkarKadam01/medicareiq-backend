'use strict';

const express = require('express');
const router  = express.Router();

const { authenticateStaff, requireRole } = require('../middleware/auth');
const { apiLimiter }                     = require('../middleware/rateLimiter');
const { query }                          = require('../db');
const { createVisit }                    = require('../services/prescriptionService');

// All visit routes require staff auth
router.use(authenticateStaff);
router.use(apiLimiter);

/**
 * POST /visits
 *
 * Create a visit record and prescriptions for an IN_CONSULTATION appointment.
 * Doctor role only.
 *
 * Body: {
 *   appointmentId: number,
 *   chiefComplaint?: string,
 *   doctorNotes?: string,
 *   diagnosis?: string,
 *   followUpDate?: 'YYYY-MM-DD',
 *   medicines: [{ drugId, dosage, frequency, durationDays?, quantity?, instructions? }]
 * }
 */
router.post('/', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const {
      appointmentId,
      chiefComplaint,
      doctorNotes,
      diagnosis,
      followUpDate,
      medicines,
    } = req.body;

    if (!appointmentId) {
      return res.status(400).json({ error: 'appointmentId is required' });
    }

    if (!Array.isArray(medicines)) {
      return res.status(400).json({ error: 'medicines must be an array (can be empty)' });
    }

    const { visit, prescriptions } = await createVisit(
      parseInt(appointmentId, 10),
      req.staffId,
      {
        chiefComplaint,
        doctorNotes,
        diagnosis,
        followUpDate: followUpDate || null,
        medicines,
      }
    );

    return res.status(201).json({
      visit,
      prescriptions,
      message: 'Visit created and prescription sent to dispensary',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /visits/by-appointment/:appointmentId
 *
 * Get the visit for a completed appointment (by appointment ID, not visit ID).
 * Used by doctor to view completed patient details from the queue screen.
 */
router.get('/by-appointment/:appointmentId', async (req, res, next) => {
  try {
    const appointmentId = parseInt(req.params.appointmentId, 10);
    if (isNaN(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointment ID' });
    }

    const visitResult = await query(
      `SELECT v.id, v.appointment_id, v.patient_id, v.chief_complaint,
              v.doctor_notes, v.created_at
       FROM visits v
       WHERE v.appointment_id = $1
       LIMIT 1`,
      [appointmentId]
    );

    if (visitResult.rows.length === 0) {
      return res.status(404).json({ error: 'No visit found for this appointment' });
    }

    const v = visitResult.rows[0];

    const prescResult = await query(
      `SELECT pr.id, pr.drug_id, d.name AS drug_name, pr.dosage,
              pr.frequency, pr.duration_days, pr.instructions, pr.is_dispensed
       FROM prescriptions pr
       JOIN drugs d ON pr.drug_id = d.id
       WHERE pr.visit_id = $1
       ORDER BY pr.id ASC`,
      [v.id]
    );

    return res.status(200).json({
      visitId:       String(v.id),
      appointmentId: String(v.appointment_id),
      patientId:     String(v.patient_id),
      chiefComplaint: v.chief_complaint,
      doctorNotes:   v.doctor_notes,
      createdAt:     v.created_at,
      prescriptions: prescResult.rows.map(p => ({
        id:           String(p.id),
        drugId:       String(p.drug_id),
        drugName:     p.drug_name,
        dose:         p.dosage,
        frequency:    p.frequency,
        durationDays: p.duration_days,
        instructions: p.instructions,
        dispensed:    p.is_dispensed,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /visits/:visitId
 *
 * Get a visit record with prescriptions.
 * All staff roles can view.
 */
router.get('/:visitId', async (req, res, next) => {
  try {
    const visitId = parseInt(req.params.visitId, 10);
    if (isNaN(visitId)) {
      return res.status(400).json({ error: 'Invalid visit ID' });
    }

    const visitResult = await query(
      `SELECT
         v.id,
         v.appointment_id,
         v.patient_id,
         v.attending_staff,
         v.chief_complaint,
         v.doctor_notes,
         v.diagnosis,
         v.follow_up_date,
         v.created_at,
         v.updated_at,
         p.name      AS patient_name,
         p.phone     AS patient_phone,
         p.gender    AS patient_gender,
         p.blood_group,
         p.allergies,
         s.name      AS doctor_name,
         a.appointment_date,
         a.slot_time,
         a.token_number,
         a.status    AS appointment_status
       FROM visits v
       JOIN patients p     ON v.patient_id = p.id
       LEFT JOIN staff s   ON v.attending_staff = s.id
       JOIN appointments a ON v.appointment_id = a.id
       WHERE v.id = $1`,
      [visitId]
    );

    if (visitResult.rows.length === 0) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    const visit = visitResult.rows[0];

    // Fetch prescriptions
    const prescResult = await query(
      `SELECT
         pr.id,
         pr.drug_id,
         pr.dosage,
         pr.frequency,
         pr.duration_days,
         pr.quantity,
         pr.instructions,
         pr.is_dispensed,
         pr.dispensed_at,
         pr.created_at,
         d.name AS drug_name,
         d.unit AS drug_unit,
         d.generic_name
       FROM prescriptions pr
       JOIN drugs d ON pr.drug_id = d.id
       WHERE pr.visit_id = $1
       ORDER BY pr.id ASC`,
      [visitId]
    );

    return res.status(200).json({
      visit,
      prescriptions: prescResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
