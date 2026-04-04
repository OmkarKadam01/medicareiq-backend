'use strict';

/**
 * Run with: node scripts/create-staff.js
 * Creates/updates staff accounts with proper bcrypt hashes.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { query } = require('../src/db');

const staff = [
  { username: 'doctor1',     password: 'doctor123',     name: 'Dr. Rajesh Kumar', role: 'doctor'     },
  { username: 'compounder1', password: 'compounder123', name: 'Ravi Sharma',      role: 'compounder' },
  { username: 'admin',       password: 'admin123',      name: 'Admin',            role: 'admin'      },
];

async function main() {
  for (const s of staff) {
    const hash = await bcrypt.hash(s.password, 10);
    await query(
      `INSERT INTO staff (username, password_hash, name, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (username) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         name          = EXCLUDED.name,
         role          = EXCLUDED.role,
         is_active     = true`,
      [s.username, hash, s.name, s.role]
    );
    console.log(`✓ ${s.role.padEnd(12)} ${s.username} / ${s.password}`);
  }
  console.log('\nDone. Use credentials above to log in.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
