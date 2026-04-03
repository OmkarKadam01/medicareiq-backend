'use strict';

const express = require('express');
const router  = express.Router();

const { authenticatePatient, authenticateStaff } = require('../middleware/auth');
const { apiLimiter }                             = require('../middleware/rateLimiter');
const { query }                                  = require('../db');
const { createError }                            = require('../middleware/errorHandler');

/**
 * GET /patients/me
 *
 * Returns the authenticated patient's own profile.
 */
router.get('/me', authenticatePatient, apiLimiter, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, phone, name, date_of_birth, gender, address, blood_group, allergies, created_at, updated_at
       FROM patients
       WHERE id = $1`,
      [req.patientId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    return res.status(200).json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /patients/me
 *
 * Update the authenticated patient's profile.
 * Body: { name?, dateOfBirth?, gender?, address?, bloodGroup?, allergies?, fcmToken? }
 */
router.put('/me', authenticatePatient, apiLimiter, async (req, res, next) => {
  try {
    const { name, dateOfBirth, gender, address, bloodGroup, allergies, fcmToken } = req.body;

    // Validate gender if provided
    if (gender && !['male', 'female', 'other'].includes(gender)) {
      return res.status(400).json({ error: 'gender must be one of: male, female, other' });
    }

    // Validate dateOfBirth if provided
    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      return res.status(400).json({ error: 'dateOfBirth must be in YYYY-MM-DD format' });
    }

    const result = await query(
      `UPDATE patients
       SET
         name          = COALESCE($2, name),
         date_of_birth = COALESCE($3::date, date_of_birth),
         gender        = COALESCE($4, gender),
         address       = COALESCE($5, address),
         blood_group   = COALESCE($6, blood_group),
         allergies     = COALESCE($7, allergies),
         fcm_token     = COALESCE($8, fcm_token),
         updated_at    = NOW()
       WHERE id = $1
       RETURNING id, phone, name, date_of_birth, gender, address, blood_group, allergies, updated_at`,
      [
        req.patientId,
        name        || null,
        dateOfBirth || null,
        gender      || null,
        address     || null,
        bloodGroup  || null,
        allergies   || null,
        fcmToken    || null,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    return res.status(200).json({ patient: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /patients/me/history
 *
 * Returns the authenticated patient's visit history timeline.
 * Includes visits, prescriptions, and appointment details.
 */
router.get('/me/history', authenticatePatient, apiLimiter, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT
         v.id             AS visit_id,
         v.chief_complaint,
         v.doctor_notes,
         v.diagnosis,
         v.follow_up_date,
         v.created_at     AS visit_date,
         a.id             AS appointment_id,
         a.appointment_date,
         a.slot_time,
         a.token_number,
         a.status         AS appointment_status,
         s.name           AS doctor_name,
         pr.id            AS prescription_id,
         pr.dosage,
         pr.frequency,
         pr.duration_days,
         pr.quantity,
         pr.instructions,
         pr.is_dispensed,
         d.name           AS drug_name,
         d.unit           AS drug_unit
       FROM visits v
       JOIN appointments a    ON v.appointment_id = a.id
       LEFT JOIN staff s      ON v.attending_staff = s.id
       LEFT JOIN prescriptions pr ON pr.visit_id = v.id
       LEFT JOIN drugs d      ON pr.drug_id = d.id
       WHERE v.patient_id = $1
       ORDER BY v.created_at DESC, pr.id ASC`,
      [req.patientId]
    );

    // Group by visit
    const visitsMap = new Map();
    for (const row of result.rows) {
      if (!visitsMap.has(row.visit_id)) {
        visitsMap.set(row.visit_id, {
          visitId:          row.visit_id,
          visitDate:        row.visit_date,
          chiefComplaint:   row.chief_complaint,
          doctorNotes:      row.doctor_notes,
          diagnosis:        row.diagnosis,
          followUpDate:     row.follow_up_date,
          doctorName:       row.doctor_name,
          appointmentId:    row.appointment_id,
          appointmentDate:  row.appointment_date,
          slotTime:         row.slot_time,
          tokenNumber:      row.token_number,
          prescriptions:    [],
        });
      }

      if (row.prescription_id) {
        visitsMap.get(row.visit_id).prescriptions.push({
          id:          row.prescription_id,
          drugName:    row.drug_name,
          drugUnit:    row.drug_unit,
          dosage:      row.dosage,
          frequency:   row.frequency,
          durationDays: row.duration_days,
          quantity:    row.quantity,
          instructions: row.instructions,
          isDispensed: row.is_dispensed,
        });
      }
    }

    return res.status(200).json({ history: Array.from(visitsMap.values()) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /patients/:id/history
 *
 * Staff-only: Get a specific patient's visit history.
 * Requires staff authentication.
 */
router.get('/:id/history', authenticateStaff, apiLimiter, async (req, res, next) => {
  try {
    const patientId = parseInt(req.params.id, 10);
    if (isNaN(patientId)) {
      return res.status(400).json({ error: 'Invalid patient ID' });
    }

    // Verify patient exists
    const patientResult = await query(
      `SELECT id, name, phone FROM patients WHERE id = $1`,
      [patientId]
    );
    if (patientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    const result = await query(
      `SELECT
         v.id             AS visit_id,
         v.chief_complaint,
         v.doctor_notes,
         v.diagnosis,
         v.follow_up_date,
         v.created_at     AS visit_date,
         a.id             AS appointment_id,
         a.appointment_date,
         a.slot_time,
         a.token_number,
         a.status         AS appointment_status,
         s.name           AS doctor_name,
         pr.id            AS prescription_id,
         pr.dosage,
         pr.frequency,
         pr.duration_days,
         pr.quantity,
         pr.instructions,
         pr.is_dispensed,
         d.name           AS drug_name,
         d.unit           AS drug_unit
       FROM visits v
       JOIN appointments a    ON v.appointment_id = a.id
       LEFT JOIN staff s      ON v.attending_staff = s.id
       LEFT JOIN prescriptions pr ON pr.visit_id = v.id
       LEFT JOIN drugs d      ON pr.drug_id = d.id
       WHERE v.patient_id = $1
       ORDER BY v.created_at DESC, pr.id ASC`,
      [patientId]
    );

    const visitsMap = new Map();
    for (const row of result.rows) {
      if (!visitsMap.has(row.visit_id)) {
        visitsMap.set(row.visit_id, {
          visitId:         row.visit_id,
          visitDate:       row.visit_date,
          chiefComplaint:  row.chief_complaint,
          doctorNotes:     row.doctor_notes,
          diagnosis:       row.diagnosis,
          followUpDate:    row.follow_up_date,
          doctorName:      row.doctor_name,
          appointmentDate: row.appointment_date,
          tokenNumber:     row.token_number,
          prescriptions:   [],
        });
      }

      if (row.prescription_id) {
        visitsMap.get(row.visit_id).prescriptions.push({
          id:          row.prescription_id,
          drugName:    row.drug_name,
          drugUnit:    row.drug_unit,
          dosage:      row.dosage,
          frequency:   row.frequency,
          durationDays: row.duration_days,
          quantity:    row.quantity,
          instructions: row.instructions,
          isDispensed: row.is_dispensed,
        });
      }
    }

    // Return visit array directly (client expects List<VisitHistory>)
    return res.status(200).json(Array.from(visitsMap.values()));
      history: Array.from(visitsMap.values()),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
