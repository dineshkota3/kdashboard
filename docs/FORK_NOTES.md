# Fork Notes — kdashboard → Dinesh's Kindle Dashboard

Fork of `thecodedose/kdashboard`, customized for:
- Kindle Paperwhite 11th gen (PW5), firmware 5.18.6, KUAL Next
- InsForge hosted free tier (bring-your-own-backend)
- Z.ai glm-4.7 for NLP (no OpenAI; Coding Plan endpoint `api/coding/paas/v4`)
- Google Calendar integration (Phase 3)
- Samsung SmartThings appliance status + cycle alert (Phase 5)
- **Meals/recipes/meal-planning removed** (Phase 0)

Detailed per-phase plans and status: [`docs/phases/`](phases/).

## Fork deltas vs upstream

| Area | Change | Phase |
|---|---|---|
| Migrations | 9 meal/recipe/sample migrations deleted; `001_planner_lists.sql` trimmed to `grocery/workout/todo` | 0 |
| `functions/telegram-webhook.ts` | Meal/recipe actions+parsers removed; OpenAI → Z.ai (`ZAI_API_KEY`, `ZAI_MODEL=glm-4.7`, Coding Plan endpoint); calendar `create_event` action added | 0, 2, 3 |
| `functions/kindle-dashboard-data.ts` | recipes/meal_plan removed; `workout` added to lists; `calendar` + `appliances` sections + hash members | 0, 3, 5 |
| `functions/kindle-dashboard-events.ts` | recipes/meal_plan removed; workout list; (no outbound API calls here — SSE stays DB-only) | 0 |
| `kindle/native/src/kindle_dashboard.cpp` | Recipe/meal structs/parsers/screens/touch-actions deleted; home grid right column = Workout + Grocery; `drawCalendarCard` + `drawApplianceCard` + optional exercise radial | 0, 1, 3, 4b, 5 |
| `kindle/native/Makefile` | Meal/recipe asset copies removed | 0 |
| New: `migrations/..._create-google-calendar-state.sql` | Single-row OAuth token store | 3 |
| New: `migrations/..._google-calendar-multicalendar.sql` | `google_calendar_state` → multi-slot: `slot` unique key + `created_at`, drops `id`; one row per connected Google account | 3.1 |
| New: `functions/google-calendar-oauth.ts` | Auth-URL + code-exchange callback; `?slot=` routed via OAuth `state`, upsert `onConflict:"slot"` | 3, 3.1 |
| New: `scripts/connect-calendar.mjs` | `npm run google:connect -- --slot <name>` — consent link for an ADDITIONAL user; reuses the existing OAuth client | 3.1 |
| New: `functions/calendar-reminders.ts` + `calendar_reminders_sent` table + 15-min schedule | Telegram pings per event at T-12h and T-1h (all-day events: T-12h only); ledger-deduped | 3.1 |
| Grocery shop sublists | `planner_items.store` (`ah`/`turkish`/`indian`, default ah); Telegram names the shop ("add paneer to indian grocery"); Kindle grocery card + full list render grouped by shop with headers | 3.1 |
| Telegram read-only queries | new `query` action: grocery (grouped by shop), todo, workout, events (today / next N days); heuristic fast path + LLM schema; mutation-shaped messages never match | 3.1 |
| Two-person health | `health_daily_summaries` per-person `source` (`apple_health_ios` / `_keethu`, 8 new metric columns + `hourly` JSONB); payload `health.people[]` + compat flat fields first; per-person `health_targets` PK (metric, person); Telegram "set steps target for keethu to 6000" | 4 |
| Pregnancy tracker | derived from `PREGNANCY_DUE_DATE` secret (set BEFORE deploying kindle-dashboard-data); week/trimester/countdown/milestones computed server-side; health-screen tile + dedicated swipe screen 3 | 4 |
| Swipe screens | 3 screens (home/health/pregnancy), horizontal swipe = page flip; tile taps open 24-bar hourly charts; profile image card removed; `KINDLE_SWIPE_INVERT` config flips direction | 4 |
| New: `migrations/..._create-appliance-status.sql` | Appliance snapshot + alert bookkeeping | 5 |
| New: `functions/smartthings-poll.ts` | Scheduled PAT poller + transition alert | 5 |
| New: `functions/planner-cleanup.ts` + nightly schedule | Deletes done planner items after 72h (PLANNER_CLEANUP_AFTER_HOURS); done items also sort to the bottom of each list and stay visible 72h (upstream hid them after 24h) | 2+ |
| New: `migrations/..._add-exercise-minutes.sql` | Optional exercise metric | 4b |
| New: `scripts/list-smartthings-devices.mjs` | PAT device lister | 5 |
| `config.sh.example` | Sleep window + timezone defaults documented | 1 |
| Tests | `npm test` = parser unit tests (`functions/telegram-webhook.test.ts`) + integration suite (`scripts/test-phase0.mjs`: hygiene, migrations, fixture, renderer smoke at PW5 resolution). Each phase extends the suite (see its Tests section) | 0+ |
| Bug fix (vs upstream) | Heuristic parser: `clear` actions carried `items:["clear todo"]` instead of `[]` (fallback clobbered intentional empty list); payload-only, DB effect was correct | 0 |
| `telegram-webhook.ts` import style | InsForge SDK import made lazy (`await import` inside handler) so Node can run the pure parsers in tests; Deno deploy behavior unchanged | 0 |

