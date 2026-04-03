'use strict';

/**
 * PostgreSQL error codes
 */
const PG_UNIQUE_VIOLATION       = '23505';
const PG_FOREIGN_KEY_VIOLATION  = '23503';
const PG_NOT_NULL_VIOLATION     = '23502';
const PG_CHECK_VIOLATION        = '23514';

/**
 * Global Express error-handling middleware.
 * Must be registered as the LAST middleware (after all routes).
 *
 * @param {Error}           err
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  // PostgreSQL-specific errors
  if (err.code === PG_UNIQUE_VIOLATION) {
    const detail = err.detail || 'A record with this value already exists';
    return res.status(409).json({ error: 'Conflict: ' + detail });
  }

  if (err.code === PG_FOREIGN_KEY_VIOLATION) {
    const detail = err.detail || 'Referenced record does not exist';
    return res.status(400).json({ error: 'Bad Request: ' + detail });
  }

  if (err.code === PG_NOT_NULL_VIOLATION) {
    return res.status(400).json({ error: `Bad Request: Required field '${err.column}' is missing` });
  }

  if (err.code === PG_CHECK_VIOLATION) {
    return res.status(400).json({ error: 'Bad Request: Value violates database constraint' });
  }

  // JWT errors (should normally be caught in auth middleware, but belt-and-suspenders)
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired' });
  }
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Application-level errors with explicit status codes
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Fallback: 500 Internal Server Error
  // Don't leak internal details to clients in production
  const message =
    process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message;

  return res.status(500).json({ error: message });
}

/**
 * Helper: create an error with a specific HTTP status code.
 * @param {string} message
 * @param {number} statusCode
 */
function createError(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

module.exports = { errorHandler, createError };
