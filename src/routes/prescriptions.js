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
    return res.status(200).json({ pendingVisits, count: pendingVisits.length });
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

    if (result.alreadyDispensed) {
      return res.status(200).json({
        message: 'All items already dispensed',
        visitId,
        fullyDispensed: true,
      });
    }

    return res.status(200).json({
      message: result.fullyDispensed
        ? 'All medicines dispensed. Visit complete.'
        : `Dispensed successfully. ${result.remainingCount} item(s) still pending.`,
      visitId,
      fullyDispensed:  result.fullyDispensed,
      remainingCount:  result.remainingCount,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