## Runbooks

### Google OAuth (re)connect — Phase 3
1. Ensure secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are set.
2. `curl https://<project>.insforge.app/functions/google-calendar-oauth` → open returned URL → consent → "Calendar connected."
3. If refresh token silently expires (app still in test mode): publish the consent app to Production (personal unverified use is fine), then re-consent once. Done 2026-10-11 — app is In Production; tokens persist.
4. Gotcha: the gateway exposes an internal host (`*.insforge.deno.net`) in `req.url` — the OAuth function therefore builds its redirect URI from the `INSFORGE_BASE_URL` secret. Keep `https://<project>.insforge.app/functions/google-calendar-oauth` as the only Authorized redirect URI in Google Console.

### Second calendar connect — Phase 3.1
1. NEVER rerun `npm run google:setup` for a second user: it creates a NEW OAuth client and overwrites `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, which invalidates every stored refresh token (tokens are bound to the client).
2. Connect an additional user: `npm run google:connect -- --slot keethu --timezone Europe/Amsterdam`. Consent in THAT user's browser profile or incognito — Google silently reuses the active session, and the owner's calendar would land on the wrong slot.
3. Re-connect (token revoked/expired) = rerun the same command for that slot; the upsert overwrites that row's tokens only.
4. Routing: Telegram bookings default to the FIRST row (`created_at` order — always the original owner). `schedule for keethu: dentist friday 3pm` targets a slot; unknown names fail loudly with the connected list. A candidate name is only accepted when it matches a connected slot, so `schedule dentist for friday 3pm` still books to the owner.
5. Kill switch per feed: `UPDATE google_calendar_state SET refresh_token = NULL WHERE slot='<name>'` → that strip shows NOT CONNECTED, others unaffected. Remove a person: `DELETE FROM google_calendar_state WHERE slot='<name>'` → device falls back to the single-strip layout.
6. Booking interpretation always uses `DASHBOARD_TIMEZONE` (owner's tz); the per-row `timezone` only drives Google list params + reply labels.

### Planner nightly cleanup — Phase 2+
Done items stay on the board (bottom of each list) for 72h, then vanish from the payload and get deleted from `planner_items` nightly. The schedule POSTs to `functions/planner-cleanup` with the `PLANNER_CLEANUP_TOKEN` secret. Recreate with:
```sh
npx @insforge/cli schedules create --name planner-nightly-cleanup --cron "30 21 * * *" \
  --method POST --url https://<project>.insforge.app/functions/planner-cleanup \
  --headers '{"X-Planner-Cleanup-Token": "${{secrets.PLANNER_CLEANUP_TOKEN}}"}'
```
Note: the InsForge SDK's chained `.order()` calls overwrite each other — done-last ordering is a JS `.sort()` in `kindle-dashboard-data.ts`, not an ORDER BY.


### Calendar reminders cron — Phase 3.1
Every 15 min the schedule POSTs `functions/calendar-reminders`; the bot announces each event at T-12h and T-1h (all-day events: T-12h only) to the allowed chat, deduped via the `calendar_reminders_sent` ledger. Each tick costs exactly ONE InsForge function call (~2.9K/mo — see docs/resources/insforge-limits.md). Recreate with:
```sh
npx @insforge/cli secrets add CALENDAR_REMINDER_TOKEN <long-random-token>
npx @insforge/cli functions deploy calendar-reminders --file functions/calendar-reminders.ts --name "Calendar Reminders"
npx @insforge/cli schedules create --name calendar-reminders --cron "*/15 * * * *" \
  --method POST --url https://<project>.insforge.app/functions/calendar-reminders \
  --headers '{"X-Calendar-Reminder-Token": "${{secrets.CALENDAR_REMINDER_TOKEN}}"}'
