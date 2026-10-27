-- Phase 4.4: SmartThings OAuth session. SmartThings rotates the refresh
-- token on every use and access tokens last 24h, so the bridge persists each
-- rotated refresh token here (the OAuth client id/secret live in secrets).
CREATE TABLE IF NOT EXISTS st_session (
  id TEXT PRIMARY KEY DEFAULT 'default',
  refresh_token TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE st_session ENABLE ROW LEVEL SECURITY;
