-- MedicareIQ Initial Schema Migration
-- Version: 001
-- Description: Creates all core tables for the clinic management system

BEGIN;

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PATIENTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS patients (
    id               SERIAL PRIMARY KEY,
    phone            VARCHAR(20)  NOT NULL UNIQUE,
    name             VARCHAR(255),
    date_of_birth    DATE,
    gender           VARCHAR(10)  CHECK (gender IN ('male', 'female', 'other')),
    address          TEXT,
    blood_group      VARCHAR(5),
    allergies        TEXT,
    fcm_token        VARCHAR(255),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- STAFF TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS staff (
    id               SERIAL PRIMARY KEY,
    username         VARCHAR(100) NOT NULL UNIQUE,
    password_hash    VARCHAR(255) NOT NULL,
    name             VARCHAR(255) NOT NULL,
    role             VARCHAR(50)  NOT NULL CHECK (role IN ('doctor', 'compounder', 'receptionist', 'admin')),
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    fcm_token        VARCHAR(255),
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- CLINIC CONFIG TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS clinic_config (
    id                      SERIAL PRIMARY KEY,
    clinic_name             VARCHAR(255) NOT NULL DEFAULT 'MedicareIQ Clinic',
    opening_time            TIME         NOT NULL DEFAULT '09:00:00',
    closing_time            TIME         NOT NULL DEFAULT '17:00:00',
    slot_duration_minutes   INTEGER      NOT NULL DEFAULT 15,
    max_patients_per_slot   INTEGER      NOT NULL DEFAULT 3,
    geofence_lat            DECIMAL(10, 7) NOT NULL DEFAULT 28.6139000,
    geofence_lng            DECIMAL(10, 7) NOT NULL DEFAULT 77.2090000,
    geofence_radius_meters  INTEGER      NOT NULL DEFAULT 200,
    checkin_window_minutes  INTEGER      NOT NULL DEFAULT 30,
    is_open                 BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DRUGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS drugs (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(255)  NOT NULL,
    generic_name     VARCHAR(255),
    category         VARCHAR(100),
    unit             VARCHAR(50)   NOT NULL DEFAULT 'tablet',
    stock_quantity   INTEGER       NOT NULL DEFAULT 0,
    is_active        BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ============================================================
-- APPOINTMENTS TABLE
-- ============================================================
-- Status state machine:
--   BOOKED → CHECK_IN_WINDOW → CHECKED_IN → IN_CONSULTATION → DONE → DISPENSED
--                                         ↘ SKIPPED
--   BOOKED → CANCELLED (by patient, >30 min before slot)
--   BOOKED / CHECK_IN_WINDOW → EXPIRED (cron job)
CREATE TABLE IF NOT EXISTS appointments (
    id               SERIAL PRIMARY KEY,
    patient_id       INTEGER      NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    appointment_date DATE         NOT NULL,
    slot_time        TIME         NOT NULL,
    token_number     INTEGER      NOT NULL,
    status           VARCHAR(30)  NOT NULL DEFAULT 'BOOKED'
                         CHECK (status IN (
                             'BOOKED',
                             'CHECK_IN_WINDOW',
                             'CHECKED_IN',
                             'IN_CONSULTATION',
                             'DONE',
                             'DISPENSED',
                             'CANCELLED',
                             'SKIPPED',
                             'EXPIRED'
                         )),
    called_at        TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    notes            TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- VISITS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS visits (
    id               SERIAL PRIMARY KEY,
    appointment_id   INTEGER      NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
    patient_id       INTEGER      NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    attending_staff  INTEGER      REFERENCES staff(id),
    chief_complaint  TEXT,
    doctor_notes     TEXT,
    diagnosis        TEXT,
    follow_up_date   DATE,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PRESCRIPTIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS prescriptions (
    id               SERIAL PRIMARY KEY,
    visit_id         INTEGER      NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    drug_id          INTEGER      NOT NULL REFERENCES drugs(id),
    dosage           VARCHAR(100) NOT NULL,
    frequency        VARCHAR(100) NOT NULL,
    duration_days    INTEGER,
    quantity         INTEGER      NOT NULL DEFAULT 1,
    instructions     TEXT,
    is_dispensed     BOOLEAN      NOT NULL DEFAULT FALSE,
    dispensed_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_appointments_date          ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_id    ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status        ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_date_status   ON appointments(appointment_date, status);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_date  ON appointments(patient_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_visits_patient_id          ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_visit_id     ON prescriptions(visit_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_dispensed    ON prescriptions(is_dispensed);
CREATE INDEX IF NOT EXISTS idx_patients_phone             ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_staff_username             ON staff(username);
CREATE INDEX IF NOT EXISTS idx_drugs_active               ON drugs(is_active);

-- ============================================================
-- TRIGGERS: updated_at auto-maintenance
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_patients_updated_at
    BEFORE UPDATE ON patients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_staff_updated_at
    BEFORE UPDATE ON staff
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_clinic_config_updated_at
    BEFORE UPDATE ON clinic_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_drugs_updated_at
    BEFORE UPDATE ON drugs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_appointments_updated_at
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_visits_updated_at
    BEFORE UPDATE ON visits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_prescriptions_updated_at
    BEFORE UPDATE ON prescriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- SEED DATA
-- ============================================================

-- Clinic configuration seed (New Delhi coordinates)
INSERT INTO clinic_config (
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
) VALUES (
    'MedicareIQ Clinic',
    '09:00:00',
    '17:00:00',
    15,
    3,
    28.6139000,
    77.2090000,
    200,
    30,
    TRUE
) ON CONFLICT DO NOTHING;

-- Sample drugs
INSERT INTO drugs (name, generic_name, category, unit, stock_quantity, is_active) VALUES
    ('Paracetamol 500mg',    'Paracetamol',    'Analgesic/Antipyretic', 'tablet',  500, TRUE),
    ('Amoxicillin 500mg',    'Amoxicillin',    'Antibiotic',            'capsule', 200, TRUE),
    ('Azithromycin 250mg',   'Azithromycin',   'Antibiotic',            'tablet',  150, TRUE),
    ('Ibuprofen 400mg',      'Ibuprofen',      'NSAID',                 'tablet',  300, TRUE),
    ('Cetirizine 10mg',      'Cetirizine',     'Antihistamine',         'tablet',  200, TRUE),
    ('Omeprazole 20mg',      'Omeprazole',     'PPI',                   'capsule', 250, TRUE),
    ('Metformin 500mg',      'Metformin',      'Antidiabetic',          'tablet',  400, TRUE),
    ('Amlodipine 5mg',       'Amlodipine',     'Antihypertensive',      'tablet',  300, TRUE),
    ('ORS Sachet',           'ORS',            'Rehydration',           'sachet',  100, TRUE),
    ('Vitamin C 500mg',      'Ascorbic Acid',  'Supplement',            'tablet',  500, TRUE)
ON CONFLICT DO NOTHING;

-- Sample staff: password is 'admin123' for all (bcrypt hash)
-- Hash generated with bcrypt rounds=10
INSERT INTO staff (username, password_hash, name, role, is_active) VALUES
    ('doctor1',     '$2b$10$YourHashHere.PlaceholderForDoctor1',     'Dr. Rajesh Kumar',  'doctor',       TRUE),
    ('compounder1', '$2b$10$YourHashHere.PlaceholderForCompounder1', 'Ravi Sharma',       'compounder',   TRUE),
    ('reception1',  '$2b$10$YourHashHere.PlaceholderForReception1',  'Priya Singh',       'receptionist', TRUE),
    ('admin1',      '$2b$10$YourHashHere.PlaceholderForAdmin1',      'Admin User',        'admin',        TRUE)
ON CONFLICT (username) DO NOTHING;

COMMIT;
