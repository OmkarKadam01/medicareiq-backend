'use strict';

const { query, getClient }           = require('../db');
const { createError }                = require('../middleware/errorHandler');
const { broadcastToClinic, broadcastToPatient } = require('../websocket');
const { assertValidTransition }      = require('./appointmentService');
const { sendNotification }           = require('../utils/fcm');
const { getTodayQueue }              = require('./queueService');

/**
 * Create a visit record and associated prescriptions.
 * This is called when a doctor concludes a consultation.
 *
 * Wrapped in a transaction:
 * 1. Verify appointment is IN_CONSULTATION
 * 2. Create visit record
 * 3. Insert prescription lines
 * 4. Update appointment status to DONE
 * 5. Trigger FCM to compounder(s)
 * 6. Broadcast prescription:ready via WebSocket
 *
 * @param {number} appointmentId
 * @param {number} staffId       - Doctor's staff ID
 * @param {Object} visitData
 * @param {string} visitData.chiefComplaint
 * @param {string} visitData.doctorNotes
 * @param {string} [visitData.diagnosis]
 * @param {Date}   [visitData.followUpDate]
 * @param {Array}  visitData.medicines - [{ drugId, dosage, frequency, durationDays, quantity, instructions }]
 * @returns {Promise<Object>} Created visit with prescriptions
 */
async function createVisit(appointmentId, staffId, { chiefComplaint, doctorNotes, diagnosis, followUpDate, medicines = [] }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Verify appointment exists and is IN_CONSULTATION
    const apptResult = await client.query(
      `SELECT a.*, p.id AS patient_id_val, p.name AS patient_name, p.fcm_token AS patient_fcm
       FROM appointments a
       JOIN patients p ON a.patient_id = p.id
       WHERE a.id = $1
       FOR UPDATE`,
      [appointmentId]
    );

    if (apptResult.rows.length === 0) {
      throw createError('Appointment not found', 404);
    }

    const appt = apptResult.rows[0];
    assertValidTransition(appt.status, 'DONE');

    if (appt.status !== 'IN_CONSULTATION') {
      throw createError(
        `Appointment must be IN_CONSULTATION to create a visit. Current status: ${appt.status}`,
        400
      );
    }

    // Check for existing visit (idempotency guard)
    const existingVisit = await client.query(
      `SELECT id FROM visits WHERE appointment_id = $1`,
      [appointmentId]
    );
    if (existingVisit.rows.length > 0) {
      throw createError('A visit record already exists for this appointment', 409);
    }

    // Create the visit record
    const visitResult = await client.query(
      `INSERT INTO visits (appointment_id, patient_id, attending_staff, chief_complaint, doctor_notes, diagnosis, follow_up_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        appointmentId,
        appt.patient_id,
        staffId,
        chiefComplaint || null,
        doctorNotes    || null,
        diagnosis      || null,
        followUpDate   || null,
      ]
    );

    const visit = visitResult.rows[0];

    // Insert prescription lines
    const prescriptions = [];
    for (const med of medicines) {
      if (!med.drugId || !med.dosage || !med.frequency) {
        throw createError('Each medicine must have drugId, dosage, and frequency', 400);
      }

      // Verify drug exists and is active
      const drugResult = await client.query(
        `SELECT id, name FROM drugs WHERE id = $1 AND is_active = TRUE`,
        [med.drugId]
      );
      if (drugResult.rows.length === 0) {
        throw createError(`Drug ID ${med.drugId} not found or is inactive`, 400);
      }

      const prescResult = await client.query(
        `INSERT INTO prescriptions (visit_id, drug_id, dosage, frequency, duration_days, quantity, instructions, is_dispensed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
         RETURNING *`,
        [
          visit.id,
          med.drugId,
          med.dosage,
          med.frequency,
          med.durationDays || null,
          med.quantity     || 1,
          med.instructions || null,
        ]
      );

      prescriptions.push({ ...prescResult.rows[0], drug_name: drugResult.rows[0].name });
    }

    // Update appointment status to DONE
    await client.query(
      `UPDATE appointments
       SET status = 'DONE', completed_at = NOW()
       WHERE id = $1`,
      [appointmentId]
    );

    await client.query('COMMIT');

    console.log(
      `[Prescription] Visit ${visit.id} created for appointment ${appointmentId}. ` +
      `${prescriptions.length} prescription(s) written.`
    );

    // After commit: send async notifications (don't fail the response if these fail)
    setImmediate(async () => {
      try {
        // Notify compounders via FCM
        const compounderResult = await query(
          `SELECT fcm_token FROM staff WHERE role = 'compounder' AND is_active = TRUE AND fcm_token IS NOT NULL`,
          []
        );

        for (const compounder of compounderResult.rows) {
          await sendNotification(
            compounder.fcm_token,
            'New Prescription Ready',
            `Token #${appt.token_number} - ${medicines.length} medicine(s) to dispense`,
            {
              type: 'prescription:ready',
              visitId: String(visit.id),
              appointmentId: String(appointmentId),
              tokenNumber: String(appt.token_number),
            }
          );
        }

        // Broadcast prescription:ready to all clinic (compounder) connections
        broadcastToClinic('prescription:ready', {
          visitId: visit.id,
          appointmentId,
          tokenNumber: appt.token_number,
          patientName: appt.patient_name,
          medicineCount: prescriptions.length,
        });

        // Update clinic queue display
        const queueSnapshot = await getTodayQueue();
        broadcastToClinic('queue:updated', { queue: queueSnapshot });

        // Notify patient their prescription is written
        if (appt.patient_fcm) {
          await sendNotification(
            appt.patient_fcm,
            'Prescription Ready',
            'Your prescription is ready. Please proceed to the dispensary.',
            {
              type: 'prescription:ready',
              visitId: String(visit.id),
            }
          );
        }
        broadcastToPatient(appt.patient_id, 'prescription:ready', {
          visitId: visit.id,
          message: 'Your prescription is ready. Please proceed to the dispensary.',
        });
      } catch (notifyErr) {
        console.error('[Prescription] Notification error (non-fatal):', notifyErr.message);
      }
    });

    return { visit, prescriptions };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get all visits pending dispensing (status DONE with un-dispensed prescriptions).
 * Used by the compounder screen.
 *
 * @returns {Promise<Array>}
 */
