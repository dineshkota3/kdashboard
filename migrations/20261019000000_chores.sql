-- Phase 4.1: scheduled chores with recurrence + time windows and per-day dones.
-- pattern 'daily' | 'weekly' (days csv 'mo..su') | 'once' (once_date, swept after the day).
-- start_min/end_min are minutes from Amsterdam local midnight; default window 10:00-22:00.
CREATE TABLE IF NOT EXISTS chores (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  pattern TEXT NOT NULL DEFAULT 'daily' CHECK (pattern IN ('daily', 'weekly', 'once')),
  days TEXT NOT NULL DEFAULT '',
  once_date TEXT NOT NULL DEFAULT '',
  start_min INTEGER NOT NULL DEFAULT 600 CHECK (start_min >= 0 AND start_min < 1440),
  end_min INTEGER NOT NULL DEFAULT 1320 CHECK (end_min > 0 AND end_min <= 1440),
  skip_date TEXT NOT NULL DEFAULT '',
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chore_dones (
  chore_id TEXT NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  done_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chore_id, day)
);
ALTER TABLE chores ENABLE ROW LEVEL SECURITY;
ALTER TABLE chore_dones ENABLE ROW LEVEL SECURITY;
