-- Phase 4: user-added pregnancy todos for the dashboard's DO NOW section.
-- Distinct from pregnancy_tasks (the seeded NL care timeline): these are
-- personal todos added via Telegram ("add <text> to pregnancy todo").
CREATE TABLE IF NOT EXISTS pregnancy_todos (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE pregnancy_todos ENABLE ROW LEVEL SECURITY;