async function getPendingDispense() {
  const today = new Date().toISOString().split('T')[0];

  const result = await query(
    `SELECT
       v.id             AS visit_id,
       v.patient_id,
       v.chief_complaint,
       v.created_at     AS visit_created_at,
       a.id             AS appointment_id,
       a.token_number,
       a.status         AS appointment_status,
       p.name           AS patient_name,
       p.phone          AS patient_phone,
       pr.id            AS prescription_id,
       pr.drug_id,
       pr.dosage,
       pr.frequency,
       pr.duration_days,
       pr.quantity,
       pr.instructions,
       pr.is_dispensed,
       d.name           AS drug_name,
       d.unit           AS drug_unit
     FROM visits v
     JOIN appointments a ON v.appointment_id = a.id
     JOIN patients p     ON v.patient_id = p.id
     JOIN prescriptions pr ON pr.visit_id = v.id
     JOIN drugs d        ON pr.drug_id = d.id
     WHERE a.appointment_date = $1
       AND a.status = 'DONE'
       AND pr.is_dispensed = FALSE
     ORDER BY a.token_number ASC, pr.id ASC`,
    [today]
  );

  // Group by visit
  const visitsMap = new Map();
  for (const row of result.rows) {
    if (!visitsMap.has(row.visit_id)) {
      visitsMap.set(row.visit_id, {
        visitId:       String(row.visit_id),
        appointmentId: String(row.appointment_id),
        patientId:     String(row.patient_id),
        patientName:   row.patient_name,
        tokenNumber:   row.token_number,
        prescriptions: [],
      });
    }

    visitsMap.get(row.visit_id).prescriptions.push({
      id:           String(row.prescription_id),
      drugId:       String(row.drug_id),
      drugName:     row.drug_name,
      dose:         row.dosage,
      frequency:    row.frequency,
      durationDays: row.duration_days,
      instructions: row.instructions,
      dispensed:    row.is_dispensed,
    });
  }

  return Array.from(visitsMap.values());
}

/**
 * Mark medicines as dispensed for a visit.
 * Idempotent — re-dispensing already dispensed items is a no-op.
 * If ALL prescriptions for the visit are dispensed, update appointment to DISPENSED.
 *
 * @param {number}   visitId
 * @param {number[]} dispensedItems - Array of prescription IDs to mark as dispensed
 * @returns {Promise<Object>}
 */
async function dispenseVisit(visitId, dispensedItems = []) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Verify visit exists
    const visitResult = await client.query(
      `SELECT v.*, a.id AS appointment_id, a.status AS appt_status, a.patient_id
       FROM visits v
       JOIN appointments a ON v.appointment_id = a.id
       WHERE v.id = $1
       FOR UPDATE`,
      [visitId]
    );

    if (visitResult.rows.length === 0) {
      throw createError('Visit not found', 404);
    }

    const visit = visitResult.rows[0];

    if (visit.appt_status === 'DISPENSED') {
      // Already fully dispensed — idempotent success
      await client.query('ROLLBACK');
      return { alreadyDispensed: true, visitId };
    }

    if (visit.appt_status !== 'DONE') {
      throw createError(
        `Cannot dispense: appointment status is '${visit.appt_status}', expected 'DONE'`,
        400
      );
    }

    // Mark specified prescriptions as dispensed (idempotent)
    if (dispensedItems.length > 0) {
      await client.query(
        `UPDATE prescriptions
         SET is_dispensed = TRUE, dispensed_at = NOW()
         WHERE visit_id = $1
           AND id = ANY($2::int[])
           AND is_dispensed = FALSE`,
        [visitId, dispensedItems]
      );
    }

    // Check if all prescriptions are now dispensed
    const remainingResult = await client.query(
      `SELECT COUNT(*) AS remaining
       FROM prescriptions
       WHERE visit_id = $1 AND is_dispensed = FALSE`,
      [visitId]
    );

    const remaining = parseInt(remainingResult.rows[0].remaining, 10);
    let fullyDispensed = false;

    if (remaining === 0) {
      // All dispensed — update appointment status
      assertValidTransition('DONE', 'DISPENSED');
      await client.query(
        `UPDATE appointments SET status = 'DISPENSED' WHERE id = $1`,
        [visit.appointment_id]
      );
      fullyDispensed = true;

      console.log(`[Prescription] Visit ${visitId} fully dispensed`);
    }

    await client.query('COMMIT');

    // Notify patient if fully dispensed
    if (fullyDispensed) {
      const patientResult = await query(
        `SELECT fcm_token FROM patients WHERE id = $1`,
        [visit.patient_id]
      );

      if (patientResult.rows.length > 0 && patientResult.rows[0].fcm_token) {
        await sendNotification(
          patientResult.rows[0].fcm_token,
          'Medicines Ready',
          'Your medicines have been dispensed. Thank you for visiting MedicareIQ Clinic!',
          { type: 'medicines:dispensed', visitId: String(visitId) }
        );
      }

      broadcastToPatient(visit.patient_id, 'medicines:dispensed', {
        visitId,
        message: 'Your medicines have been dispensed.',
      });
    }

    return {
      visitId,
      fullyDispensed,
      remainingCount: remaining,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createVisit, getPendingDispense, dispenseVisit };
