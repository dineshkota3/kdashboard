-- Phase 4: per-person health targets.
-- health_targets goes from metric PK to (metric, person) so Dinesh and Keethu
-- can hold different targets. Existing rows backfill to person 'dinesh'.
-- The metric CHECK whitelist widens for the new target-able metrics.
-- Backup first: CREATE TABLE health_targets_backup_20261017 AS SELECT * FROM health_targets;
BEGIN;
ALTER TABLE health_targets ADD COLUMN person TEXT NOT NULL DEFAULT 'dinesh';
ALTER TABLE health_targets DROP CONSTRAINT health_targets_pkey;
ALTER TABLE health_targets ADD CONSTRAINT health_targets_pkey PRIMARY KEY (metric, person);
ALTER TABLE health_targets DROP CONSTRAINT health_targets_metric_check;
ALTER TABLE health_targets ADD CONSTRAINT health_targets_metric_check
  CHECK (metric IN ('steps', 'calories', 'exercise_minutes', 'sleep_hours', 'resting_hr'));
INSERT INTO health_targets (metric, person, label, target_value, unit) VALUES
  ('steps', 'keethu', 'STEPS', 6000, 'steps')
ON CONFLICT (metric, person) DO UPDATE
SET label = EXCLUDED.label, target_value = EXCLUDED.target_value, unit = EXCLUDED.unit;
COMMIT;
