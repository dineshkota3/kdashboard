# Phase 4.3 — Roborock S8: Vacuum Rooms from Telegram + Kindle

> Status: 📋 Planned (2026-10-24 — owner approved concept + decisions below)
> Gate: done only when (a) "vacuum kitchen" starts the S8 cleaning the kitchen at Max power,
> (b) "vacuum stop" stops it, (c) the LIGHTS-style VACUUM screen shows live state/battery and has
> room + stop/dock buttons, (d) status on the dashboard updates without the robot being near the Kindle.

## Scope (owner: "it shouldn't do much")

- Start a room vacuum by name, always at **Max suction** (fixed — decision below)
- Stop / pause / return-to-dock
- Live status (state + battery) on the dashboard
- NO zones, no goto-point, no schedules, no water/mop controls

## Decisions (locked with owner, 2026-10-24)

1. **Account-based cloud control**: Roborock app email + password stored as InsForge secrets
   (ROBOROCK_EMAIL / ROBOROCK_PASSWORD, never in git). The S8 is cloud-bound for room/segment
   commands on modern firmware — local UDP needs a token newer firmware won't expose, and map
   messages route through Roborock's cloud regardless (research: python-roborock / HA integration).
2. Model: **Roborock S8** (S-series; supports `app_segment_clean`, per-room segments from its map).
3. **Fixed Max power** on every clean: `set_custom_mode` — S8 suction codes are 101 (quiet) …
   104 (max), some firmware 105 (max+). Bridge tries 105, falls back 104, remembers which worked.
4. Route direction ("vertical and horizontal"): robots plan their own S-pattern; owner accepted
   reality — we just start the room clean. **Route style: standard** (the robot's default route
   planning — owner confirmed "have the route standard"; no fast/route-tweaking settings sent).
5. Rooms come from the robot's saved map (segment IDs ↔ names), seeded once into a DB table and
   correctable via Telegram ("kitchen is segment 16" not needed — the bridge lists what it sees).

## How it works

Roborock's cloud path (same as python-roborock / Home Assistant):
login → account/home IDs → **MQTT (TLS) to Roborock's rriot brokers** with derived credentials →
publish an RPC to the robot's topic → robot executes → status comes back over MQTT.

The S8 is online via its own Wi-Fi + Roborock's cloud, so unlike the WiZ bulb, **no LAN hop is
needed** — the InsForge function talks to the robot directly through Roborock's brokers.

## 1. `functions/roborock-bridge.ts` (new — the meat)

- **Session cache** in `roborock_session` (DB): login tokens, endpoint, MQTT credentials
  (mqttUserName / mqttPassword / clientId are derived from the account after login), rriot region
  URL. Re-login only on expiry (401 / token age). Login API: europe endpoint
  (`europe-roborock.ifreedomlight.com`), password MD5'd per the documented flow.
- **GET /status** (DASHBOARD_READ_TOKEN): robot state, battery, last command result — from a live
  `get_status` RPC with a short MQTT wait (≤ 5s), refreshed into `roborock_status` table.
- **POST /command** (same auth): `{command: "segment_clean"|"stop"|"pause"|"resume"|"dock"|"status",
  segments?: [ids]}`:
  1. `set_custom_mode(105→104 fallback)` — remembered per session
  2. `app_segment_clean([segments])` (rooms) / `app_stop` / `app_pause` / `app_resume` /
     `app_return_to_dock`
  3. Reply `{ok, detail}` — webhook echoes intent; truth lands in status.
- **Rooms**: `GET /rooms` → from `get_room_mapping`/map segments (id + name), written to
  `roborock_rooms` (segment_id, name). Refreshed on demand; names are the app's names.
- **MQTT in Deno**: `npm:mqtt` (works under Deno) with the rriot TLS broker URL + derived creds;
  publish to `rr/mc/<endpoint>/<uid>/<duid>/down` style request topic, subscribe response topic,
  match RPC id, 5s timeout per command.

### Tables

