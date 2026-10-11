-- Phase 3.1: Telegram calendar reminders.
-- Dedupe ledger for the calendar-reminders cron: one row per (event, calendar,
-- kind) after the bot sends that reminder, so each event reminds exactly once
-- per kind even across cron restarts. kind: 't1' = 1h before, 't12' = 12h before.
CREATE TABLE IF NOT EXISTS calendar_reminders_sent (
  event_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('t1', 't12')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, slot, kind)
);
ALTER TABLE calendar_reminders_sent ENABLE ROW LEVEL SECURITY;
