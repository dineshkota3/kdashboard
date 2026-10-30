# Phase 4.1 — Scheduled Chores with 30-min Reminders; TODO Panel on Home

> Status: ✅ Implemented (2026-10-19 — migration + cron live, webhook/data/events deployed,
> device binary installed; 106 unit tests green; E2E verified add → reminder → done → spacing)
> Gate: done only when (a) a chore added via Telegram with a recurrence + time renders on the home
> CHORES panel with its time, (b) reminders arrive every ~30 min from the chore's start until done or
> day end (quiet hours respected), (c) "chore done X" / "skip chore X" stop reminders, (d) one-off
> chores auto-delete the day after, (e) the home screen shows the TODO panel at the bottom and it
> still round-trips via "add X to todo".

## Goal

- **Chores become scheduled**: each chore has a time window and a recurrence (daily, specific
  weekdays, or a one-off date). Rendered with times on the home CHORES panel
  (`[ ] 9:00 CLEAN KITCHEN`, `[X] 22:00 SOAK CASHEW`).
- **Reminders**: a 30-min cron sends Telegram nudges for every open chore whose window has started,
  until the owner marks it done (or skips it for the day, or the day ends).
- **TODO splits from chores**: the old unscheduled planner `todo` list moves to its own **TODO panel
  at the bottom of the home screen**; items live indefinitely until completed (unchanged behavior,
  new location). CHORES panel shows only today's scheduled chores.
- Parsing examples locked by owner: `add chore to clean kitchen every saturday` ·
  `soak the cashew everyday at 10pm` · `take out trash on Tuesday, Thursday and saturday`.

## Decisions (locked with owner, 2026-10-19)

1. Home layout: two calendar strips (top, unchanged) → CHORES + GROCERY panels (row shrinks) →
   **TODO panel full-width at the bottom**, above the footer. No new swipe screen.
2. Nag policy: reminders every 30 min from the chore's window start; **quiet hours 00:00–09:00**
   (no messages then); anything still open at midnight is silently missed (one-offs deleted,
   recurring reset next occurrence). Point-time chores ("at 10pm") nag 22:00–23:30 max.
3. One-off dates: `today` (default), `tomorrow`, `next <weekday>` — no full-date parsing.
4. `skip chore X` mutes today only (chore returns next scheduled day). Also `delete chore X`
   (removes the recurrence entirely). `chore done X` fuzzy-matches today's open chores.
