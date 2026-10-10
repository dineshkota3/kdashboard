CREATE TABLE IF NOT EXISTS google_calendar_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  refresh_token TEXT,
  access_token TEXT,
  token_expiry TIMESTAMPTZ,
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE google_calendar_state ENABLE ROW LEVEL SECURITY;
