# Phase 5 — SmartThings Appliance Status + Cycle-Finished Telegram Alert

> Status: ☐ Not started
> Gate: Final phase — passes when a wash cycle finishing produces exactly one Telegram alert and the panel reflects live state.

## Goal

The washer's state appears as a card on the Kindle dashboard, and Telegram alerts when a cycle finishes (≤15 min latency via InsForge scheduled function; there is no real-time push channel — PAT-based REST polling is the only path).

## 1. New files

### `migrations/20260711000000_create-appliance-status.sql`

```sql
CREATE TABLE IF NOT EXISTS appliance_status (
  id TEXT PRIMARY KEY,              -- e.g. 'washer'
  device_id TEXT NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unknown',
  job_status TEXT,
  completion_percent INTEGER,
  raw JSONB,
  prev_state TEXT,
  alerted_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE appliance_status ENABLE ROW LEVEL SECURITY;
```

### `functions/smartthings-poll.ts` (single self-contained scheduled function)

- Auth: require header `X-Poll-Token` matching secret `SMARTTHINGS_POLL_TOKEN` (InsForge schedules send secret-aware headers).
- Fetch: `GET https://api.smartthings.com/v1/devices/<SMARTTHINGS_DEVICE_ID>/status` with `Authorization: Bearer $SMARTTHINGS_PAT`, `AbortSignal.timeout(10000)`.
- First run: log the **raw** status JSON to identify the capability paths for your specific appliance; then map the relevant ones (typically the main component `washerJobStatus` capability: `washerJobStatus.completed` / execution summary; state `run`/`stop`/`pause`).
- Transition detection: read current row → compare to new state → on transition **into** a finished state → Telegram `sendMessage` to `TELEGRAM_ALLOWED_CHAT_ID`: `Washer finished its cycle.` → write row (`state`, `prev_state`, `job_status`, `completion_percent`, `raw`, `alerted_at`, `fetched_at`).
- Never alert twice for the same finish (idempotent via `prev_state` + `alerted_at`).

### `scripts/list-smartthings-devices.mjs`

One-shot helper run from the Mac: `GET https://api.smartthings.com/v1/devices` with PAT from env → prints `deviceId` + `label` + type so you can pick the right appliance.

## 2. Modified files

### `functions/kindle-dashboard-data.ts`
- Read `appliance_status` rows → payload:
```ts
appliances: [{ id, label, state, job_status, completion_percent, fetched_at, stale }]
```
- `stale = fetched_at older than 30 min`. If stale, optional live-fetch with 5 s timeout inside try/catch (write-through to table). Add `appliances` to the version hash.

### `kindle/native/src/kindle_dashboard.cpp`
- `struct Appliance { char label[32]; char state[32]; char job_status[48]; int completion_percent; }`
- `parseAppliances(json, dashboard)` — tolerant of absent key (returns 0 → card never drawn)
- `drawApplianceCard()`: compact one/two-line card — `WASHER — RUNNING 34 MIN` / `WASHER — DONE` / `WASHER — UNKNOWN`; slot it in the home grid where it fits best after Phase 3's calendar card lands (bottom strip above footer or right-column third row — decide visually with fixture renders)
- Update `fixtures/dashboard-data.json` with an `appliances` block.

### `scripts/bootstrap-insforge-kit.mjs`
- Add migration + `smartthings-poll` function deploy. Register the schedule after deploy (verify exact flags via `npx @insforge/cli schedules --help`):
  ```sh
  npx @insforge/cli schedules create --name smartthings-poll \
    --cron "*/15 * * * *" --function smartthings-poll \
    --header "X-Poll-Token: <SMARTTHINGS_POLL_TOKEN>"
  ```

## 3. External setup

1. https://account.smartthings.com → generate **Personal Access Token**, scope `devices:read` (add `iot:events` if listed as needed for status).
   - PATs have a **fixed lifespan** shown at creation — pick the longest, note the expiry date, set a calendar reminder to regenerate. When it lapses the panel degrades to UNKNOWN and alerts stop; `secrets update SMARTTHINGS_PAT` fixes it.
2. `SMARTTHINGS_PAT=... node scripts/list-smartthings-devices.mjs` → note your appliance's `deviceId`.
3. Secrets:
   ```sh
   npx @insforge/cli secrets add SMARTTHINGS_PAT <pat>
   npx @insforge/cli secrets add SMARTTHINGS_DEVICE_ID <device-id>
   npx @insforge/cli secrets add SMARTTHINGS_POLL_TOKEN <openssl rand -hex 32>
   ```
4. Deploy function → register schedule → run the poll once manually (curl with the poll token header) to create the first row and inspect the raw mapping.

## 4. Verification

- [ ] Device lister prints your washer
- [ ] Manual poll → `appliance_status` row matches the SmartThings app state right now
- [ ] Start a wash cycle → within 15 min, KUAL **Refresh Once** shows `WASHER — RUNNING`
- [ ] Cycle finishes → **one** Telegram alert `Washer finished its cycle.` arrives within 15 min; `alerted_at` set; next poll produces **no duplicate**
- [ ] PAT revoke simulation → row goes stale → Kindle shows `WASHER — UNKNOWN`; lists/calendar/health panels unaffected
- [ ] SSE: status row change → version hash change → Kindle auto re-renders (table reads feed the hash; no SmartThings call in the SSE loop)

## 5. Rollback / fallback

- Delete the schedule → no more polling/alerts; dashboard falls back to stale/live-fetch behavior.
- Absent `appliances` JSON key → C++ `parseAppliances` returns 0 → card never drawn (renderer untouched upstream-compatible).
- Alert latency unsatisfying → tighten cron to `*/5 * * * *` if invocation quota allows.

## Tests

- **Unit tests (new `functions/smartthings-poll.test.ts` or extended webhook tests)** for the exported pure helpers:
  - `mapSmartThingsStatus(raw)` → `{state, job_status, completion_percent}` against **captured real status JSON fixtures** (save the raw payload from your appliance in `functions/fixtures/smartthings-*.json`: idle, running, finished, unknown capability layout)
  - `shouldAlert(prev, next)`: idle→running false; running→finished true; finished→finished false (no duplicate); missing prev → false
- **Renderer smoke:** fixture with `appliances` block (washer RUNNING / DONE / UNKNOWN variants) renders the card; missing `appliances` key renders unchanged
- **Live integration:** the verification checklist above (manual poll, transition alert exactly once, PAT revoke → UNKNOWN)
- `npm test` green before deploying the poll function and registering the cron schedule.

## 6. Results log

_Record the capability paths found in your appliance's raw status JSON, PAT expiry date, and chosen cron interval._
