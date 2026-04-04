'use strict';

const express   = require('express');
const bcrypt    = require('bcryptjs');
const router    = express.Router();

const { query }              = require('../db');
const { authLimiter }        = require('../middleware/rateLimiter');
const {
  verifyFirebaseToken,
  generateTokens,
  verifyRefreshToken,
}                            = require('../services/authService');

/**
 * POST /auth/patient/verify-otp
 *
 * Verify a Firebase Phone Auth ID token.
 * Upserts the patient record (creates on first login, updates fcm_token).
 * Returns JWT access + refresh token pair.
 *
 * Body: { idToken: string, fcmToken?: string, name?: string }
 */
router.post('/patient/verify-otp', authLimiter, async (req, res, next) => {
  try {
    const { idToken, fcmToken, name } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    // Verify the Firebase ID token and extract phone number
    let phoneNumber;
    try {
      phoneNumber = await verifyFirebaseToken(idToken);
    } catch (firebaseErr) {
      return res.status(401).json({ error: 'Invalid Firebase token: ' + firebaseErr.message });
    }

    // Upsert patient: create if new, update fcm_token and name if provided
    const upsertResult = await query(
      `INSERT INTO patients (phone, name, fcm_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET
         fcm_token  = COALESCE(EXCLUDED.fcm_token, patients.fcm_token),
         name       = COALESCE(EXCLUDED.name, patients.name),
         updated_at = NOW()
       RETURNING id, phone, name, date_of_birth, gender, blood_group`,
      [phoneNumber, name || null, fcmToken || null]
    );

    const patient = upsertResult.rows[0];
    const tokens  = generateTokens({ id: patient.id, type: 'patient', phone: patient.phone });

    console.log(`[Auth] Patient login: id=${patient.id}, phone=${phoneNumber}`);

    return res.status(200).json({
      patient,
      ...tokens,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/staff/login
 *
 * Authenticate a staff member with username + password.
 * Returns JWT access + refresh token pair.
 *
 * Body: { username: string, password: string, fcmToken?: string }
 */
router.post('/staff/login', authLimiter, async (req, res, next) => {
  try {
    const { username, password, fcmToken } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    // Fetch staff member
    const result = await query(
      `SELECT id, username, password_hash, name, role, is_active, clinic_id
       FROM staff
       WHERE username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const staff = result.rows[0];

    if (!staff.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated' });
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, staff.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update fcm_token if provided
    if (fcmToken) {
      await query(
        `UPDATE staff SET fcm_token = $1, updated_at = NOW() WHERE id = $2`,
        [fcmToken, staff.id]
      );
    }

    const tokens = generateTokens({ id: staff.id, type: 'staff', role: staff.role, clinicId: staff.clinic_id });

    console.log(`[Auth] Staff login: id=${staff.id}, username=${staff.username}, role=${staff.role}, clinic=${staff.clinic_id}`);

    return res.status(200).json({
      staff: {
        id:       staff.id,
        username: staff.username,
        name:     staff.name,
        role:     staff.role,
        clinicId: staff.clinic_id,
      },
      ...tokens,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/refresh
 *
 * Exchange a valid refresh token for a new access token.
 *
 * Body: { refreshToken: string }
 */
router.post('/refresh', authLimiter, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Refresh token expired. Please log in again.' });
      }
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Build a new payload from the decoded refresh token
    const payload = { id: decoded.id, type: decoded.type };
    if (decoded.role) payload.role = decoded.role;
    if (decoded.phone) payload.phone = decoded.phone;

    const { accessToken } = generateTokens(payload);

    return res.status(200).json({ accessToken });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
