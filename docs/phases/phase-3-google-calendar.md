# Phase 3 — Google Calendar (Dashboard Panel + Telegram Booking)

> Status: ✅ Complete (2026-10-11 IST — OAuth connected; bot-created events verified on Google Calendar AND on the Kindle; both kill switches pass)
> Gate: Phase 4 starts only after a bot-created event appears in Google Calendar AND on the Kindle.

## Goal

- The Kindle dashboard shows upcoming Google Calendar events (next ~7 days, up to 10).
- Telegram commands create real events: `schedule dentist Friday 3pm` (NLP via glm-4.6) or `/event friday 3pm dentist` (heuristic fallback).
- Timezone default: Asia/Kolkata. Failures degrade gracefully (`not_connected` / `unavailable`) without affecting other panels.

## 1. New files

### `migrations/20260710000000_create-google-calendar-state.sql`

```sql
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
```

Single-row table — tokens live in the DB (not secrets) because edge functions can write tables but cannot mutate CLI-managed secrets.

### `functions/google-calendar-oauth.ts` (single self-contained file)

- `GET` without `?code=`: respond with the Google auth URL —
  `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&scope=https://www.googleapis.com/auth/calendar.events&redirect_uri=<THIS_FUNCTION_URL>&client_id=<GOOGLE_CLIENT_ID>`
- `GET ?code=...`: exchange at `https://oauth2.googleapis.com/token` using `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets → upsert `refresh_token` (and first access token) into `google_calendar_state` → respond "Calendar connected."
- Reuse helpers (`requiredEnv`, `jsonResponse`, `corsHeaders`) duplicated inline — matches the repo's self-contained-function deploy model.

## 2. Modified files

### `functions/kindle-dashboard-data.ts`
- New payload section:
```ts
calendar: {
  status: "ok" | "not_connected" | "unavailable",
  events: [{ title, start_iso, end_iso, all_day, location }]
}
```
- Logic: read state row → no `refresh_token` → `not_connected` (zero external calls). Else ensure access token (refresh if `token_expiry < now+60s`, update row), then
  `GET https://www.googleapis.com/calendar/v3/calendars/<calendar_id>/events?timeMin=<now RFC3339>&singleEvents=true&orderBy=startTime&maxResults=10&timeZone=Asia/Kolkata`
  with ~8 s timeout inside try/catch → any failure → `status:"unavailable"`, empty events.
- Add `calendar` to the version hash (so SSE pushes re-render on event changes).
- **Do NOT add any Google call to `kindle-dashboard-events.ts`** (SSE polls every 2 s — outbound calls there would be rate-limit suicide).

### `functions/telegram-webhook.ts`
- New action type: `{ kind: "calendar", action: "create_event", title, start_iso | {date,time}, duration_min?, all_day?, location? }`
- `validateEventAction()`: strict — normalize `{date,time}` to ISO server-side (IST); reject everything else.
- LLM prompt: add the event schema + "Assume timezone Asia/Kolkata; resolve relative dates ('Friday', 'tomorrow', 'tonight') against the current date/time" — inject current IST datetime into the system prompt at request time.
- Heuristic fallback `parseEventHeuristically()`: matches `/^\/event\s+/i` or `(schedule|book|appointment)`, plus a small weekday/time regex (`friday 3pm` → next Friday 15:00 IST, default 60 min).
- `applyCalendarCreateAction()`: ensure-token helper (duplicated inline), `events.insert` with `{ summary, start: {dateTime|date, timeZone}, end: {...} }`; bot replies `Scheduled: Dentist — Fri Oct 10, 3:00 PM IST` or `Calendar not connected — open the OAuth link first`.

