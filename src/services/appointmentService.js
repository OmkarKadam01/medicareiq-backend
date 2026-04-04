'use strict';

const { query, getClient } = require('../db');
const { createError }      = require('../middleware/errorHandler');

/**
 * Valid appointment status transitions.
 * Key: current status → Value: array of allowed next statuses
 */
const VALID_TRANSITIONS = {
  BOOKED:           ['CHECK_IN_WINDOW', 'CHECKED_IN', 'CANCELLED', 'EXPIRED'],
  CHECK_IN_WINDOW:  ['CHECKED_IN', 'CANCELLED', 'EXPIRED'],
  CHECKED_IN:       ['IN_CONSULTATION', 'SKIPPED'],
  IN_CONSULTATION:  ['DONE'],
  DONE:             ['DISPENSED'],
  DISPENSED:        [],
  CANCELLED:        [],
  SKIPPED:          [],
  EXPIRED:          [],
};

/**
 * Assert a status transition is valid; throws 400 if not.
 */
function assertValidTransition(currentStatus, nextStatus) {
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(nextStatus)) {
    throw createError(
      `Invalid status transition: ${currentStatus} → ${nextStatus}. Allowed: ${allowed.join(', ') || 'none'}`,
      400
    );
  }
}

/**
 * Ensure we have a clinic configuration; create default row if missing.
 * @returns {Promise<Object>} clinic_config row
 */
async function getOrCreateClinicConfig(clinicId = 1) {
  const configResult = await query(
    'SELECT * FROM clinic_config WHERE clinic_id = $1 LIMIT 1',
    [clinicId]
  );
  if (configResult.rows.length > 0) {
    return configResult.rows[0];
  }

  const defaultConfig = {
    clinic_name: 'MedicareIQ Clinic',
    opening_time: '09:00:00',
    closing_time: '17:00:00',
    slot_duration_minutes: 15,
    max_patients_per_slot: 3,
    geofence_lat: 19.01325,
    geofence_lng: 72.8482,
    geofence_radius_meters: 200,
    checkin_window_minutes: 30,
    is_open: true,
  };

  await query(
    `INSERT INTO clinic_config (
      clinic_id,
      clinic_name,
      opening_time,
      closing_time,
      slot_duration_minutes,
      max_patients_per_slot,
      geofence_lat,
      geofence_lng,
      geofence_radius_meters,
      checkin_window_minutes,
      is_open
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT DO NOTHING`,
    [
      clinicId,
      defaultConfig.clinic_name,
      defaultConfig.opening_time,
      defaultConfig.closing_time,
      defaultConfig.slot_duration_minutes,
      defaultConfig.max_patients_per_slot,
      defaultConfig.geofence_lat,
      defaultConfig.geofence_lng,
      defaultConfig.geofence_radius_meters,
      defaultConfig.checkin_window_minutes,
      defaultConfig.is_open,
    ]
  );

  const created = await query(
    'SELECT * FROM clinic_config WHERE clinic_id = $1 LIMIT 1',
    [clinicId]
  );
  if (created.rows.length === 0) {
    throw createError('Clinic configuration not found', 500);
  }

  return created.rows[0];
}

/**
 * Generate an array of time slots for a given date based on clinic config.
 * @param {Object} config - clinic_config row
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {string[]} Array of 'HH:MM' slot times
 */
function generateTimeSlots(config) {
  const slots = [];
  const [openH, openM] = config.opening_time.split(':').map(Number);
  const [closeH, closeM] = config.closing_time.split(':').map(Number);

  let current = openH * 60 + openM;
  const closing = closeH * 60 + closeM;
  const duration = config.slot_duration_minutes;

  while (current + duration <= closing) {
    const h = String(Math.floor(current / 60)).padStart(2, '0');
    const m = String(current % 60).padStart(2, '0');
    slots.push(`${h}:${m}`);
    current += duration;
  }

  return slots;
}

/**
 * Get available appointment slots for a given date.
 *
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {Promise<Array<{ slotTime: string, availableCount: number }>>}
 */
async function getAvailableSlots(date, clinicId = 1) {
  const config = await getOrCreateClinicConfig(clinicId);

  if (!config.is_open) {
    return [];
  }

  // Get all active bookings for that date scoped to this clinic
  const bookedResult = await query(
    `SELECT slot_time, COUNT(*) as booked_count
     FROM appointments
     WHERE clinic_id = $1
       AND appointment_date = $2
       AND status NOT IN ('CANCELLED', 'EXPIRED')
     GROUP BY slot_time`,
    [clinicId, date]
  );

  const bookedMap = {};
  for (const row of bookedResult.rows) {
    // Normalize slot_time: pg returns time as 'HH:MM:SS', trim to 'HH:MM'
    const slotKey = row.slot_time.substring(0, 5);
    bookedMap[slotKey] = parseInt(row.booked_count, 10);
  }

  const allSlots = generateTimeSlots(config);
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const available = [];
  for (const slotTime of allSlots) {
    // Skip past slots if date is today
    if (date === today) {
      const [slotH, slotM] = slotTime.split(':').map(Number);
      if (slotH * 60 + slotM <= currentMinutes) {
        continue;
      }
    }

    const booked = bookedMap[slotTime] || 0;
    const availableCount = config.max_patients_per_slot - booked;

    if (availableCount > 0) {
      available.push({ slotTime, availableCount });
    }
  }

  return available;
}

