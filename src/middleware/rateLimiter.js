'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Auth rate limiter: 10 requests per minute per IP.
 * Applied to login and OTP verification endpoints.
 */
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many authentication attempts. Please try again after 1 minute.',
    });
  },
  skip: (req) => process.env.NODE_ENV === 'test',
});

/**
 * General API rate limiter: 100 requests per minute per IP.
 * Applied to all authenticated API endpoints.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Key by authenticated user id when available, else by IP
    if (req.patientId) return `patient:${req.patientId}`;
    if (req.staffId) return `staff:${req.staffId}`;
    return req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded. Maximum 100 requests per minute.',
    });
  },
  skip: (req) => process.env.NODE_ENV === 'test',
});

module.exports = { authLimiter, apiLimiter };