```
Reminder precision is ±15 min (cron cadence). Windows are half-open `[T, T+15m)`: t1 = 60–75 min before, t12 = 720–735 min before.

### SmartThings PAT renewal — Phase 5
1. account.smartthings.com → generate new PAT (`devices:read`), note expiry.
2. `npx @insforge/cli secrets update SMARTTHINGS_PAT <new-pat>` (check CLI verbs).
3. Manual poll once to confirm: curl the `smartthings-poll` function with the poll token header.

### Reading InsForge secrets in shell — Phase 0 gotcha
`npx @insforge/cli secrets get KEY` prints `KEY =<value>` (no space after `=`) on one line. Parse with:
```sh
npx @insforge/cli secrets get API_KEY | tail -1 | sed 's/^API_KEY[[:space:]]*=[[:space:]]*//' | tr -d '\n'
```
Do NOT use `awk '{print $NF}'` — it silently produces corrupted values (cost us an hour of `AUTH_UNAUTHORIZED`). Verify any copied secret against `GET /api/database/records/<table>` (expect 200, not 401) before wiring it into functions. Functions snapshot env at deploy — after changing a secret, redeploy the functions that use it.

### Zig ABI ladder for PW5 — Phase 1
Default `make -C kindle/native extension-zig` (soft-float static musl). If `Illegal instruction`/`Exec format error` in the device log:
1. `ZIG_TARGET=arm-linux-musleabihf ZIG_MCPU=generic+v7a`
2. `ZIG_TARGET=arm-linux-gnueabihf ZIG_MCPU=generic+v7a`
3. Real cross-GCC via `KINDLE_CXX=...`

### Kindle SSH unreachable — Phase 1+
Two known causes: (1) plugging the USB cable flips USBNetLite back to drive mode and kills dropbear — unplug to restore; (2) the DHCP lease changes — re-scan the LAN (ping sweep + SSH key probe) and update `~/.ssh/config`. Deploy sequence over SSH: scp binary → chmod (own call) → `start-light.sh` (own call); never put the binary path in the same command as start/stop (`dashboard.sh` runs `pkill -f` on it).

### Firmware update survival (5.18.x+)
After an Amazon firmware update: re-jailbreak per kindlemodding wiki if needed, then reinstall MRPI + KUAL Next; extension files under `/mnt/us/extensions/` usually survive but re-run `bin/diagnose.sh`.

## Secret inventory (server-side, InsForge)

| Secret | Set in | Purpose |
|---|---|---|
| `INSFORGE_BASE_URL`, `INSFORGE_API_KEY` | 0 | Function → backend self-calls |
| `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID` | 0 (bot via configure script) | Telegram auth/allowlist |
| `DASHBOARD_READ_TOKEN`, `DASHBOARD_TOGGLE_TOKEN`, `HEALTH_SYNC_TOKEN` | 0 (generated) | Kindle/iOS ↔ function auth |
| `ZAI_API_KEY`, `ZAI_MODEL` | 2 | NLP parsing |
| `DASHBOARD_TIMEZONE` | 3 (owner: `Europe/Amsterdam`) | Booking normalization, challenge day boundary, event-list formatting. Defaults to Asia/Kolkata if unset. Redeploy functions that read it after changing. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 3 | OAuth exchange (refresh token lives in `google_calendar_state` table) |
| `CALENDAR_REMINDER_TOKEN` | 3.1 (generated) | 15-min reminders schedule auth |
| `SMARTTHINGS_PAT`, `SMARTTHINGS_DEVICE_ID`, `SMARTTHINGS_POLL_TOKEN` | 5 | Appliance polling |
| `PLANNER_CLEANUP_TOKEN` | 2+ (generated) | Nightly planner-cleanup schedule auth |

Rule: tokens never get committed — terminal/local ignored `.env` only.
