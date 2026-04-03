'use strict';

const express = require('express');
const router  = express.Router();

const { authenticateStaff, requireRole } = require('../middleware/auth');
const { apiLimiter }                     = require('../middleware/rateLimiter');
const { query }                          = require('../db');

// Map raw DB drug row to the camelCase shape the clinic app expects
function mapDrug(row) {
  return {
    id:               String(row.id),
    name:             row.name,
    genericName:      row.generic_name || null,
    form:             row.unit || 'tablet',
    defaultDose:      null,
    defaultFrequency: null,
    isActive:         row.is_active,
  };
}

// All drug routes require staff auth
router.use(authenticateStaff);
router.use(apiLimiter);

/**
 * GET /drugs
 *
 * List all active drugs.
 * All staff roles can view.
 * Supports optional ?search=name query param.
 */
router.get('/', async (req, res, next) => {
  try {
    const { search } = req.query;

    let sql;
    let params;

    if (search) {
      sql = `SELECT id, name, generic_name, category, unit, stock_quantity, is_active, created_at
             FROM drugs
             WHERE is_active = TRUE
               AND (name ILIKE $1 OR generic_name ILIKE $1 OR category ILIKE $1)
             ORDER BY name ASC`;
      params = [`%${search}%`];
    } else {
      sql = `SELECT id, name, generic_name, category, unit, stock_quantity, is_active, created_at
             FROM drugs
             WHERE is_active = TRUE
             ORDER BY name ASC`;
      params = [];
    }

    const result = await query(sql, params);
    return res.status(200).json(result.rows.map(mapDrug));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /drugs
 *
 * Add a new drug to the formulary.
 * Doctor or admin only.
 *
 * Body: { name, genericName?, category?, unit?, stockQuantity? }
 */
router.post('/', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const { name, genericName, category, unit, stockQuantity } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const result = await query(
      `INSERT INTO drugs (name, generic_name, category, unit, stock_quantity, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING *`,
      [
        name,
        genericName    || null,
        category       || null,
        unit           || 'tablet',
        stockQuantity  != null ? parseInt(stockQuantity, 10) : 0,
      ]
    );

    return res.status(201).json(mapDrug(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /drugs/:id
 *
 * Update an existing drug.
 * Doctor or admin only.
 *
 * Body: { name?, genericName?, category?, unit?, stockQuantity? }
 */
router.put('/:id', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const drugId = parseInt(req.params.id, 10);
    if (isNaN(drugId)) {
      return res.status(400).json({ error: 'Invalid drug ID' });
    }

    const { name, genericName, category, unit, stockQuantity } = req.body;

    // Build update dynamically — only update provided fields
    const updates  = [];
    const values   = [];
    let   paramIdx = 2; // $1 = id

    if (name !== undefined) {
      updates.push(`name = $${paramIdx++}`);
      values.push(name);
    }
    if (genericName !== undefined) {
      updates.push(`generic_name = $${paramIdx++}`);
      values.push(genericName);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramIdx++}`);
      values.push(category);
    }
    if (unit !== undefined) {
      updates.push(`unit = $${paramIdx++}`);
      values.push(unit);
    }
    if (stockQuantity !== undefined) {
      updates.push(`stock_quantity = $${paramIdx++}`);
      values.push(parseInt(stockQuantity, 10));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields provided to update' });
    }

    const result = await query(
      `UPDATE drugs SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1 AND is_active = TRUE RETURNING *`,
      [drugId, ...values]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drug not found or already deactivated' });
    }

    return res.status(200).json(mapDrug(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /drugs/:id
 *
 * Soft-delete (deactivate) a drug.
 * Doctor or admin only.
 * The drug is not removed from the DB — only is_active set to FALSE.
 * This preserves historical prescription records.
 */
router.delete('/:id', requireRole('doctor', 'admin'), async (req, res, next) => {
  try {
    const drugId = parseInt(req.params.id, 10);
    if (isNaN(drugId)) {
      return res.status(400).json({ error: 'Invalid drug ID' });
    }

    const result = await query(
      `UPDATE drugs
       SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND is_active = TRUE
       RETURNING id, name, is_active`,
      [drugId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Drug not found or already deactivated' });
    }

    return res.status(200).json({
      message: 'Drug deactivated successfully',
      drug: result.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
