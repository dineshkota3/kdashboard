-- Phase 4: two-person health metrics.
-- New daily aggregates synced from Apple Health (Watch via paired iPhone):
-- exercise minutes, resting heart rate, sleep hours, active energy, distance,
-- plus the cardio drill-down trio (HRV / respiratory rate / VO2max) and an
-- `hourly` JSONB array of today's 24 buckets for the tile drill-down charts.
-- Rows stay per (date, source) — one per person per day; growth ~0.25 MB/yr.
BEGIN;
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS exercise_minutes INTEGER NOT NULL DEFAULT 0 CHECK (exercise_minutes >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS resting_hr INTEGER NOT NULL DEFAULT 0 CHECK (resting_hr >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS sleep_hours NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (sleep_hours >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS active_energy_kcal NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (active_energy_kcal >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS distance_km NUMERIC(8, 2) NOT NULL DEFAULT 0 CHECK (distance_km >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS hrv_sdns_ms NUMERIC(8, 2) NOT NULL DEFAULT 0 CHECK (hrv_sdns_ms >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS respiratory_rate NUMERIC(5, 1) NOT NULL DEFAULT 0 CHECK (respiratory_rate >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS vo2max NUMERIC(5, 1) NOT NULL DEFAULT 0 CHECK (vo2max >= 0);
ALTER TABLE health_daily_summaries ADD COLUMN IF NOT EXISTS hourly JSONB NOT NULL DEFAULT '[]'::jsonb;
COMMIT;
