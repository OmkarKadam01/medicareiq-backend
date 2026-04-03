'use strict';

const jwt      = require('jsonwebtoken');
const admin    = require('firebase-admin');

const ACCESS_TOKEN_EXPIRY  = '1h';
const REFRESH_TOKEN_EXPIRY = '30d';

/**
 * Verify a Firebase ID token (used for patient phone-OTP login).
 * Returns the phone number associated with the token.
 *
 * @param {string} idToken - Firebase ID token from the client
 * @returns {Promise<string>} Phone number in E.164 format (e.g. '+911234567890')
 * @throws {Error} If token is invalid or Firebase is not initialized
 */
async function verifyFirebaseToken(idToken) {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin SDK is not initialized');
  }

  const decodedToken = await admin.auth().verifyIdToken(idToken);

  if (!decodedToken.phone_number) {
    throw new Error('Firebase token does not contain a phone number');
  }

  return decodedToken.phone_number;
}

/**
 * Generate a JWT access + refresh token pair.
 *
 * @param {Object} payload - Data to embed in the token
 *   For patients: { id, type: 'patient' }
 *   For staff:    { id, type: 'staff', role }
 * @returns {{ accessToken: string, refreshToken: string }}
 */
function generateTokens(payload) {
  const jwtSecret        = process.env.JWT_SECRET;
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;

  if (!jwtSecret || !jwtRefreshSecret) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in environment');
  }

  const accessToken = jwt.sign(payload, jwtSecret, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
    issuer: 'medicareiq-backend',
    audience: 'medicareiq-app',
  });

  const refreshToken = jwt.sign(payload, jwtRefreshSecret, {
    expiresIn: REFRESH_TOKEN_EXPIRY,
    issuer: 'medicareiq-backend',
    audience: 'medicareiq-app',
  });

  return { accessToken, refreshToken };
}

/**
 * Verify a JWT access token.
 *
 * @param {string} token
 * @returns {Object} Decoded payload
 * @throws {jwt.TokenExpiredError | jwt.JsonWebTokenError}
 */
function verifyAccessToken(token) {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET must be set in environment');
  }

  return jwt.verify(token, jwtSecret, {
    issuer: 'medicareiq-backend',
    audience: 'medicareiq-app',
  });
}

/**
 * Verify a JWT refresh token.
 *
 * @param {string} token
 * @returns {Object} Decoded payload
 * @throws {jwt.TokenExpiredError | jwt.JsonWebTokenError}
 */
function verifyRefreshToken(token) {
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET;
  if (!jwtRefreshSecret) {
    throw new Error('JWT_REFRESH_SECRET must be set in environment');
  }

  return jwt.verify(token, jwtRefreshSecret, {
    issuer: 'medicareiq-backend',
    audience: 'medicareiq-app',
  });
}

module.exports = {
  verifyFirebaseToken,
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
};