/**
 * Book an appointment for a patient.
 * Uses a database transaction with SELECT FOR UPDATE to prevent race conditions.
 *
 * @param {number} patientId
 * @param {string} date     - 'YYYY-MM-DD'
 * @param {string} slotTime - 'HH:MM'
 * @returns {Promise<Object>} The created appointment row
 */
async function bookAppointment(patientId, date, slotTime, clinicId = 1) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Verify slot capacity — scoped to this clinic
    const lockResult = await client.query(
      `SELECT COUNT(*) as booked_count
       FROM appointments
       WHERE clinic_id = $1
         AND appointment_date = $2
         AND slot_time = $3
         AND status NOT IN ('CANCELLED', 'EXPIRED')`,
      [clinicId, date, slotTime]
    );

    const bookedCount = parseInt(lockResult.rows[0].booked_count, 10);

    const config = await getOrCreateClinicConfig(clinicId);

    if (!config.is_open) {
      throw createError('Clinic is currently closed', 400);
    }

    if (bookedCount >= config.max_patients_per_slot) {
      throw createError('This time slot is fully booked', 409);
    }

    // Check for duplicate booking scoped to this clinic
    const duplicateResult = await client.query(
      `SELECT id FROM appointments
       WHERE clinic_id = $1
         AND patient_id = $2
         AND appointment_date = $3
         AND status NOT IN ('CANCELLED', 'EXPIRED', 'DONE', 'DISPENSED', 'SKIPPED')
       LIMIT 1`,
      [clinicId, patientId, date]
    );

    if (duplicateResult.rows.length > 0) {
      throw createError('You already have an active appointment on this date', 409);
    }

    // Atomic token assignment — avoids MAX+1 race condition.
    // UPSERT into token_counters then increment atomically.
    const tokenResult = await client.query(
      `INSERT INTO token_counters (clinic_id, date, last_token)
       VALUES ($1, $2, 1)
       ON CONFLICT (clinic_id, date) DO UPDATE
         SET last_token = token_counters.last_token + 1
       RETURNING last_token`,
      [clinicId, date]
    );

    const tokenNumber = parseInt(tokenResult.rows[0].last_token, 10);

    // Insert the appointment
    const insertResult = await client.query(
      `INSERT INTO appointments (clinic_id, patient_id, appointment_date, slot_time, token_number, status)
       VALUES ($1, $2, $3, $4, $5, 'BOOKED')
       RETURNING *`,
      [clinicId, patientId, date, slotTime, tokenNumber]
    );

    await client.query('COMMIT');

    const appointment = insertResult.rows[0];
    console.log(
      `[Appointment] Booked: clinic=${clinicId}, patient=${patientId}, date=${date}, slot=${slotTime}, token=${tokenNumber}`
    );
    return appointment;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Cancel an appointment.
 * Only allowed if slot is more than 30 minutes away.
 *
 * @param {number} appointmentId
 * @param {number} patientId - Must match appointment's patient_id
 * @returns {Promise<Object>} Updated appointment row
 */
async function cancelAppointment(appointmentId, patientId, clinicId = 1) {
  const result = await query(
    `SELECT a.*, cc.checkin_window_minutes
     FROM appointments a
     JOIN clinic_config cc ON cc.clinic_id = a.clinic_id
     WHERE a.id = $1 AND a.clinic_id = $2`,
    [appointmentId, clinicId]
  );

  if (result.rows.length === 0) {
    throw createError('Appointment not found', 404);
  }

  const appt = result.rows[0];

  if (appt.patient_id !== patientId) {
    throw createError('You can only cancel your own appointments', 403);
  }

  assertValidTransition(appt.status, 'CANCELLED');

  // Check timing: must be >30 min before slot time
  const slotDateTime = new Date(`${appt.appointment_date.toISOString().split('T')[0]}T${appt.slot_time}`);
  const now = new Date();
  const minutesUntilSlot = (slotDateTime - now) / (1000 * 60);

  if (minutesUntilSlot <= 30) {
    throw createError(
      'Cannot cancel appointment less than 30 minutes before the scheduled slot',
      400
    );
  }

  const updateResult = await query(
    `UPDATE appointments
     SET status = 'CANCELLED'
     WHERE id = $1
     RETURNING *`,
    [appointmentId]
  );

  return updateResult.rows[0];
}

