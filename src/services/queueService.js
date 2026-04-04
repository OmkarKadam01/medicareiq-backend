'use strict';

const { query }              = require('../db');
const { createError }        = require('../middleware/errorHandler');
const { broadcastToClinic, broadcastToPatient } = require('../websocket');
const { assertValidTransition } = require('./appointmentService');

/**
 * Get the full queue snapshot for today for a specific clinic, sorted by token number.
 *
 * @param {number} clinicId
 * @returns {Promise<Array>}
 */
async function getTodayQueue(clinicId) {
  const today = new Date().toISOString().split('T')[0];

  const result = await query(
    `SELECT
       a.id,
       a.token_number,
       COALESCE(a.slot_time::text, 'Unknown') AS slot_time,
       a.status,
       a.called_at,
       a.completed_at,
       a.notes,
       a.doctor_id,
       p.id   AS patient_id,
       COALESCE(p.name, 'Unknown') AS patient_name,
       p.phone AS patient_phone
     FROM appointments a
     JOIN patients p ON a.patient_id = p.id
     WHERE a.clinic_id = $1
       AND a.appointment_date = $2
       AND a.status NOT IN ('CANCELLED', 'EXPIRED')
     ORDER BY a.token_number ASC`,
    [clinicId, today]
  );

  return result.rows;
}

/**
 * Call the next patient into consultation for a given clinic.
 *
 * @param {number} staffId   - The doctor's staff ID
 * @param {number} clinicId  - The clinic the doctor belongs to
 * @returns {Promise<Object>} The appointment now IN_CONSULTATION
 */
async function callNextPatient(staffId, clinicId) {
  const today = new Date().toISOString().split('T')[0];

  // Find currently IN_CONSULTATION appointment (if any) to close it
  const currentResult = await query(
    `SELECT id, patient_id FROM appointments
     WHERE clinic_id = $1
       AND appointment_date = $2
       AND status = 'IN_CONSULTATION'
     LIMIT 1`,
    [clinicId, today]
  );

  if (currentResult.rows.length > 0) {
    const current = currentResult.rows[0];
    assertValidTransition('IN_CONSULTATION', 'DONE');

    await query(
      `UPDATE appointments
       SET status = 'DONE', completed_at = NOW()
       WHERE id = $1`,
      [current.id]
    );

    console.log(`[Queue] Marked appointment ${current.id} as DONE`);
  }

  // Find next CHECKED_IN patient (lowest token number) for this clinic
  const nextResult = await query(
    `SELECT a.*, p.name AS patient_name, p.phone AS patient_phone, p.fcm_token
     FROM appointments a
     JOIN patients p ON a.patient_id = p.id
     WHERE a.clinic_id = $1
       AND a.appointment_date = $2
       AND a.status = 'CHECKED_IN'
     ORDER BY a.token_number ASC
     LIMIT 1`,
    [clinicId, today]
  );

  if (nextResult.rows.length === 0) {
    throw createError('No checked-in patients in the queue', 404);
  }

  const next = nextResult.rows[0];
  assertValidTransition('CHECKED_IN', 'IN_CONSULTATION');

  await query(
    `UPDATE appointments
     SET status = 'IN_CONSULTATION', called_at = NOW(), doctor_id = $2
     WHERE id = $1`,
    [next.id, staffId]
  );

  // Broadcast to this clinic only
  const queueSnapshot = await getTodayQueue(clinicId);
  broadcastToClinic(clinicId, 'queue:updated', { queue: queueSnapshot });

  // Notify the specific patient
  broadcastToPatient(next.patient_id, 'patient:called', {
    appointmentId: next.id,
    tokenNumber: next.token_number,
    message: 'Your turn has arrived. Please proceed to the consultation room.',
  });

  console.log(`[Queue] Doctor ${staffId} (clinic ${clinicId}) called patient token #${next.token_number} (appt ${next.id})`);

  return { ...next, status: 'IN_CONSULTATION', called_at: new Date() };
}

/**
 * Skip a specific patient in the queue.
 *
 * @param {number} appointmentId
 * @param {number} clinicId
 * @returns {Promise<Object>} Updated appointment
 */
async function skipPatient(appointmentId, clinicId) {
  const apptResult = await query(
    `SELECT a.*, p.name AS patient_name
     FROM appointments a
     JOIN patients p ON a.patient_id = p.id
     WHERE a.id = $1 AND a.clinic_id = $2`,
    [appointmentId, clinicId]
  );

  if (apptResult.rows.length === 0) {
    throw createError('Appointment not found', 404);
  }

  const appt = apptResult.rows[0];
  assertValidTransition(appt.status, 'SKIPPED');

  await query(
    `UPDATE appointments SET status = 'SKIPPED' WHERE id = $1`,
    [appointmentId]
  );

  const updated = { ...appt, status: 'SKIPPED' };

  // Broadcast updated queue to this clinic only
  const queueSnapshot = await getTodayQueue(clinicId);
  broadcastToClinic(clinicId, 'queue:updated', { queue: queueSnapshot });

  broadcastToPatient(appt.patient_id, 'queue:updated', {
    appointmentId: appt.id,
    status: 'SKIPPED',
    message: 'Your token was skipped. Please check with the receptionist.',
  });

  console.log(`[Queue] Skipped appointment ${appointmentId} (clinic ${clinicId})`);
  return updated;
}

/**
 * Calculate the rolling average consultation time from the last 5 completed
 * consultations today for a specific clinic.
 *
 * @param {number} clinicId
 * @returns {Promise<number>} Average consultation time in minutes
 */
async function getRollingAvgConsultTime(clinicId) {
  const today = new Date().toISOString().split('T')[0];

  const result = await query(
    `SELECT called_at, completed_at
     FROM appointments
     WHERE clinic_id = $1
       AND appointment_date = $2
       AND status IN ('DONE', 'DISPENSED')
       AND called_at IS NOT NULL
       AND completed_at IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 5`,
    [clinicId, today]
  );

  if (result.rows.length < 5) {
    return 10; // Default: 10 minutes
  }

  let totalMs = 0;
  for (const row of result.rows) {
    const duration = new Date(row.completed_at) - new Date(row.called_at);
    totalMs += duration;
  }

  const avgMinutes = totalMs / result.rows.length / (1000 * 60);
  return Math.max(5, Math.round(avgMinutes));
}

module.exports = {
  getTodayQueue,
  callNextPatient,
  skipPatient,
  getRollingAvgConsultTime,
};
