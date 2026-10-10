# Fork Notes — kdashboard → Dinesh's Kindle Dashboard

Fork of `thecodedose/kdashboard`, customized for:
- Kindle Paperwhite 11th gen (PW5), firmware 5.18.6, KUAL Next
- InsForge hosted free tier (bring-your-own-backend)
- Z.ai glm-4.7 for NLP (no OpenAI; Coding Plan endpoint `api/coding/paas/v4`)
- Google Calendar integration (Phase 3)
- Apple Watch health via HealthSyncCompanion (Phase 4)
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
| New: `functions/google-calendar-oauth.ts` | Auth-URL + code-exchange callback | 3 |
| New: `migrations/..._create-appliance-status.sql` | Appliance snapshot + alert bookkeeping | 5 |
| New: `functions/smartthings-poll.ts` | Scheduled PAT poller + transition alert | 5 |
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
3. If refresh token silently expires (app still in test mode): publish the consent app to Production (personal unverified use is fine), then re-consent once.

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

### Firmware update survival (5.18.x+)
After an Amazon firmware update: re-jailbreak per kindlemodding wiki if needed, then reinstall MRPI + KUAL Next; extension files under `/mnt/us/extensions/` usually survive but re-run `bin/diagnose.sh`.

## Secret inventory (server-side, InsForge)

| Secret | Set in | Purpose |
|---|---|---|
| `INSFORGE_BASE_URL`, `INSFORGE_API_KEY` | 0 | Function → backend self-calls |
| `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID` | 0 (bot via configure script) | Telegram auth/allowlist |
| `DASHBOARD_READ_TOKEN`, `DASHBOARD_TOGGLE_TOKEN`, `HEALTH_SYNC_TOKEN` | 0 (generated) | Kindle/iOS ↔ function auth |
| `ZAI_API_KEY`, `ZAI_MODEL` | 2 | NLP parsing |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 3 | OAuth exchange (refresh token lives in `google_calendar_state` table) |
| `SMARTTHINGS_PAT`, `SMARTTHINGS_DEVICE_ID`, `SMARTTHINGS_POLL_TOKEN` | 5 | Appliance polling |

Rule: tokens never get committed — terminal/local ignored `.env` only.
