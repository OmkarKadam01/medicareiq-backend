'use strict';

const express = require('express');
const router  = express.Router();

const { authenticateStaff, requireRole } = require('../middleware/auth');
const { apiLimiter }                     = require('../middleware/rateLimiter');
const { getPendingDispense, dispenseVisit } = require('../services/prescriptionService');

// All prescription routes require staff auth
router.use(authenticateStaff);
router.use(apiLimiter);

/**
 * GET /prescriptions/pending-dispense
 *
 * Returns all visits from today with un-dispensed prescriptions.
 * Compounder or admin only.
 */
router.get('/pending-dispense', requireRole('compounder', 'admin', 'doctor'), async (req, res, next) => {
  try {
    const pendingVisits = await getPendingDispense();
    // Return bare array matching clinic app PendingDispenseItem model
    return res.status(200).json(pendingVisits);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /prescriptions/:visitId/dispense
 *
 * Mark one or more prescription items as dispensed for a visit.
 * Idempotent — already-dispensed items are silently skipped.
 * If all items are dispensed, appointment status moves to DISPENSED.
 *
 * Compounder or admin only.
 *
 * Body: {
 *   prescriptionIds: number[]   // specific prescription line IDs to dispense
 *                               // if omitted/empty, dispense ALL pending items
 * }
 */
router.post('/:visitId/dispense', requireRole('compounder', 'admin', 'doctor'), async (req, res, next) => {
  try {
    const visitId = parseInt(req.params.visitId, 10);
    if (isNaN(visitId)) {
      return res.status(400).json({ error: 'Invalid visit ID' });
    }

    let { prescriptionIds } = req.body;

    // If no specific IDs provided, dispense all (pass empty array — service will handle it)
    if (!Array.isArray(prescriptionIds)) {
      prescriptionIds = [];
    }

    // Validate all IDs are numbers
    const validatedIds = prescriptionIds
      .map((id) => parseInt(id, 10))
      .filter((id) => !isNaN(id));

    const result = await dispenseVisit(visitId, validatedIds);

    // Fetch updated prescription list to return to the clinic app
    const { query } = require('../db');
    const prescRows = await query(
      `SELECT pr.id, pr.drug_id, d.name AS drug_name, pr.dosage AS dose,
              pr.frequency, pr.duration_days, pr.instructions, pr.is_dispensed AS dispensed
       FROM prescriptions pr
       JOIN drugs d ON pr.drug_id = d.id
       WHERE pr.visit_id = $1
       ORDER BY pr.id`,
      [visitId]
    );

    const prescriptions = prescRows.rows.map(r => ({
      id:           String(r.id),
      drugId:       String(r.drug_id),
      drugName:     r.drug_name,
      dose:         r.dose,
      frequency:    r.frequency,
      durationDays: r.duration_days,
      instructions: r.instructions,
      dispensed:    r.dispensed,
    }));

    const dispensedCount = prescriptions.filter(p => p.dispensed).length;

    return res.status(200).json({
      visitId:       String(visitId),
      dispensedCount,
      prescriptions,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
