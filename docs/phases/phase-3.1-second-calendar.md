# Phase 3.1 — Second Google Calendar (Keethu) on the Same Deployment

> Status: 🚧 In progress (2026-10-11 — plan approved, implementation starting)
> Gate: Phase 3.1 is done only when Keethu's calendar renders as its own strip on the Kindle AND a Telegram booking with `for keethu` lands in her Google Calendar, with the owner (Dinesh) calendar untouched throughout.

## Goal

- The same InsForge deployment serves **two connected Google accounts**: Dinesh (existing) and Keethu (new), each with its own stored refresh token.
- The Kindle home screen shows **two separate calendar strips** (one per person, labeled), and the full-screen event list sections events by person.
- Telegram bookings can target either calendar: `schedule for keethu: dentist friday 3pm` → Keethu's calendar; plain `schedule dentist friday 3pm` → still Dinesh's. Works via both the Z.ai LLM path and the heuristic fallback.
- Reuse the **existing Production OAuth client** — no second Google Cloud project, no new secrets, no gcloud for the second user.
- Failures stay isolated per feed: one calendar being revoked/failing never breaks the other strip, the owner booking path, or any other panel.

## Decisions (locked with owner 2026-10-11)

1. **Reuse the existing OAuth client.** Each Google account consents separately to the same app; each gets its own token row. Rerunning `npm run google:setup` for the second user is FORBIDDEN — it would create a new OAuth client and overwrite `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, invalidating the owner's stored refresh token (tokens are bound to the client).
2. **Display: two separate strips**, not a merged list.
3. **Booking target selectable via message**, e.g. `for keethu`.

## 1. New files

### `migrations/20261011000000_google-calendar-multicalendar.sql`

In-place ALTERs (preserves the live token row; no drop/recreate, no RLS surprises):

```sql
BEGIN;
ALTER TABLE google_calendar_state ADD COLUMN slot TEXT;
UPDATE google_calendar_state SET slot = 'owner' WHERE slot IS NULL;
ALTER TABLE google_calendar_state ALTER COLUMN slot SET NOT NULL;
ALTER TABLE google_calendar_state ADD CONSTRAINT google_calendar_state_slot_key UNIQUE (slot);
ALTER TABLE google_calendar_state ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE google_calendar_state DROP CONSTRAINT google_calendar_state_pkey;
ALTER TABLE google_calendar_state DROP CONSTRAINT google_calendar_state_id_check;
ALTER TABLE google_calendar_state DROP COLUMN id;
COMMIT;
```

- The PK + `CHECK (id = 1)` MUST go — they forbid a second row (an `onConflict:"slot"` upsert would INSERT `id = DEFAULT 1` → PK violation).
- `slot` doubles as the display name (uppercased on the Kindle) and the Telegram routing key. `created_at` gives stable "first row = original owner" ordering.
- If a constraint name differs on the live DB, look it up first: `SELECT conname FROM pg_constraint WHERE conrelid = 'google_calendar_state'::regclass`.
- **Backup before applying:** `CREATE TABLE google_calendar_state_backup_20261011 AS SELECT * FROM google_calendar_state`.
- **Ops step for THIS deployment** (not baked into the migration so BYO installs keep the generic default): `UPDATE google_calendar_state SET slot='dinesh' WHERE slot='owner'`.

### `scripts/connect-calendar.mjs` → `npm run google:connect`

One-command connect for an ADDITIONAL user. No gcloud, never touches secrets:

1. Preconditions: `.insforge/project.json` linked; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` present via `npx -y @insforge/cli secrets get` (parse per the FORK_NOTES `=` gotcha). If missing → abort with "run `google:setup` once for the owner; do NOT rerun it for the second user".
2. Args: `--slot keethu` (required, `^[a-z][a-z0-9_-]{0,15}$`, must not be `owner`), `--timezone Europe/Amsterdam` (optional), `--no-open`.
3. `GET <base>/functions/google-calendar-oauth?slot=keethu` → print + open `auth_url`. **Two printed warnings:** (a) use the second user's browser profile / incognito — Google silently reuses the active session and would store Dinesh's calendar under her slot; (b) expect the one-time unverified-app "Advanced → continue" screen (app is Production-but-unverified).
4. Wait for Enter → verify via `db query "SELECT slot, refresh_token IS NOT NULL AS connected, calendar_id, timezone FROM google_calendar_state ORDER BY created_at"`; apply `--timezone` via UPDATE; print connected slots + next steps.

