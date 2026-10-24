-- Phase 4.2: smart-home command queue. Telegram (cloud) writes a row; the
-- Kindle (on the home LAN) picks it up via the SSE nudge, executes it against
-- the device over local UDP, and acks. Rows are one-shot and pruned daily.
CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL DEFAULT 'all',
  action JSONB NOT NULL,
  source TEXT NOT NULL DEFAULT 'telegram',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMPTZ
);
ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY;