```sql
CREATE TABLE IF NOT EXISTS roborock_session (
  id TEXT PRIMARY KEY DEFAULT 'default',
  data JSONB NOT NULL,            -- tokens, endpoint, mqtt creds, preferred suction code
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS roborock_rooms (
  segment_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roborock_status (
  id TEXT PRIMARY KEY DEFAULT 'default',
  state TEXT NOT NULL DEFAULT 'unknown',   -- cleaning/docked/paused/idle/error
  battery INTEGER, current_segment TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE roborock_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE roborock_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE roborock_status ENABLE ROW LEVEL SECURITY;
```

### Cron

- **Status refresh every 15 min** (`roborock-cron` schedule on the bridge's refresh endpoint):
  updates `roborock_status` → SSE hash → dashboard. ≈ 2,880 calls/mo (~2.9% of budget; noted in
  usage log).

## 2. Telegram

- `VacuumAction { kind:"vacuum", command:"clean"|"stop"|"pause"|"resume"|"dock"|"status",
  rooms?: string[] }`.
- Parser: `vacuum kitchen` / `vacuum the kitchen and living room` / `vacuum whole house`
  (no rooms = full clean: `app_segment_clean` with all segments or `app_start`) / `vacuum stop` /
  `send vacuum home` / `vacuum status`. LLM prompt lines + deterministic fallback; rooms fuzzy-match
  `roborock_rooms` names.
- Applier: POST to the bridge (internal HTTP, ~1 extra fn call) → reply
  `🤖 Vacuuming kitchen at Max` / `🤖 Stopped` / status summary (state + battery).
- Clarify on unknown room names (list what the robot knows) — no guessed cleaning runs.

## 3. Kindle

- `dashboard-data` gains a `vacuum: {state, battery, current_segment, updated_at}` block read from
  `roborock_status`; SSE hash includes it.
- **VACUUM screen** (6th: header button + swipe): status line (`CLEANING KITCHEN 74%` /
  `DOCKED 100%`), room buttons (one per `roborock_rooms` row, up to 6), `STOP`, `PAUSE`, `DOCK`.
  Taps → POST to the bridge via the queue URL pattern (kindle-device-queue gains a pass-through
  `POST /vacuum-command`), same auth.
- No direct robot link from the Kindle — the robot is cloud-bound, so the screen is just a remote
  for the bridge.

## 4. Tests

- Webhook: vacuum parser table (rooms, whole house, stop, status), validator, applier echoes,
  clarify on unknown rooms.
- Bridge pure helpers (suction fallback pick, room-name matching) with fixture RPC responses.
- `test-phase0`: VACUUM view renders; fixture carries vacuum block.

## 5. Implementation order

1. **Spike first** (this decides feasibility): secrets → bridge login → device list → MQTT
   connect → `get_status`. One round trip end-to-end before any UI.
2. Tables + rooms seeding → commands (segment clean w/ suction fallback, stop/pause/dock)
3. Cron + status table + SSE hash
4. Webhook VacuumAction + tests → deploy
5. dashboard-data block + Kindle VACUUM screen → renders → device deploy
6. E2E with the real robot: `vacuum kitchen` (watch it run at Max), `vacuum stop`, dock
7. Usage check + usage-history row → docs → commit

## 6. Risks

- **Login flow is the fragile bit** — Roborock changed it recently and broke Home Assistant
  (fixed in HA 2025.12). Mitigation: spike-first; session caching so login runs rarely; if
  programmatic login is blocked (captcha), fall back to pasting session tokens from a one-off
  python-roborock login into secrets (documented, still no plaintext password needed at runtime).
- MQTT creds derive from the account — revoking in the Roborock app (logout all) breaks the bridge
  until re-login.
- Segment IDs change if the user re-maps floors in the app — `/rooms` refresh re-seeds names.
- Latency: MQTT round trip ~1–3s — fine for a robot.

## Rollback

Revert + redeploy; drop the schedule; tables inert. The vacuum is untouched without the bridge.
