'use strict';

const { query }                  = require('../db');
const { createError }            = require('../middleware/errorHandler');
const { haversineDistance }      = require('../utils/haversine');
const { broadcastToPatient, broadcastToClinic } = require('../websocket');
const { assertValidTransition }  = require('./appointmentService');
const { getTodayQueue }          = require('./queueService');

/**
 * Validate and process a patient check-in request.
 *
 * Validation steps:
 * 1. Appointment exists and belongs to the patient
 * 2. Status is BOOKED or CHECK_IN_WINDOW
 * 3. Current time is within the check-in window (slot_time - checkin_window_minutes to slot_time + 15min)
 * 4. Patient is within geofence (distance ≤ radius * 1.5 for GPS tolerance)
 * 5. Update status to CHECKED_IN
 * 6. Broadcast updates
 *
 * @param {number} appointmentId
 * @param {number} patientId
 * @param {number} lat  - Patient's current latitude
 * @param {number} lng  - Patient's current longitude
 * @returns {Promise<Object>} Check-in result
 */
async function validateCheckin(appointmentId, patientId, lat, lng) {
  // Validate input
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw createError('Invalid coordinates: lat and lng must be numbers', 400);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw createError('Invalid coordinates: lat must be -90 to 90, lng must be -180 to 180', 400);
  }

  // Fetch appointment + clinic config in one query
  const result = await query(
    `SELECT
       a.id,
       a.patient_id,
       a.appointment_date,
       a.slot_time,
       a.token_number,
       a.status,
       cc.geofence_lat,
       cc.geofence_lng,
       cc.geofence_radius_meters,
       cc.checkin_window_minutes,
       cc.is_open
     FROM appointments a
     CROSS JOIN clinic_config cc
     WHERE a.id = $1
     LIMIT 1`,
    [appointmentId]
  );

  if (result.rows.length === 0) {
    throw createError('Appointment not found', 404);
  }

  const appt = result.rows[0];

  // Verify ownership
  if (appt.patient_id !== patientId) {
    throw createError('This appointment does not belong to you', 403);
  }

  // Verify clinic is open
  if (!appt.is_open) {
    throw createError('Clinic is currently closed', 400);
  }

  // Verify status is checkable
  if (!['BOOKED', 'CHECK_IN_WINDOW'].includes(appt.status)) {
    if (appt.status === 'CHECKED_IN') {
      throw createError('You are already checked in', 409);
    }
    assertValidTransition(appt.status, 'CHECKED_IN'); // Will throw descriptive error
  }

  // Verify timing window
  const dateStr      = appt.appointment_date.toISOString().split('T')[0];
  const slotDateTime = new Date(`${dateStr}T${appt.slot_time}`);
  const now          = new Date();

  const windowOpenMs  = appt.checkin_window_minutes * 60 * 1000;
  const windowCloseMs = 15 * 60 * 1000; // Allow check-in up to 15 min after slot

  const windowStart = new Date(slotDateTime.getTime() - windowOpenMs);
  const windowEnd   = new Date(slotDateTime.getTime() + windowCloseMs);

  if (now < windowStart) {
    const minutesUntilOpen = Math.round((windowStart - now) / (1000 * 60));
    throw createError(
      `Check-in window opens in ${minutesUntilOpen} minute(s). ` +
      `You can check in from ${windowStart.toLocaleTimeString()}.`,
      400
    );
  }

  if (now > windowEnd) {
    throw createError(
      'Check-in window has closed for this slot. The appointment may have expired.',
      400
    );
  }

  // Verify geofence: distance must be ≤ radius * 1.5 (50% tolerance for GPS inaccuracy)
  const clinicLat    = parseFloat(appt.geofence_lat);
  const clinicLng    = parseFloat(appt.geofence_lng);
  const radiusMeters = appt.geofence_radius_meters;
  const maxDistance  = radiusMeters * 1.5;

  const distanceMeters = haversineDistance(lat, lng, clinicLat, clinicLng);

  if (distanceMeters > maxDistance) {
    throw createError(
      `You are too far from the clinic to check in. ` +
      `You are ${Math.round(distanceMeters)}m away. ` +
      `Maximum allowed distance: ${Math.round(maxDistance)}m.`,
      400
    );
  }

  // All checks passed — update status to CHECKED_IN
  const updateResult = await query(
    `UPDATE appointments
     SET status = 'CHECKED_IN'
     WHERE id = $1
     RETURNING *`,
    [appointmentId]
  );

  const updatedAppt = updateResult.rows[0];

  // Broadcast to clinic (queue updated)
  const queueSnapshot = await getTodayQueue();
  broadcastToClinic('queue:updated', { queue: queueSnapshot });

  // Confirm to patient
  broadcastToPatient(patientId, 'checkin:confirmed', {
    appointmentId,
    tokenNumber:  appt.token_number,
    distanceMeters: Math.round(distanceMeters),
    message:      'Check-in successful! Please wait for your token to be called.',
  });

  console.log(
    `[Geofence] Patient ${patientId} checked in for appointment ${appointmentId}. ` +
    `Distance: ${Math.round(distanceMeters)}m / ${Math.round(maxDistance)}m allowed.`
  );

  return {
    success: true,
    appointment: updatedAppt,
    distanceMeters: Math.round(distanceMeters),
    maxAllowedMeters: Math.round(maxDistance),
  };
}

module.exports = { validateCheckin };