### `docs/phases/phase-3.1-second-calendar.md` (this file)

## 2. Modified files

### `functions/google-calendar-oauth.ts`
- No-code GET accepts `?slot=` → `normalizeSlot()` (`^[a-z][a-z0-9_-]{0,15}$`; absent/invalid → `"owner"` + warn); sets OAuth `state=<slot>` (Google echoes it back on redirect).
- Callback reads `state` (default `owner`), upserts `{slot, refresh_token, access_token, token_expiry, updated_at}` with `onConflict: "slot"`. `calendar_id`/`timezone` keep column defaults on first insert; `created_at` never updated (stable ordering).
- Optional (recommended): best-effort `GET /calendar/v3/calendars/primary` with the fresh token to store the account email in `calendar_id` — makes "who consented?" visible in the DB.
- Re-consenting the same slot overwrites that row's tokens — that IS the reconnect runbook.
- Redirect URI keeps coming from `INSFORGE_BASE_URL` (never `req.url` — phase-3 Gotcha 2).

### `functions/kindle-dashboard-data.ts`
- `loadCalendarPayload` selects ALL rows: `.select("slot,refresh_token,access_token,token_expiry,calendar_id,timezone").order("created_at", { ascending: true }).limit(4)` (single `.order()` — chained `.order()` calls overwrite each other).
- Zero connected rows → `{status:"not_connected", calendars:[], events:[]}` (zero external calls, unchanged fail-safe).
- Otherwise `Promise.all(rows.map(loadFeedEvents))` — each feed in its own try/catch → per-feed `ok | unavailable`; 8 s timeout each; per-feed `timeZone` param. One feed failing never breaks the other.
- Payload **keeps the merged top-level `events`** (legacy-binary compat) and adds `calendars`:

```json
"calendar": {
  "status": "ok",
  "events": [ ...merged union, sorted by start_iso, cap 10... ],
  "calendars": [
    {"slot": "dinesh", "status": "ok", "events": [ ... ]},
    {"slot": "keethu", "status": "ok", "events": [ ... ]}
  ]
}
```

- Key order in the serialized JSON matters: `status → events → calendars` (the legacy C++ parser finds the FIRST `"events"` via `strstr` — `calendars` must not precede it).
- Aggregate `status`: any feed ok → `"ok"`; connected but all failing → `"unavailable"`; none connected → `"not_connected"`.
- `ensureCalendarAccessToken` write-back `.eq("slot", state.slot)` instead of `.eq("id", 1)`.
- `calendar` is already a member of the version hash → SSE re-render flow unchanged.