### `kindle/native/src/kindle_dashboard.cpp`
- `struct CalendarEvent { char title[96]; char start_iso[32]; int all_day; }`
- `parseCalendar(json, dashboard)` modeled on the existing `parse*` functions (reuse `extractString`/`extractInt`; tolerate absent key)
- `drawCalendarCard(canvas, x, y, w, h, ...)`: up to 4 events, one line each — `FRI OCT 10 3:00P — DENTIST`; place in the home-grid slot chosen in Phase 1 (right column top or below workout — decide visually with fixture renders)
- `kindle/native/fixtures/dashboard-data.json`: add a `calendar` block with 3 sample events

### `scripts/bootstrap-insforge-kit.mjs`
- Add the migration + `google-calendar-oauth` function deploy.

## 3. External setup (Google Cloud)

1. https://console.cloud.google.com → New project (e.g. `kindle-dashboard`).
2. APIs & Services → Library → enable **Google Calendar API**.
3. OAuth consent screen: type **External**, app name, your email; add yourself as **test user**.
4. Credentials → Create credentials → OAuth client ID → **Web application** →
   Authorized redirect URI: `https://<project>.insforge.app/functions/google-calendar-oauth`
5. Store secrets:
   ```sh
   npx @insforge/cli secrets add GOOGLE_CLIENT_ID <client-id>
   npx @insforge/cli secrets add GOOGLE_CLIENT_SECRET <client-secret>
   ```
6. Deploy, then get the auth URL and visit it in a browser:
   ```sh
   curl https://<project>.insforge.app/functions/google-calendar-oauth
   # open the returned URL, consent, land back on "Calendar connected."
   ```
7. **Token lifetime**: in test mode the refresh token expires after 7 days. After initial testing, OAuth consent screen → **Publish app** to Production. Personal use of an unverified app shows a one-time "Advanced → continue" warning screen, but your refresh token stops expiring. If you skip publishing: re-run the OAuth link weekly.

## 4. Verification

- [ ] `curl -H "X-Dashboard-Read-Token: ..." .../kindle-dashboard-data | jq .calendar` → `status:"ok"` + events after creating a test event in Google Calendar web
- [ ] Create an event for later today in Google Calendar web → KUAL **Refresh Once** → event visible on Kindle
- [ ] Telegram `schedule dentist Friday 3pm` → confirmation reply → event exists in Google Calendar at the correct IST time, 1 h duration
- [ ] Telegram `/event tomorrow 9am standup` → created (heuristic path)
- [ ] NLP path check: verify in logs the event command went through Z.ai (not heuristics)
- [ ] Kill switch A: `UPDATE google_calendar_state SET refresh_token = NULL` (via InsForge DB console) → panel shows CALENDAR NOT CONNECTED; bot replies not connected
- [ ] Kill switch B: set `token_expiry` in the past → next call auto-refreshes and succeeds
- [ ] Other panels unaffected in all failure modes

## 5. Rollback / fallback

- The whole feature is behind the presence of `refresh_token` — deleting the row cleanly disables read + write paths.
- Panel failures are isolated (try/catch) — never breaks lists/health rendering.
- If the OAuth callback function misbehaves: revoke access from Google Account → Security → Third-party access, fix, re-consent.

## Tests

- **Extend `functions/telegram-webhook.test.ts`** with unit tests for the new exported pure functions:
  - `parseEventHeuristically`: `friday 3pm` → next Friday 15:00 IST (+60 min default); `tomorrow 9am`; `tonight 8pm`; past weekday → next week; garbage → `null`
  - `validateEventAction`: valid ISO start; `{date,time}` normalization; rejects empty title, non-finite duration, malformed ISO
  - validator chain still rejects meal/recipe kinds (regression guard)
- **Renderer smoke** (`scripts/test-phase0.mjs` or a phase-3 extension): fixture with a `calendar` block (3 events) renders; fixture with `calendar.status:"not_connected"` renders the empty/placeholder card; missing `calendar` key renders home unchanged (tolerant parse)
- **Live integration:** the verification checklist above (read path, bot booking, both kill switches, expired-token auto-refresh)
- `npm test` green before deploying; OAuth function deployed only after Google Console steps are done.

