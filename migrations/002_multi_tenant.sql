-- MedicareIQ Multi-Tenant Migration
-- Version: 002
-- Description: Adds clinic_id isolation, doctor_id on appointments/visits,
--              and atomic token_counters table to fix race conditions.
--
-- Safe to run on existing single-clinic data: all existing rows are assigned
-- to clinic_id = 1 (the default clinic seeded below).

BEGIN;

-- ============================================================
-- CLINICS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS clinics (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) NOT NULL DEFAULT 'MedicareIQ Clinic',
    phone       VARCHAR(20),
    address     TEXT,
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the default clinic so existing rows can reference it
INSERT INTO clinics (id, name, is_active)
VALUES (1, 'MedicareIQ Clinic', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Keep the sequence in sync
SELECT setval('clinics_id_seq', GREATEST(1, (SELECT MAX(id) FROM clinics)));

-- ============================================================
-- ADD clinic_id TO EXISTING TABLES
-- (nullable first, fill existing rows, then add NOT NULL)
-- ============================================================

-- staff
ALTER TABLE staff ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinics(id);
UPDATE staff SET clinic_id = 1 WHERE clinic_id IS NULL;
ALTER TABLE staff ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE staff ALTER COLUMN clinic_id SET DEFAULT 1;

-- clinic_config
ALTER TABLE clinic_config ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinics(id);
UPDATE clinic_config SET clinic_id = 1 WHERE clinic_id IS NULL;
ALTER TABLE clinic_config ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE clinic_config ALTER COLUMN clinic_id SET DEFAULT 1;

-- appointments: add clinic_id and doctor_id
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS clinic_id  INTEGER REFERENCES clinics(id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS doctor_id  INTEGER REFERENCES staff(id);
UPDATE appointments SET clinic_id = 1 WHERE clinic_id IS NULL;
ALTER TABLE appointments ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE appointments ALTER COLUMN clinic_id SET DEFAULT 1;

-- visits: add clinic_id and doctor_id
ALTER TABLE visits ADD COLUMN IF NOT EXISTS clinic_id  INTEGER REFERENCES clinics(id);
ALTER TABLE visits ADD COLUMN IF NOT EXISTS doctor_id  INTEGER REFERENCES staff(id);
UPDATE visits SET clinic_id = 1 WHERE clinic_id IS NULL;
ALTER TABLE visits ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE visits ALTER COLUMN clinic_id SET DEFAULT 1;

-- prescriptions
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinics(id);
UPDATE prescriptions SET clinic_id = 1 WHERE clinic_id IS NULL;
ALTER TABLE prescriptions ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE prescriptions ALTER COLUMN clinic_id SET DEFAULT 1;

-- drugs: NULL means global (shared across all clinics)
ALTER TABLE drugs ADD COLUMN IF NOT EXISTS clinic_id INTEGER REFERENCES clinics(id);
-- Leave existing drugs with clinic_id = NULL (global catalog)

-- patients: shared across clinics — no clinic_id needed on patient identity,
--           isolation is enforced at the appointment level.

-- ============================================================
-- TOKEN COUNTERS TABLE (replaces MAX(token_number)+1)
-- Atomic token assignment per clinic per date.
-- ============================================================
CREATE TABLE IF NOT EXISTS token_counters (
    clinic_id   INTEGER NOT NULL REFERENCES clinics(id),
    date        DATE    NOT NULL,
    last_token  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (clinic_id, date)
);

-- Back-fill today's counter from existing appointments for clinic 1
INSERT INTO token_counters (clinic_id, date, last_token)
SELECT 1, appointment_date, COALESCE(MAX(token_number), 0)
FROM appointments
GROUP BY appointment_date
ON CONFLICT (clinic_id, date) DO UPDATE
    SET last_token = EXCLUDED.last_token;

-- ============================================================
-- NEW INDEXES for multi-tenant queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date_status
    ON appointments(clinic_id, appointment_date, status);

CREATE INDEX IF NOT EXISTS idx_appointments_clinic_date_token
    ON appointments(clinic_id, appointment_date, token_number);

CREATE INDEX IF NOT EXISTS idx_visits_clinic_id
    ON visits(clinic_id);

CREATE INDEX IF NOT EXISTS idx_staff_clinic_id
    ON staff(clinic_id);

CREATE INDEX IF NOT EXISTS idx_clinic_config_clinic_id
    ON clinic_config(clinic_id);

-- ============================================================
-- TRIGGERS for new tables
-- ============================================================
CREATE TRIGGER update_clinics_updated_at
    BEFORE UPDATE ON clinics
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
