-- Phase 3.1: multi-calendar support.
-- google_calendar_state goes from a hard single-row table (id = 1 CHECK) to one
-- row per connected Google account, keyed by `slot` (also the Telegram routing
-- key and the Kindle strip label). created_at gives stable "first row = original
-- owner" ordering. In-place ALTERs preserve the live token row.
-- Backup first: CREATE TABLE google_calendar_state_backup_20261011 AS SELECT * FROM google_calendar_state;
BEGIN;
ALTER TABLE google_calendar_state ADD COLUMN slot TEXT;
UPDATE google_calendar_state SET slot = 'owner' WHERE slot IS NULL;
ALTER TABLE google_calendar_state ALTER COLUMN slot SET NOT NULL;
ALTER TABLE google_calendar_state ADD CONSTRAINT google_calendar_state_slot_key UNIQUE (slot);
ALTER TABLE google_calendar_state ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE google_calendar_state DROP CONSTRAINT google_calendar_state_pkey;
ALTER TABLE google_calendar_state DROP CONSTRAINT google_calendar_state_id_check;
ALTER TABLE google_calendar_state DROP COLUMN id;
COMMIT;