/**
 * Get upcoming and past appointments for a patient.
 *
 * @param {number} patientId
 * @returns {Promise<Object>} { upcoming: [], history: [] }
 */
async function getPatientAppointments(patientId) {
  const today = new Date().toISOString().split('T')[0];

  const result = await query(
    `SELECT id, appointment_date, slot_time, token_number, status, called_at, completed_at, notes, created_at
     FROM appointments
     WHERE patient_id = $1
     ORDER BY appointment_date DESC, slot_time DESC`,
    [patientId]
  );

  const upcoming = [];
  const history  = [];

  for (const row of result.rows) {
    const dateStr = row.appointment_date.toISOString().split('T')[0];
    if (
      dateStr >= today &&
      !['CANCELLED', 'EXPIRED', 'DONE', 'DISPENSED', 'SKIPPED'].includes(row.status)
    ) {
      upcoming.push(row);
    } else {
      history.push(row);
    }
  }

  return { upcoming, history };
}

/**
 * Get queue status for a specific appointment.
 * Returns position, tokens ahead, and estimated wait time.
 *
 * @param {number} appointmentId
 * @param {number} patientId
 * @returns {Promise<Object>}
 */
async function getQueueStatus(appointmentId, patientId) {
  const result = await query(
    `SELECT * FROM appointments WHERE id = $1`,
    [appointmentId]
  );

  if (result.rows.length === 0) {
    throw createError('Appointment not found', 404);
  }

  const appt = result.rows[0];

  if (appt.patient_id !== patientId) {
    throw createError('Access denied', 403);
  }

  if (['CANCELLED', 'EXPIRED'].includes(appt.status)) {
    throw createError('Appointment is not active', 400);
  }

  const dateStr = appt.appointment_date.toISOString().split('T')[0];

  const clinicId = appt.clinic_id;

  // Count patients ahead in queue scoped to this clinic
  const aheadResult = await query(
    `SELECT COUNT(*) as tokens_ahead
     FROM appointments
     WHERE clinic_id = $1
       AND appointment_date = $2
       AND status IN ('CHECKED_IN', 'IN_CONSULTATION')
       AND token_number < $3`,
    [clinicId, dateStr, appt.token_number]
  );

  const inConsultResult = await query(
    `SELECT COUNT(*) as in_consult
     FROM appointments
     WHERE clinic_id = $1
       AND appointment_date = $2
       AND status = 'IN_CONSULTATION'`,
    [clinicId, dateStr]
  );

  const tokensAhead = parseInt(aheadResult.rows[0].tokens_ahead, 10);
  const inConsult   = parseInt(inConsultResult.rows[0].in_consult, 10);

  const { getRollingAvgConsultTime } = require('./queueService');
  const avgConsultMin = await getRollingAvgConsultTime(clinicId);

  const estimatedWaitMins = Math.round((tokensAhead + inConsult) * avgConsultMin);

  const currentTokenResult = await query(
    `SELECT COALESCE(MAX(token_number), 0) AS current_token
     FROM appointments
     WHERE clinic_id = $1
       AND appointment_date = $2
       AND status = 'IN_CONSULTATION'`,
    [clinicId, dateStr]
  );
  const currentToken = parseInt(currentTokenResult.rows[0].current_token, 10);

  return {
    appointmentId,
    tokenNumber:   appt.token_number,
    status:        appt.status,
    position:      tokensAhead + 1,
    tokensAhead,
    currentToken,
    estimatedWaitMins,
    avgConsultMins: avgConsultMin,
  };
}

/**
 * Expire old appointments.
 * Called by a periodic cron every 60 seconds.
 * Marks BOOKED or CHECK_IN_WINDOW appointments past their slot time as EXPIRED.
 *
 * @returns {Promise<number>} Number of appointments expired
 */
async function expireOldAppointments() {
  // clinic_id-agnostic: expires across all clinics (cron job context)
  const result = await query(
    `UPDATE appointments
     SET status = 'EXPIRED'
     WHERE status IN ('BOOKED', 'CHECK_IN_WINDOW')
       AND (appointment_date + slot_time::interval) < NOW() - INTERVAL '5 minutes'
     RETURNING id, clinic_id`,
    []
  );

  const count = result.rowCount;
  if (count > 0) {
    console.log(`[Appointment] Expired ${count} old appointment(s)`);
  }
  return count;
}

module.exports = {
  getAvailableSlots,
  bookAppointment,
  cancelAppointment,
  getPatientAppointments,
  getQueueStatus,
  expireOldAppointments,
  assertValidTransition,
  generateTimeSlots,
};
