-- Phase 4.4: current Spotify refresh token. Spotify rotates it on some
-- refreshes; secrets can't be updated at runtime, so the live value lives here
-- (SPOTIFY_REFRESH_TOKEN secret remains the bootstrap for the first refresh).
CREATE TABLE IF NOT EXISTS spotify_refresh (
  id TEXT PRIMARY KEY DEFAULT 'default',
  token TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE spotify_refresh ENABLE ROW LEVEL SECURITY;