## 6. Results log

- **2026-10-10 — All code shipped, deployed, and rendering:**
  - `migrations/20260710000000_create-google-calendar-state.sql` applied; `google-calendar-oauth` + calendar read path (dashboard-data) + `create_event` action (webhook) deployed.
  - Webhook: `CalendarEventAction` type, `validateEventAction` (ISO/{date,time}/date-only normalization, IST `+05:30`), exported `parseEventHeuristically(message, now)` (pure, IST math, `/event` + schedule/book/appointment triggers, past times roll +7d), dispatcher + `applyCalendarCreateAction` (token refresh inline, events.insert, `Scheduled: Title — Fri Oct 10, 3:00 PM IST` replies). LLM prompt extended with the event schema; current IST datetime injected at request time (static `PLANNER_SYSTEM_PROMPT` contract preserved).
  - Guard: event heuristic only fires when the message has NO explicit list keyword, so "add book to groceries" stays a planner item even in fallback mode.
  - Renderer: `CalendarEvent` struct + tolerant `parseCalendar` (absent key → counts 0) + `drawCalendarCard` — full-width strip between the gauges and the two list cards (replaces the doc's "below workout" slot, which Phase 1 removed), up to 4 rows `FRI OCT 10 3:00P - DENTIST`, `ALL DAY` variant, `NOT CONNECTED` / `NO UPCOMING EVENTS` placeholders. Fixture extended with 3 events; render verified locally at 1236×1648 (weekday math correct) and on-device (`NOT CONNECTED` state).
  - `scripts/bootstrap-insforge-kit.mjs`: migration + oauth function added.
  - Tests: 41 unit (+11 calendar: heuristic parse incl. IST rollovers, validator ISO/{date,time}/date-only/rejections, fast-path routing) + integration, all green. Backend verified live: `GET kindle-dashboard-data` → `calendar:{status:"not_connected",events:[]}`, version hash includes calendar.
  - Ops note: Kindle DHCP lease changed mid-session (`.110`→`.111`); SSH config updated. Cable-plug incident also polluted the running 24h battery test — re-verify tomorrow's reading with that in mind.
  - **PENDING:** Google Cloud setup (Calendar API + OAuth client + `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` secrets) → OAuth consent → verification checklist. Reminder: publish the consent app to Production after initial testing or the refresh token dies weekly.
- **2026-10-11 IST — OAuth connected; verification checklist PASSED; Phase 3 gate closed:**
  - **Gotcha 1 (test-user gate):** consent blocked with "app is being tested" until the browsing Google account was added under OAuth consent screen → Test users.
  - **Gotcha 2 (redirect_uri_mismatch at exchange):** the InsForge gateway presents an internal host in `req.url` (`*.insforge.deno.net`), so deriving the redirect URI from the request poisoned the token exchange (auth used the public URI, exchange sent the internal one). **Fix: build the redirect URI from the `INSFORGE_BASE_URL` secret, never from `req.url`.** Error surface improved to include Google's reason + computed `redirect_uri` for fast diagnosis. Authoritative redirect URI: `https://<project>.insforge.app/functions/google-calendar-oauth`.
  - Verification: read path `status:ok` with real events (IST offsets); NLP booking `schedule kindle test friday 3pm` → real event Fri Oct 16 3:00 PM IST (glm-4.7 ~6s incl. insert — Z.ai path confirmed by latency); heuristic `/event tomorrow 9am standup` → Mon Oct 12 9:00 AM IST (~1.2s); both appeared in the payload and on the Kindle via SSE (`events=planner refresh=1`, CALENDAR strip showed 4 events incl. both test bookings); kill switch B (token_expiry in past) → auto-refresh, still `ok`; kill switch A (refresh_token NULL) → `not_connected`, restored from a backup table → `ok` again.
  - Test events `Kindle test` + `standup` remain on the user's Google Calendar for manual deletion.
