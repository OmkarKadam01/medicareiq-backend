'use strict';

const { verifyAccessToken } = require('../services/authService');

/**
 * Middleware: verify JWT for patient requests.
 * Sets req.patientId on success.
 */
async function authenticatePatient(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const token = authHeader.slice(7);
    const decoded = await verifyAccessToken(token);

    if (decoded.type !== 'patient') {
      return res.status(403).json({ error: 'Token is not a patient token' });
    }

    req.patientId = decoded.id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    next(err);
  }
}

/**
 * Middleware: verify JWT for staff requests.
 * Sets req.staffId and req.staffRole on success.
 */
async function authenticateStaff(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const token = authHeader.slice(7);
    const decoded = await verifyAccessToken(token);

    if (decoded.type !== 'staff') {
      return res.status(403).json({ error: 'Token is not a staff token' });
    }

    req.staffId   = decoded.id;
    req.staffRole = decoded.role;
    req.clinicId  = decoded.clinicId ?? 1;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    next(err);
  }
}

/**
 * Middleware factory: check that authenticated staff has one of the allowed roles.
 * Must be used AFTER authenticateStaff.
 * @param {...string} roles - Allowed roles (e.g. 'doctor', 'compounder')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staffRole) {
      return res.status(403).json({ error: 'Staff authentication required' });
    }
    if (!roles.includes(req.staffRole)) {
      return res.status(403).json({
        error: `Access denied. Required role(s): ${roles.join(', ')}. Your role: ${req.staffRole}`,
      });
    }
    next();
  };
}

module.exports = { authenticatePatient, authenticateStaff, requireRole };
