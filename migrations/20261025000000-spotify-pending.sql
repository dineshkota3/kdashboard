-- Phase 4.4: Spotify search candidates waiting for the user's numbered pick
-- ("play bohemian rhapsody" -> list -> "play 2"). One row per surface.
CREATE TABLE IF NOT EXISTS spotify_pending (
  id TEXT PRIMARY KEY,              -- 'telegram'
  items JSONB NOT NULL,             -- [{name, artist, uri}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE spotify_pending ENABLE ROW LEVEL SECURITY;
