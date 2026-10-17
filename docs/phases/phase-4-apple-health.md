# Phase 4 — Multi-Screen Dashboard: Two-Person Health, Pregnancy, Swipe, Hourly Drill-Down

> Status: 🚧 In progress (2026-10-17 — backend + device code complete and rendered locally; iOS rewritten, pending Xcode build on both phones; backend deploy + device install pending)
> Gate: Phase 4 is done only when (a) both people's health tiles render on the health screen from their own Apple Health sources, (b) swiping flips screens reliably (direction verified in the log), (c) the pregnancy screen shows the correct week/countdown, and (d) tile taps open the hourly charts.

## Goal

- Three swipeable screens: **1** todo + calendar strips + grocery; **2** two-person health (Dinesh | Keethu); **3** pregnancy tracker.
- Health moves off screen 1; the profile image card is removed; screens 1's strips/lists gain its space.
- Keethu's Apple Health flows from her own iPhone/Watch via HealthSyncCompanion with source `apple_health_ios_keethu` (Dinesh keeps `apple_health_ios`).
- Tiles (Steps / Sleep / Exercise minutes / Resting HR) tap open **hourly charts** for the day; ♥ also lists HRV / respiratory rate / VO₂max.
- Per-person Telegram targets (`set steps target for keethu to 6000`); quick YDA / 2D buttons; tapping a calendar event row jumps to health for that date.

## Decisions (locked with owner, 2026-10-17)

1. Reuse the existing OAuth-client-style pattern for health: per-person **`source`** strings on the existing `UNIQUE(date, source)` key — no per-person schema rewrite for the basics.
2. Health screen tiles: Steps, Sleep, Exercise minutes, Resting heart rate (owner picks) + anything cheap to sync (active energy, distance, HRV, respiratory rate, VO₂max) stored for later tile swaps.
3. Pregnancy: compact tile on the health screen **and** a dedicated third screen; due date ships via the `PREGNANCY_DUE_DATE` secret (owner supplies the exact date at rollout).
4. 75-day challenge stays its own tapped view, untouched (single-person, `challenge_daily_logs` unchanged).
5. Swipe = page flip (one full e-ink flash per switch accepted); hourly data exists for days synced since this phase shipped (past days keep daily totals only).

## 1. New files

### `migrations/20261017000000_health-new-metrics.sql`
`health_daily_summaries` += `exercise_minutes INT`, `resting_hr INT`, `sleep_hours NUMERIC(6,2)`,
`active_energy_kcal NUMERIC(10,2)`, `distance_km NUMERIC(8,2)`, `hrv_sdns_ms NUMERIC(8,2)`,
`respiratory_rate NUMERIC(5,1)`, `vo2max NUMERIC(5,1)` (all `NOT NULL DEFAULT 0` + `>= 0` checks) and
`hourly JSONB NOT NULL DEFAULT '[]'` — per-metric arrays, index = hour:
`{"steps":[24], "exercise_min":[24], "hr":[24 ints, 0 = no sample], "sleep":[24 ints: 0 none/1 awake/2 asleep]}`.
Only today's row carries populated hourly (phone syncs a 7-day window, so hourly history accumulates day-by-day from ship date).

### `migrations/20261017010000_health-targets-per-person.sql`
`health_targets`: `person TEXT NOT NULL DEFAULT 'dinesh'` added; PK → `(metric, person)`; metric CHECK widened to
`('steps','calories','exercise_minutes','sleep_hours','resting_hr')`; seeds Keethu steps 6000.
Backup first (`health_targets_backup_20261017`); pre-flight constraint names via `pg_constraint` (3.1 gotcha).

### `scripts/connect-calendar.mjs` — unchanged; no new scripts (iOS setup lives in docs).

## 2. Modified files

### `functions/health-sync.ts`
Payload accepts the new daily fields + `hourly`; `cleanHourly` validates the 4 arrays (≤24 entries, ints,
steps/exercise ≥ 0, hr ≤ 250, sleep ∈ 0..2); new metrics always overwrite (last sync wins — unlike nutrition,
which keeps `preserveExistingNutrition`). Old iOS payloads unaffected (fields default 0/`[]`).

### `functions/kindle-dashboard-data.ts`
- Health query `.in("source", [dinesh, keethu sources])` for the payload date + a second query fetching the
  previous 7 days' resting HR (per source) for the baseline.