5. Default window when no time given: **10:00–22:00** (owner's own "entire day" example).
6. Reminders go to the owner chat as ONE combined message per 30-min run (cheaper, less spam).
7. Implementation note: all day/weekday math follows the repo-wide `DASHBOARD_TIMEZONE` env
   (fallback Asia/Kolkata) instead of hardcoding Europe/Amsterdam, matching every other
   date-driven feature (pregnancy blocks, calendar reminders).

## 1. How scheduling works (core design)

### Storage — `migrations/20261019000000_chores.sql` (+ bootstrap list)

```sql
CREATE TABLE IF NOT EXISTS chores (
  id               TEXT PRIMARY KEY,            -- crypto.randomUUID
  text             TEXT NOT NULL,               -- 'clean kitchen' (<= 80 chars)
  pattern          TEXT NOT NULL DEFAULT 'daily', -- 'daily' | 'weekly' | 'once'
  days             TEXT NOT NULL DEFAULT '',    -- weekly: csv 2-letter 'mo,tu,we,th,fr,sa,su'
  once_date        TEXT NOT NULL DEFAULT '',    -- once: 'YYYY-MM-DD' Europe/Amsterdam
  start_min        INTEGER NOT NULL DEFAULT 600,  -- minutes from local midnight (10:00)
  end_min          INTEGER NOT NULL DEFAULT 1320, -- window end (22:00); point-time => 1440
  skip_date        TEXT NOT NULL DEFAULT '',    -- 'YYYY-MM-DD' when skipped for that day
  last_notified_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chore_dones (
  chore_id TEXT NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,                       -- 'YYYY-MM-DD' Europe/Amsterdam
  done_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chore_id, day)
);
ALTER TABLE chores ENABLE ROW LEVEL SECURITY;
ALTER TABLE chore_dones ENABLE ROW LEVEL SECURITY;
```

Completion is a **per-day row**, so a weekly/daily chore is automatically open again on its next
occurrence — no reset job. One-off chores: **undone ones roll over to the next day**
(revised 2026-10-29, owner request — they nag until actually done); **done ones are
deleted** by the sweep. Recurring chores are never deleted by the sweep.

### Occurrence resolution (pure function, lives in `chore-reminders.ts` + `telegram-webhook.ts`)

```ts
// Does this chore have an occurrence on Amsterdam local date `today` ('YYYY-MM-DD')?
function occursOn(chore, today): boolean {
  if (chore.pattern === "once") return chore.once_date === today;
  if (chore.pattern === "daily") return true;
  const wd = weekday2(today);                  // 'mo'..'su' via Intl in Europe/Amsterdam
  return chore.days.split(",").includes(wd);
}
```

Timezone: Europe/Amsterdam computed per run with `Intl.DateTimeFormat('en-CA', { timeZone:
'Europe/Amsterdam' })` → local `YYYY-MM-DD` + weekday + minutes-since-midnight. No tz library
(Deno Intl is sufficient, DST-safe).

Time parsing (`parseTimeWords`, shared):
- `10pm` / `9:30 am` / `22:00` → minutes. `10pm` → 1320.
- Range forms: `from 10am to 10pm`, `10am-10pm`, `between 10 and 22` → `start_min..end_min`.
- Point time only → `start_min = t`, `end_min = 1440` (nags to midnight; quiet hours trim it).
- No time at all → defaults 600..1320 (decision 5).

Day parsing (`parseDayWords`, shared):
- `everyday | daily | every day` → `pattern 'daily'`.
- `every saturday` → `weekly`, `days 'sa'`.
- `on tuesday, thursday and saturday` → `weekly`, `days 'tu,th,sa'`.
- `tomorrow` / `next <weekday>` → `once` with the Amsterdam date (strictly future for `next`).
- none → `once` with today (deleted at next sweep if not done).

### Reminder cron — `functions/chore-reminders.ts` (new), schedule `7,37 * * * *`

Off-minute schedule (:07/:37) per repo convention; 48 runs/day ≈ **1,488 fn calls/mo = 1.5% of
100K** (CLAUDE.md's "no new cron more frequent than hourly" is satisfied by owner's explicit
30-min request — decision recorded above). Per run, exactly one admin read + one admin write +
**at most one** outbound Telegram call (`AbortSignal.timeout(8000)`):

1. Amsterdam `now` → `today`, `nowMin`.
2. **Sweep**: `DELETE FROM chores WHERE pattern='once' AND once_date < today`.
3. Select all chores; a chore is **due** when ALL hold:
   - `occursOn(chore, today)`
   - no `chore_dones` row for `(id, today)` — not done
   - `skip_date !== today` — not skipped
   - `start_min <= nowMin` — reminders start at the chore's start
   - `nowMin <= end_min` AND `nowMin >= 540` — inside window AND past quiet hours (09:00)
   - `last_notified_at` older than 29 min (30-min spacing)
4. If any due → one message:
   `⏰ Chore reminders (3): • clean kitchen (9:00) • soak the cashew (22:00) • take out trash
   (10:00-22:00) — reply "chore done <name>" or "skip chore <name>"`.
5. `UPDATE chores SET last_notified_at = now()` for the due ids.

Edge cases: DST handled by Intl per-run; a chore whose window started before 09:00 (none can —
quiet hours clamp) nags from 09:00; missed open occurrences are never back-notified.

## 2. Telegram (`telegram-webhook.ts`)

New action `ChoreAction { kind: "chore"; action: "add"|"done"|"skip"|"delete"|"list"; text;
pattern?; days?; once_date?; start_min?; end_min? }` + heuristic parser (fast path, exported) +
LLM planner prompt lines + validators + appliers, mirroring the pregnancy-todo machinery.

**Routing (mutation guards before query matchers, chore checks before generic planner):**
- Any add-shaped message containing the word **"chore"** → chore add (covers `add chore to clean
  kitchen every saturday` where "to" is part of the verb phrase).
- Add-shaped message **without** "chore" but **with** recurrence/time tokens (`everyday`, `every
  <wd>`, `on <wd list>`, `tomorrow`, `next <wd>`, `at <time>`, `from <t> to <t>`) → chore add.
  (`soak the cashew everyday at 10pm` has no "chore" word but is a chore.)
- `add X to todo` / `add X to groceries` (no chore/time tokens) → unchanged planner routes.
- `chore done X` / `done chore X` / bare `done soaking the cashew` → fuzzy-match against **today's
  open chore texts** (same matcher as pregnancy todos; unknown → today's chore list).
- `skip chore X [today]` → `skip_date = today`, reply `⏭️ Skipped today — back <next occurrence>`.
- `delete chore X` → row deleted (dones cascade), reply confirms.
- `chores` / `chores today` → query listing today's chores with times + ✓/overdue marks.
- `add X to todo` still lands on the TODO panel's list (regression-checked in tests).

Replies: `🧹 Added chore: take out trash — tu,th,sa 10:00-22:00` (echo the schedule so parse
errors are visible), `✅ Chore done: soak the cashew`, `⏭️ Skipped today`.

## 3. Backend payload (`kindle-dashboard-data.ts`, `kindle-dashboard-events.ts`)

- Query `chores` + today's `chore_dones`; derive **in TS, zero date logic in C++**:
  `chores: [{ id, text, time_display ("9:00-22:00" | "22:00"), start_display, done, overdue }]`
  for **today only**, sorted by `start_min` (server resolves occurrence, done, skip, overdue).
  `overdue` = window end passed and not done.
- TODO panel reuses the existing `lists.todo` — no payload change there.
- Version hash += chores(+dones) → Telegram done/skip pushes an SSE refresh so the panel updates
  within seconds.

## 4. Kindle C++ (`kindle_dashboard.cpp`)

- `Chore[24] { id[24], text[80], time_display[16], done, overdue }` + `parseChores` (scoped keys,
  same pattern as pregnancy todos).
- **Home**: CHORES panel rows become `[ ] 9:00 CLEAN KITCHEN` / `[X] 22:00 SOAK CASHEW` /
  `! 22:00 LATE - TAKE OUT TRASH`; empty state `NO CHORES TODAY`; count line `2/5 DONE`.
  **TODO panel** (new, full-width, below CHORES/GROCERY, above footer): existing `[ ]/[X]` list
  style, ~3 rows + `+N MORE`. Both panel rows shrink to fit; verified by render at both sizes.
- Chores tap-view: full today list with times (same row widgets).
- No new screens; swipe/buttons untouched.

## 5. Fixture + tests

- Fixture: `chores` array (open/point-time, done, overdue, windowed mix); `lists.todo` kept.
- `scripts/test-phase0.mjs`: fixture carries chores + todo; home + chores-view renders non-blank.
- `functions/telegram-webhook.test.ts`: parse table with the owner's three examples + `tomorrow`,
  `next monday 10am`, `from 10am to 10pm`, bare-time, no-time defaults; routing precedence
  (chore-add vs grocery/todo; `add X to todo` still → todo); done fuzzy match; skip; delete;
  queries; mutation-guard ordering.

## 6. Implementation order

1. Migration + bootstrap list → apply live (strip `--` comments per CLI gotcha)
2. `chore-reminders.ts` → deploy → create 30-min schedule (`7,37 * * * *`)
3. Webhook additions (parser, prompt, appliers) → `npx tsx --test` → deploy
4. `kindle-dashboard-data` + `kindle-dashboard-events` → deploy → live payload check
   (chores present; hash changes when a chore is done)
5. Fixture + C++ (parse, home TODO panel, chores rows) → `npm test` + renders (1236×1648, 1072×1448)
6. Device deploy (stop → scp → chmod → once-light → start-light)
7. E2E via webhook sim: add the three example chores → wait a :07/:37 boundary → confirm reminder
   message; `chore done` / `skip` / `delete`; delete the test chores; device render shows times
8. Usage check + usage-history row → docs (FORK_NOTES/INSTALL snippets) → commit + push

## 7. Verification

- Cron log shows sweeps + at most one Telegram send per run; quiet hours verified by forcing a
  manual run inside 00:00–09:00 (no send).
- Reminder spacing: two consecutive runs 30 min apart with an undone chore → exactly 2 messages.
- One-off rollover: add `once` chore dated yesterday, not done → sweep moves it to today.
- One-off deletion: add `once` chore dated yesterday, done → sweep removes it.
- Payload: `chores` reflects done/skip instantly; SSE pushes; device refreshes.
- Device: CHORES times render; TODO panel at bottom; `add X to todo` appears there; chores
  tap-view lists today's chores.

## 8. Guardrails

- 30-min cron sanctioned by owner request (1.5% of fn-call budget); one combined Telegram send/run.
- All InsForge reads/writes batched; single outbound call with 8s timeout; SSE untouched (DB-only).
- No PII in code/docs/tests (placeholders only).

## Rollback

Device: restore `.bak`. Backend: `git revert` + redeploy; drop the schedule; tables are additive
and inert without the cron/webhook routes. TODO panel removal restores previous home layout.

## Risks / notes

- Recurrence parse errors are the main risk — mitigated by echoing the parsed schedule back on
  every add (`🧹 Added chore: ... — sa 10:00-22:00`) so mistakes are visible immediately.
- 30-min nag cadence on many open chores could feel spammy — combined single message per run
  caps it at ~1 message/30 min no matter how many chores are due.
- Chores cap: 32 rows enforced in webhook (`max 32 active chores`) to protect the C++ panel and
  payload size.
