-- Phase 4.4: last-known Spotify/soundbar state, written by the bridges after
-- commands and hourly by the data fetch. The SSE hash includes this row so
-- the Kindle refreshes only on real changes (no polling).
CREATE TABLE IF NOT EXISTS spotify_state (
  id TEXT PRIMARY KEY DEFAULT 'default',
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE spotify_state ENABLE ROW LEVEL SECURITY;
