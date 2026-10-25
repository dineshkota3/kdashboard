# Phase 4.4 — Spotify + Soundbar: Now Playing on the Kindle, Music from Telegram

> Status: 📋 Planned (2026-10-25 — owner confirmed Spotify Premium, wants music control +
> SmartThings power/volume; Roborock 4.3 parked mid-login, resumes later)
> Gate: done only when (a) "play <song> on soundbar" plays the song on the soundbar, (b) the Kindle
> NOW PLAYING screen shows the current track with working play/pause/next, (c) SmartThings
> power/volume works if the soundbar is SmartThings-visible.

## Scope

- **Spotify Connect control** (Premium required — confirmed): play/pause/next/prev, search + play
  any track/playlist, queue, volume (Spotify volume), transfer playback to the soundbar.
- **Kindle NOW PLAYING screen**: track, artist, progress, play/pause/next buttons, device picker.
- **Telegram**: `play <song> on soundbar`, `pause music`, `next`, `previous`, `volume 40`,
  `what's playing`.
- **SmartThings (optional second leg)**: power/volume/source for the soundbar via Samsung account
  PAT, if the soundbar appears in the SmartThings app.
- NOT in scope: playlists management, Spotify Connect to OTHER devices (the soundbar is the
  default target; the picker exists but the soundbar is pre-selected).

## Architecture (no new hardware)

```
Telegram ──► spotify-bridge fn ──► Spotify Web API (transfer playback to soundbar)
Kindle screen ──► same bridge ──► (the soundbar streams from Spotify directly —
                                    audio never touches Kindle or InsForge)
SmartThings fn ──► Samsung cloud ──► soundbar power/volume (optional leg)
```

Auth model mirrors Phase 3's Google flow: one-time browser authorization → long-lived refresh
token in InsForge secrets → silent refreshes forever.

## Secrets (all added by the OWNER, never in git)

- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — from a developer.spotify.com app the owner
  creates (2 minutes; redirect URI `http://127.0.0.1:4381/callback`)
- `SPOTIFY_REFRESH_TOKEN` — produced by `scripts/connect-spotify.mjs` (one-time browser login)
- `ST_PAT` — SmartThings personal access token (devices read/write), only for the optional leg

## 1. `functions/spotify-bridge.ts` (new)

- **Token refresh**: POST to accounts.spotify.com with refresh token → access token (cached in a
  module variable per warm instance; re-auth prompt only if the owner revokes).
- **GET /now-playing** (`/me/player`): track, artist, album, progress, is_playing, device name.
- **POST /command**: `{action: "play"|"pause"|"next"|"prev"|"volume"|"transfer"|"search_play"}`,
  `query?`, `volume?`, `device?` — search_play resolves a query to a track URI then plays it on the
  soundbar (transfer first if playback is elsewhere). All calls carry the access token.
- Devices list: `GET /devices` for the picker.

## 2. `scripts/connect-spotify.mjs` (new — one-time)

Local helper (same UX as `scripts/connect-calendar.mjs`): starts a tiny HTTP server on
127.0.0.1:4381, opens the Spotify authorize URL (scopes: user-read-playback-state,
user-modify-playback-state, user-read-currently-playing, streaming), captures the code, exchanges
it, and writes `SPOTIFY_REFRESH_TOKEN` into InsForge secrets via the CLI.

## 3. `functions/smartthings-bridge.ts` (optional leg)

- `GET /devices` — list SmartThings devices (find the soundbar by name).
- `POST /command` — `{deviceId, command: "off"|"volume", value?}` via SmartThings REST
  (`https://api.smartthings.com/v1/devices/<id>/commands`, main capability
  `samsungvd.audioVolume` / `switch`). Stored soundbar `ST_DEVICE_ID` secret after first listing.

## 4. Telegram + Kindle

- `MusicAction {kind:"music", action, query?, volume?}` — heuristic fast patterns + LLM prompt
  lines; the soundbar is the default device name match ("soundbar"/"speaker").
- `dashboard-data` gains `spotify: {track, artist, is_playing, progress_ms, duration_ms, device}`
  (from the bridge's now-playing, read at fetch time); SSE hash includes it.
- **NOW PLAYING screen**: track + artist + progress bar, buttons PLAY/PAUSE, NEXT, PREV,
  SOUNDBAR (transfer), and the footer gains a `♪ <track>` line when playing.
- Volume/power land behind SmartThings if present; otherwise Telegram `volume N` uses Spotify
  volume only.

## 5. Tests + rollout

- Webhook tests: music parser (play/query forms, volume), applier echo, clarify on ambiguous
  device names.
- Bridge: pure helpers (search→URI pick, progress formatting) with fixture payloads.
- `test-phase0`: NOW PLAYING renders; fixture carries spotify block.
- Deploy order: secrets (owner) → connect script (owner login) → bridges → webhook → dashboard →
  Kindle → E2E: play a known track on the soundbar from Telegram, pause/skip on the Kindle.

## 6. Risks

- Spotify rate-limits play-state polling — keep the dashboard to fetch-time reads (hourly + SSE),
  and the NOW PLAYING screen refreshes on open only.
- Soundbar must have been used with Spotify once (appears in Connect devices) — first-time setup
  is a Spotify-app step, documented in INSTALL notes.
- SmartThings PATs expire (max validity chosen at creation) — refresh documented; the leg is
  optional and isolated.

## Rollback

Revert + redeploy; delete secrets; Spotify keeps working normally everywhere else.