- Payload `health`: **compat flat fields stay first (Dinesh's row — old binary + challenge view read them)**,
  then `people: [ ... ]` per-slot entries: metrics, per-person targets (`sleep_target_h`, `exercise_target`
  constants 8 h / 30 min; steps target from `health_targets` by person), `score`/`verdict`
  (weights steps .40 / exercise .30 / sleep .30; GREAT≥80/GOOD≥60/OK≥40/LOW), hit flags, `hr_baseline` +
  `hr_flag` (±7 bpm vs baseline; "none" without history), `rest_hint` (Keethu: exercise under target but sleep
  met), `hourly` (only when stored for the requested date).
- Top-level `pregnancy` block from `PREGNANCY_DUE_DATE` (secret; set **before** deploying this function):
  weeks/days/trimester (trimester 2 at 14w, 3 at 28w), days_to_go (negative = overdue), progress_pct,
  8 milestones (12w NT/20w anatomy/24w viability/28w T3/32w/36w/37w full term/40w due) with dates + done flags.
  All integer UTC-day math reusing `localDateIndex`/`addLocalDays`; zero date logic on the device.
- Calendar events gain `date_offset` (days from payload date). **All-day trap**: date-only `start_iso` is UTC
  midnight — use the literal string; timed events format the instant in `DASHBOARD_TIMEZONE`.
- Version hash += `people`, `pregnancy` (hourly rides inside people). SSE (`kindle-dashboard-events.ts`) is
  untouched — its hash is DB-flat, so **new hourly data lands on the device at the next interval refetch
  (≤1 h stale), by design** (documented; no events change).

### `functions/telegram-webhook.ts`
`HealthTargetAction` += `person` (`dinesh|keethu`); heuristic extracts `\b(keethu+|dinesh)\b` inside
target-shaped messages only; validator drops unknown persons (defaults to dinesh); DB select/update/insert
filter by `(metric, person)`; reply names the person; LLM prompt documents the person field.

### `kindle/native/src/kindle_dashboard.cpp`
- **Bug fixes**: (a) all flat health/challenge parses now scoped to their `{}` ranges (whole-document
  `strstr` greps would let nested `people[].steps` hijack first-match); (b) mid-drag dispatch fixed — touch
  events dispatch only at **lift** (`dispatchTouchLift`), the `EV_SYN` fallback is gated on press-seen, and
  swipes run before the exit-corner check. Previously a drag across the exit corner killed the app.
- **Swipe**: press-position capture, `detectSwipe` (|dx| ≥ 120 px, |dy| ≤ 80 px; left = next),
  `--swipe-invert-x` flag + `KINDLE_SWIPE_INVERT` config (x-sign verified via the `input=swipe` log);
  swipes ignored while any overlay view is open; swipe dispatch skips the touch pre-flash (no double flash).
- **Screens**: `g_active_screen` 0..2; `drawCurrentDashboard` overlays first, then screen switch;
  BACK returns screen 2/3 → home; `--view health|pregnancy|health-steps|...` render presets.
- **Screen 1**: profile image card + health radials removed (constants + Makefile asset copies too);
  calendar strips grow (4 event rows each); lists gain the rest.
- **Screen 2** `drawHealthDashboard`: per column — name band, summary verdict strip
  (`GOOD 78% S- E+ L-` + `REST` hint), tiles STEPS / SLEEP / EXERCISE (radials) + ♥ resting-HR value tile,
  Keethu pregnancy mini-tile (tap → screen 3), Dinesh sync-status strip (`APPLE HEALTH // SYNCED HH:MM`).
  All 8 tiles are tap regions → hourly overlay. YDA / 2D quick buttons in the subheader.
- **Hourly overlay** `drawHealthHourOverlay`: 24-bar chart (`drawHourlyChart`; sleep = asleep/awake timeline
  blocks), ♥ variant adds daily HRV / respiratory / VO₂max rows (`--` when absent). ~18/32 regions max.
- **Screen 3** `drawPregnancyDashboard`: WEEK card (trimester/day, `fillRect` progress bar, due date,
  countdown incl. `DUE +N` overdue) + 8-row milestone ladder ([X]/[ ] + strike-through); unconfigured state
  shows the secret hint. Zero date math in C++ (server ships display strings).
- Calendar full-screen rows are tap regions (`kTouchHealthForDate`, offset in `list_index`) → health for
  that date. Region budget worst case ≈ 23/32.

### `ios/HealthSyncCompanion/*`
- `HealthKitSyncService.swift`: `quantityTypes` += exercise time, resting HR, heart rate, active energy,
  distance, HRV SDNN, respiratory rate, VO₂max; sleep = category type added to auth/background/observers via
  a combined `sampleTypes`; `dailySums` gains an `HKStatisticsOptions` param (`.discreteAverage` for the
  averaged metrics); `sleepHoursByDay` (HKSampleQuery, wake-day bucketing, asleep stages only);
  `hourlySpreadForToday` (hour-interval statistics queries; sleep timeline by >50 % overlap; DST days
  23/25 collections → wall-clock hour index, last write wins). Fan-out 5 → 13 parallel queries.
- `HealthSyncModels.swift`: `HealthDay` new fields + `hourly: HealthHourly?` (nil omitted → past days unchanged).
- `AppConfig.swift`: `source` reads Info.plist `HEALTH_SYNC_SOURCE` with fallback `apple_health_ios`.
- `Info.plist` + `Config/LocalConfig.example.xcconfig`: `HEALTH_SYNC_SOURCE` documented (Keethu: `apple_health_ios_keethu`).
- `AppDelegate.swift`: observer callback → `syncIfStale(daysBack: 7)` (battery; the 5-min throttle already exists).

### Config/scripts
- `kindle/kual/kindle-dashboard/config.sh.example` + `bin/dashboard.sh`: optional `KINDLE_SWIPE_INVERT="1"`.
- `scripts/bootstrap-insforge-kit.mjs`: both new migrations in `schemaMigrations`.

### Fixture/tests
- Fixture: `health.people[2]` (hourly arrays), top-level `pregnancy` (8 milestones), compat fields unchanged.
- `scripts/test-phase0.mjs`: views += health/pregnancy/health-steps/health-hr; checks for 2 people +
  configured pregnancy + legacy payload (no people/pregnancy) + unconfigured pregnancy renders.
- `functions/telegram-webhook.test.ts`: per-person target routing, default-to-dinesh, unknown-person drop.

## 3. Keethu's iPhone setup (rollout step)

1. Same repo → Xcode → same signing flow as 4a; create her `Config/LocalConfig.xcconfig`:
   same `INSFORGE_HEALTH_SYNC_URL` + `HEALTH_SYNC_TOKEN`, plus `HEALTH_SYNC_SOURCE = apple_health_ios_keethu`.
2. Health read permissions now include Sleep, Heart rate, HRV, Respiratory rate, VO₂max, Exercise.
3. **First-sync gate**: run manual Sync, then verify rows land under her source —
   `SELECT date,source,steps FROM health_daily_summaries ORDER BY date DESC LIMIT 4` (a misconfigured
   source would overwrite Dinesh's rows via the UNIQUE key).

## 4. Verification

- [ ] `npm test` green (89+ webhook unit tests incl. per-person targets; phase-0 renders all screens + degraded payloads)
- [ ] Local renders: home (no profile card, taller strips), health (2 columns, strips, pregnancy tile),
      pregnancy (week card + 8 milestones), hourly overlays (bars/timeline/HR rows) — non-blank at
      1236×1648 and 1072×1448; legacy payload (no people/pregnancy) still renders; unconfigured pregnancy renders
- [ ] Live payload: `.health.people` both slots with real values; `.pregnancy` week math spot-checked;
      both sources present in DB for today; first occurrence of `"sleep_hours"` in the payload JSON is challenge
- [ ] Telegram: `set steps target for keethu to 6000` → her row only; bare command → dinesh only
- [ ] Device: swipe 1→2→3 + back (log `input=swipe`, direction correct, invert flag if needed); swipe ignored
      while overlays open; no mid-drag taps (old bug gone); tile taps open hourly overlays; BACK closes;
      event-row tap → health at that date; YDA/2D refetch; EXIT still exits
- [ ] iOS: both phones sync; Keethu's rows under her source; battery unchanged after 24 h

## 5. Rollback

- Functions: revert + redeploy (new columns are additive; scoped C++ parsers default to zeros).
- Device: restore `.bak` binary (old parser + new payload is compat-safe via compat-first + `sleep_h`).
- Targets PK: restore `health_targets_backup_20261017` + old PK (documented in the migration header).
- iOS: rebuild with the previous commit (source constant back to hard-coded).
- Pregnancy: blank the secret → screens degrade to the `configured:false` hint.

## Tests

- `functions/telegram-webhook.test.ts`: per-person target routing + defaults + unknown-person drop + queries
  untouched; `PLANNER_SYSTEM_PROMPT` documents person.
- `scripts/test-phase0.mjs`: fixture assertions (2 people, 8 milestones), all-screen renders, degraded renders.
- Live checklist above (payload jq, DB query, Telegram, device gestures).

## 6. Results log

- **2026-10-17 — Implementation complete (local), pending rollout.** All backend code, device code, iOS code,
  fixture, tests written; all screens rendered locally at 1236×1648 (health, pregnancy, HR overlay, reflowed
  home); 92+ unit tests + phase-0 suite green. Exploration caught two pre-existing bugs fixed here: whole-doc
  key-parse hijack and mid-drag touch dispatch. Plan-agent reconciliation folded in: hourly JSONB as per-metric
  arrays, hourly HR from `.heartRate` hourly averages (not resting HR), all-day `date_offset` trap, offsets in
  `list_index` (not item_id), hourly persists per row (docs say "days synced since ship"), SSE hourly staleness
  accepted (interval refetch covers), targets-PK deploy-order constraint (webhook right after migration).
- **PENDING:** set `PREGNANCY_DUE_DATE` (exact due date from owner) → apply migrations → deploy
  health-sync + telegram-webhook + kindle-dashboard-data → verify payload compat (old-binary render) →
  Telegram target routing checks → device build + install + gesture verification (invert flag if needed) →
  iOS builds on both phones (Dinesh first, then Keethu with her source) → usage check.