### `functions/telegram-webhook.ts`
- `CalendarEventAction` gains `calendar_slot?: string`.
- New exported pure helper `applySlotHint(message, slots)`: fires only when the message looks like a booking (`/^\/event\b|\b(schedule|book|appointment)\b/i`). Candidate patterns: `for <name>`, `<name>'s calendar`, `<name>:` prefix — **accepted only if the candidate is in `slots`**. This kills the regression trap: `schedule dentist for friday 3pm` must keep booking to the owner, so "friday" can never be mistaken for a slot.
- The matched `for <slot>` fragment is **stripped from the message** before parsing (else the heuristic title leaks the name → "KEETHU DENTIST" on the strip).
- `parseTelegramMessage` becomes a thin wrapper: booking-shaped messages → load connected slots (lazy SDK import; DB error → `[]`, never blocks parsing) → `applySlotHint` → existing body on the stripped message → attach `calendar_slot` to the resulting event action.
- LLM path: static `PLANNER_SYSTEM_PROMPT` gains one static line about `calendar_slot`; the connected-slot list is injected per-request next to the timezone line (existing pattern — static prompt contract preserved).
- `validateEventAction`: present-but-invalid `calendar_slot` → reject (fail loudly, don't silently book to owner); absent stays absent.
- `loadCalendarState` → `loadCalendarStates(admin)`: select all rows ordered by `created_at`; `applyCalendarCreateAction` picks the row by slot; unknown slot → reply `No calendar connected for "X". Connected: dinesh, keethu`; default (no slot) → first row by `created_at` (= original owner, always). Success reply names the person: `Scheduled for Keethu: Dentist — Fri Oct 17, 3:00 PM CET`.
- `ensureGoogleAccessToken` write-back `.eq("slot", ...)`.
- **Timezone decision:** booking *interpretation* ("3pm") stays `DASHBOARD_TIMEZONE` (Europe/Amsterdam) for both calendars; per-row `timezone` only feeds the Google list param + reply label.

### `kindle/native/src/kindle_dashboard.cpp`
- Data model: `kMaxCalendarFeeds 3`; `struct CalendarFeed { char slot[24]; int connected; int event_count; CalendarEvent events[kMaxCalendarEvents]; }`; `Dashboard` replaces `calendar_events[]/calendar_count` with `calendar_feeds[]/calendar_feed_count` (keeps `calendar_connected` as aggregate). `feedLabel()` = uppercased slot; empty slot → `"CALENDAR"` (legacy payload renders exactly as today).
- Parser `parseCalendarFeeds` (replaces the inline block in `parseDashboard`): object-scoped extraction of each feed's `slot`/`status`/`events` via `findKeyInRange` + `matchingClose` (order-independent); skips the legacy `events` path whenever feeds parsed. `calendars` absent → legacy fallback synthesizes `calendar_feeds[0] = {slot:"", ...}` verbatim (old payload still renders). Absent `calendar` key → tolerant zero-state, unchanged.
- Two strips on home (starting geometry, PW5 1236×1648): when `calendar_feed_count >= 2`, two full-width strips (h 168 each, 3 event rows: label, rule, rows via existing `formatCalendarEventRow`) at y 476..644 and 652..820; lists shift down (lists_y 828 — "+N MORE"/"[ TAP TO OPEN ]" hints survive). Single feed → today's exact layout. Final heights tuned against fixture renders. Per-feed placeholders: `NOT CONNECTED - VISIT OAUTH LINK` / `NO UPCOMING EVENTS`.
- Touch: both strips register `kTouchOpenCalendar` (no new TouchAction; 8 → 9 regions of max 32). `drawCalendarCard` signature gains `const CalendarFeed* feed`.
- Full-screen list: per-feed sections — header (`feedLabel` + count) + up to 5 rows each + `+N MORE`; not-connected feed shows one `NOT CONNECTED` row. BACK/HOME reset unchanged.

### `kindle/native/fixtures/dashboard-data.json`
- `calendar` gains `calendars` with 2 feeds (dinesh: 3 events incl. one all-day; keethu: 2 events); merged `events` = union, key order `status → events → calendars`.

### `scripts/bootstrap-insforge-kit.mjs`
- Append the new migration to `schemaMigrations` (function deploy list unchanged — same three files).

### `scripts/setup-google.mjs`
- Only tweak the final verification query (select `slot`, `ORDER BY created_at` — `data[0]` becomes ambiguous with 2 rows). Everything else unchanged. **The script itself is single-user bootstrap and must not be rerun for the second user.**

### `package.json`
- Add `"google:connect": "node scripts/connect-calendar.mjs"`.

### Docs
- `docs/FORK_NOTES.md`: fork-deltas row + "Second calendar connect" runbook (connect steps, incognito warning, per-feed kill switches).
- `docs/INSTALL_FOR_USERS.md`: "Add another person's calendar" section after the google:setup block (`npm run google:connect -- --slot <name>`, never-rerun warning, Telegram examples).

## 3. Implementation order

1. Migration file + bootstrap list (code only — no live apply yet)
2. Backend: `google-calendar-oauth.ts` → `kindle-dashboard-data.ts` → `telegram-webhook.ts` (+ pure helpers)
3. Unit tests + `npm test` green
4. `scripts/connect-calendar.mjs` + `package.json`
5. Kindle C++ + fixture + renderer smoke
6. Docs (FORK_NOTES, INSTALL_FOR_USERS)

## 4. Live rollout (one sitting, this order — after code review)

0. Backup table (see §1).
1. Apply migration: `npx @insforge/cli db query "$(cat migrations/20261011000000_google-calendar-multicalendar.sql)"`.
2. **Immediately** deploy the three functions (`google-calendar-oauth`, `kindle-dashboard-data`, `telegram-webhook`). ⚠️ Between migration and deploy there is a brief outage window (old code queries `.eq("id",1)` on a table without `id` → calendar shows `unavailable`, bookings reply unavailable) — run migration + deploys back-to-back, then KUAL "Refresh Once".
3. Rename owner slot (this deployment): `UPDATE google_calendar_state SET slot='dinesh' WHERE slot='owner'`.
4. Regression: `curl -H "X-Dashboard-Read-Token: ..." .../kindle-dashboard-data | jq .calendar` → `status:"ok"`, `calendars[0].slot=="dinesh"` with existing events (token survived), merged `events` populated.
5. `npm run google:connect -- --slot keethu --timezone Europe/Amsterdam` (Keethu's browser session).
6. Telegram checks → Kindle rebuild + install → on-device checks.

## 5. Verification

- [ ] Payload: both slots in `calendars`, per-slot statuses, merged `events` sorted; version hash changes when either feed changes
- [ ] Owner regression: existing Dinesh events still render post-migration (token untouched)
- [ ] Telegram: `schedule dentist friday 3pm` → "Scheduled for Dinesh: …"; `schedule for keethu: dentist friday 3pm` → event appears in Keethu's Google Calendar; `/event tomorrow 9am standup` (heuristic) → Dinesh; `schedule for keethuu: typo` → `No calendar connected for "keethuu". Connected: dinesh, keethu`; `schedule dentist for friday 3pm` → Dinesh (the "for friday" guard)
- [ ] Both LLM and heuristic paths exercised (log latency for the Z.ai path)
- [ ] Kindle: two labeled strips; both tappable → sectioned full screen
- [ ] Kill switch per feed: `UPDATE google_calendar_state SET refresh_token = NULL WHERE slot='keethu'` → Keethu strip NOT CONNECTED, Dinesh strip still ok, aggregate `status` still `"ok"`; restore via `google:connect`
- [ ] Row delete → device falls back to single-strip layout
- [ ] Other panels unaffected in all failure modes

## 6. Tests

- **`functions/telegram-webhook.test.ts`** — new `// ---- phase 3.1: multi-calendar routing ----` block:
  - `applySlotHint`: `for keethu:` routes + strips the fragment (parse the stripped message with `parseEventHeuristically` → title has no "keethu"); `schedule dentist for friday 3pm` → `slot: null`, message unchanged; `keethu:` prefix; unknown name (`for craig`) → `null`; non-booking "add milk for keethu to groceries" → untouched.
  - `validateEventAction`: valid `calendar_slot` preserved; `"Keethu!"` → `null`; absent → field absent.
  - `PLANNER_SYSTEM_PROMPT` mentions `calendar_slot`; still no meal/recipe (regression guard).
- **`scripts/test-phase0.mjs`**: fixture with 2 feeds renders home + `--view calendar`; temp fixture with `calendars` but no top-level `events` proves parser tolerance in both directions; dark-pixel threshold asserts two strips.
- Renderer smoke: `make -C kindle/native local` → `build/kindle-dashboard-local --render kindle/native/fixtures/dashboard-data.json --view calendar --dump-size 1236x1648`.

## 7. Rollback / fallback

- **Device first, functions second, schema last** — the legacy parser renders the new payload fine (merged `events` kept), so the old binary keeps working against the new backend.
- Functions: revert the three files → redeploy (old code needs the `id` column restored first).
- Schema: restore from `google_calendar_state_backup_20261011` into a table with the original DDL (`migrations/20260710000000_create-google-calendar-state.sql`).
- Per-feed isolation: partial failures degrade to `unavailable`/`NOT CONNECTED` for that strip only — owner strip and all other panels keep working (Phase 3 fail-safe model).
- Revoke access: Keethu's Google Account → Security → Third-party access, then `DELETE FROM google_calendar_state WHERE slot='keethu'`.

## 8. Results log

- **2026-10-11 — Plan approved; implementation started.** Design locked: reuse Production OAuth client; slot-keyed multi-row table; two Kindle strips; `for <name>` Telegram routing validated against connected slots (the "for friday" guard); merged top-level `events` kept for legacy-binary compat; booking interpretation stays on `DASHBOARD_TIMEZONE`.
- **2026-10-11 — Code complete, all tests green (not yet deployed):**
  - Migration `20261011000000_google-calendar-multicalendar.sql` written (in-place ALTERs, `slot` UNIQUE + `created_at`, drops `id` PK/CHECK) and appended to `bootstrap-insforge-kit.mjs`.
  - `google-calendar-oauth.ts`: `?slot=` → `normalizeSlot()` → OAuth `state`; callback upserts `onConflict:"slot"`; best-effort primary-calendar lookup stores the account email in `calendar_id` (shows who consented).
  - `kindle-dashboard-data.ts`: all rows (created_at order, limit 4), parallel per-feed fetch with isolated try/catch, merged+sorted top-level `events` (instant-based sort — feeds mix `+02:00`/`Z`/date-only ISO shapes), aggregate status, token write-back by slot.
  - `telegram-webhook.ts`: `applySlotHint`/`isValidSlotName`/`looksLikeBookingMessage` pure helpers; `parseTelegramMessage` wrapper attaches `calendar_slot` (strips the name fragment so titles never leak it — including a preceding `in/to/on` for the "'s calendar" form); LLM slot list injected per-request; validator rejects malformed slots; `applyCalendarCreateAction` routes by slot, defaults to first row, unknown slot → loud error listing connected names; reply `Scheduled for <Name>: …`.
  - Device: `CalendarFeed` model, tolerant `parseCalendarFeeds` (legacy fallback synthesizes anonymous feed), two labeled strips (168 px, 3 rows each) with single-feed fallback to today's layout, sectioned full-screen view (`DINESH [3]` / `KEETHU [2]`), NULL-feed guard. Fixture: 2 feeds + merged events, key order `status → events → calendars` (legacy `strstr` hazard). GOTCHA found in render: the e-ink font has no `(` `)` glyphs — section counts use `[n]`.
  - Tests: 59 unit (16 new: slot routing incl. "for friday" guard, unknown-name, non-booking passthrough, validator cases) + phase-0 suite extended (feeds-only tolerance, legacy-payload tolerance, degraded-feed render, `--view calendar` smoke, two-strip dark-pixel delta) — all green; `make extension-zig` packages `kindle-dashboard-kual.tar.gz` cleanly.
  - `scripts/connect-calendar.mjs` + `npm run google:connect` (precondition checks, incognito + unverified-app warnings, post-consent verification + timezone UPDATE); `setup-google.mjs` verification query now slot-aware.
  - Docs: FORK_NOTES (deltas + "Second calendar connect" runbook), INSTALL_FOR_USERS ("Add Another Person's Calendar").
- **PENDING (live rollout, §4 — needs owner):** backup table → apply migration → deploy the 3 functions back-to-back → rename slot `owner` → `dinesh` → payload regression check → `npm run google:connect -- --slot keethu --timezone Europe/Amsterdam` with Keethu's Google session → Telegram booking checks → install the new KUAL package on the Kindle → on-device verification.
