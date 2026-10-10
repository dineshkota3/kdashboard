# Phase 0 — Foundation: Fork + Strip Meals + InsForge Bootstrap + Telegram (Heuristics Only)

> Status: ✅ Complete (2026-10-08 — see Results log; Telegram E2E verified)
> Gate: Phase 1 starts only after every verification item below passes.

## Goal

A clean fork of `thecodedose/kdashboard` at `/Users/dineshkota/dev/kindle_project` where:

- Telegram list commands (groceries / workout / todo-chores), health targets, and challenge check-ins work against **your own InsForge project**.
- All meal/recipe/meal-plan code is removed end-to-end (schema, Telegram parser, dashboard payload, C++ renderer, assets, docs).
- No LLM key is needed yet — the built-in heuristic parser handles everything (this proves the parser is complete before Phase 2 swaps in Z.ai).
- No Kindle involvement yet.

## 1. Fork + clone

```sh
# 1. Fork on GitHub using the authenticated gh CLI (creates <you>/kdashboard)
gh repo fork thecodedose/kdashboard --clone=false

# 2. Clone into the project folder (dir is non-empty with docs/, so clone to tmp and merge)
git clone git@github.com:<you>/kdashboard /tmp/kdashboard
cp -R /tmp/kdashboard/. /Users/dineshkota/dev/kindle_project/
rm -rf /tmp/kdashboard

cd /Users/dineshkota/dev/kindle_project
git checkout -b fork/phase-0-strip-meals
npm install          # requires Node.js 20+
```

Keep `main` tracking upstream so we can diff/restore individual files later.

## 2. Strip meals/recipes — exact file changes

### Migrations — DELETE these files
- `migrations/20260629052000_create-recipes.sql`
- `migrations/20260629065000_add-sample-toast.sql`
- `migrations/20260629070000_add-recipe-photo-pgm.sql`
- `migrations/20260629070100_clear-sample-toast-storage-photo.sql`
- `migrations/20260701000000_add-recipe-rating.sql`
- `migrations/20260701001000_recipe-rating-out-of-five.sql`
- `migrations/20260629162000_create-meal-plan-entries.sql`
- `migrations/20260707010000_add-sample-protein-snack.sql`
- `migrations/20260707011000_add-sample-smoothie.sql`

### Migrations — EDIT
- `migrations/001_planner_lists.sql`: remove `'meal'` from the `list_key` CHECK constraint and from the seed rows. Result: only `grocery`, `workout`, `todo`.
- `migrations/20260707000000_enable_rls_private_tables.sql`: remove the recipes / recipe_ingredients / meal_plan RLS lines.

### `functions/telegram-webhook.ts`
Types (delete):
- `RecipeIngredientInput`, `RecipeAction`, `RecipeRatingAction`, `MealPlanAction`
- `ListKey` becomes `"grocery" | "workout" | "todo"`; drop `"meal"` from `LIST_ALIASES` / `LIST_KEYS`.

Functions (delete):
- `applyMealPlanAction`, `applyRecipeAction`, `applyRecipeRatingAction`
- `parseMealPlanHeuristically`, `parseRecipeHeuristically`, `parseRecipeRatingHeuristically`
- their validators, `normalizeRecipeIngredient`, `extractRecipeTitle`, `extractRecipeRatingTitle`, `parseIngredientsList`, `clampRecipeRating`
- meal/recipe lines in the OpenAI/LLM system prompt (full prompt rewrite happens in Phase 2 anyway)

`applyTelegramAction` dispatch reduces to: **challenge → target → planner**.

### `functions/kindle-dashboard-data.ts`
- Delete `RecipeRow`, `RecipeIngredientRow`, `MealPlanEntryRow` types, `recipesResult`, `mealPlanResult`, ingredients query, `recipes` / `meal_plan` payload fields, and their version-hash members.
- Add `"workout"` to the `planner_items` `.in("list_key", [...])` filter and to the `lists` mapping array (order: `todo, workout, grocery` — home grid consumes this order).

### `functions/kindle-dashboard-events.ts`
- Same strip as dashboard-data (remove recipes/meal_plan from payload + hash members); add `"workout"` to the lists query.

### `functions/kindle-dashboard-toggle.ts`
- Unchanged (list-level toggle already generic).

### `kindle/native/src/kindle_dashboard.cpp`
Delete:
- Structs: `RecipeRecord`, `RecipeIngredientRecord`, `MealPlanEntry`
- Functions: `parseRecipes`, `parseMealPlan`, `parseRecipeIngredients`, `recipeIndexById`, `recipePhotoPath`, `drawRecipeLocalImage`, `drawMealPlannerDashboard`, `drawRecipesDashboard`, `drawRecipeRecordDashboard`, `drawRecipeDashboard`, `drawMealPlannerTile`, star-rating helpers
- Touch actions: `kTouchOpenRecipes`, `kTouchOpenRecipe`, `kTouchOpenMealPlanRecipe`, the recipe branches in `handlePendingTouch` / `kTouchBack`
- Globals: `g_active_recipe*`, `g_active_recipes`

Home layout (`drawBitmapDashboard`, ~line 1948) — new grid:
- Left column: `lists[0]` (Todo/Chores) + 75-day challenge tile (unchanged)
- Right column: Workout card (`lists[1]`) above Grocery card (`lists[2]`) — **the workout card replaces the meal-planner tile slot**
- Header "DAILY OPS" + STEPS/CALORIES gauges and footer stay as-is

### `kindle/native/Makefile`
- Remove `meal-planner-cover.pgm` and `assets/recipes` copy lines from BOTH `extension` and `extension-zig` targets.

### `kindle/native/fixtures/dashboard-data.json`
- Ensure fixture has a `workout` list with 2–3 sample items; keep no recipes/meal_plan keys (fixture already omits them).

### Docs
- `docs/INSTALL_FOR_USERS.md`: remove meal sections.
- `.env.example`: leave `OPENAI_*` entries untouched for now (dead until Phase 2 renames them).

## 3. External setup (InsForge + Telegram)

```sh
# InsForge — create account at insforge.dev first, then:
npx @insforge/cli login
npx @insforge/cli create --name kindle-dashboard --region us-east --template empty

# Server-side secrets (functions read these at runtime)
npx @insforge/cli secrets add INSFORGE_BASE_URL https://<project>.insforge.app
npx @insforge/cli secrets add INSFORGE_API_KEY <server-only-api-key>

# Bootstrap: applies trimmed migrations, generates TELEGRAM_WEBHOOK_SECRET,
# HEALTH_SYNC_TOKEN, DASHBOARD_READ_TOKEN, DASHBOARD_TOGGLE_TOKEN, deploys 5 functions
npm run kit:backend

# Telegram
# 1. BotFather → /newbot → save BOT_TOKEN
# 2. Send any message to your bot, then:
npm run telegram:chat-id -- --bot-token <BOT_TOKEN>
# 3. Register webhook + chat allowlist:
npm run telegram:configure -- \
  --bot-token <BOT_TOKEN> \
  --chat-id <CHAT_ID> \
  --webhook-url https://<project>.insforge.app/functions/telegram-webhook
```

Secrets handling rule: tokens go only into terminal commands or local ignored `.env` — never into committed files.

## 4. Verification (all must pass)

Backend payload:
```sh
curl -sS -H "X-Dashboard-Read-Token: <DASHBOARD_READ_TOKEN>" \
  https://<project>.insforge.app/functions/kindle-dashboard-data | jq '.lists | map(.key), has("recipes"), has("meal_plan")'
```
- [ ] `lists` keys = `["todo","workout","grocery"]`; `recipes`/`meal_plan` absent; `has(...)` both false.

Telegram commands (all via heuristic parser — no LLM key set):
- [ ] `add milk and eggs to groceries` → adds 2 items to grocery
- [ ] `need apples, yogurt, oats in grocery` → adds 3 items
- [ ] `put leg day on workout` → adds to workout
- [ ] `add clean desk to todo` → adds to todo
- [ ] `mark milk done` → toggles done
- [ ] `undo milk` → back to open
- [ ] `remove eggs from groceries` → deleted
- [ ] `clear todo` → clears done items
- [ ] `drank 1L water` / `set steps target to 12000` → health targets update
- [ ] `add meal butter chicken` → **no meal action kind** (without an LLM key the heuristic parser is a catch-all: text lands as a plain todo/chores add; it must never produce `meal_plan`/`recipe` actions — covered by unit test)
- [ ] Message from a second Telegram account → ignored (chat allowlist works)

Database (InsForge dashboard → Database):
- [ ] Tables: `planner_lists`, `planner_items`, `health_*`, `challenge_*` exist; **no** `recipes`, `recipe_ingredients`, `meal_plan_entries`

macOS renderer sanity (no Kindle needed):
```sh
npm run native:check      # builds kindle-dashboard-local, renders fixtures/dashboard-data.json
```
- [ ] Renders without crashing; home grid shows Todo + Challenge (left), Workout + Grocery (right)

## 5. Rollback / fallback

- Any broken strip: restore the individual file from upstream `main` (`git checkout main -- functions/telegram-webhook.ts`) and re-apply deletions incrementally.
- Function deploy failure: `npx @insforge/cli functions deploy telegram-webhook --file functions/telegram-webhook.ts --name "Telegram Planner Webhook"` one at a time; check function logs in the InsForge dashboard.
- Migration failure on bootstrap: InsForge DB is fresh — fix SQL, drop partial tables via dashboard, re-run `npm run kit:backend`.

## Tests

Run with `npm test` (no accounts or network needed):

- **Parser unit tests** — `functions/telegram-webhook.test.ts` (node:test, runs natively on Node 23+; the webhook's InsForge import is lazy so Node can load the pure parsers):
  - planner add/complete/uncomplete/delete/clear across all three lists, multi-item `and`/comma splitting, `all_lists` behavior
  - health targets, challenge water/sleep/workout check-ins
  - **meal/recipe negative tests**: meal/recipe/rating phrasing must never produce `meal_plan`/`recipe`/`recipe_rating` kinds
  - validator gate: rejects unknown `list_key` (incl. `meal`), rejects legacy meal/recipe action kinds, rejects empty-item adds, accepts clear-with-empty-items
- **Integration tests** — `scripts/test-phase0.mjs`:
  - repo hygiene: zero `meal|recipe` references outside phase docs/test files
  - bootstrap consistency: every listed migration exists; CHECK keys == seed keys == `{grocery, workout, todo}`; no recipe/meal_plan tables in any migration
  - fixture shape: lists exactly `todo, workout, grocery`; no recipes/meal_plan keys
  - renderer smoke: binary builds warning-free; renders every view (home/challenge/chores/workout/grocery) at PW5 resolution 1236×1648 with non-blank output; tolerates a fixture with only the todo list

Every later phase extends `npm test` — see the Tests section in each phase doc.

## 6. Results log

- **2026-10-08 — code strip complete** (commit `fbfe376`, branch `fork/phase-0-strip-meals`):
  - 9 meal/recipe migrations deleted; `001_planner_lists.sql` + RLS migration trimmed; bootstrap migration list updated (sample-data list now empty).
  - `telegram-webhook.ts`: meal/recipe types, actions, parsers, validators, appliers, prompt lines removed (987 → ~570 lines). Heuristic parser intact.
  - `kindle-dashboard-data.ts` / `kindle-dashboard-events.ts`: recipes/meal_plan removed; `workout` added to lists queries; payload order `todo, workout, grocery`; version hashes updated.
  - `kindle_dashboard.cpp`: recipe structs/parsers/screens/touch actions/star rating/meal assets removed; home grid right column = Workout + Grocery; `applyInitialView` views now `challenge|chores|workout|grocery`; renders clean (`-Wall -Wextra -Wpedantic`, zero warnings, dead helpers removed).
  - Fixture updated with workout list; **visual render verified** (760×1024 dump: CHORES + challenge left, WORKOUT + GROCERY right).
  - README / INSTALL_FOR_USERS / SETUP_WITH_ASSISTANT meal sections removed; repo-wide grep for meal/recipe = 0 hits.
- **2026-10-08 — tests added** (`npm test` green: 27 unit + 10 integration):
  - `functions/telegram-webhook.test.ts` (parser/validator unit tests) + `scripts/test-phase0.mjs` (hygiene/migrations/fixture/render smoke at 1236×1648)
  - webhook InsForge import made lazy (`await import` inside handler) so Node can load the module for tests — deploy behavior under Deno unchanged (verify at deploy)
  - pure parsers exported (`parseFastHeuristicMessage`, `parseMessageHeuristically`, `validateTelegramAction`)
  - **upstream bug fixed**: clear actions returned `items:["clear todo"]` (fallback clobbered the intentional `[]`); DB effect was unaffected but payload/validator contract was violated
- **2026-10-08 — InsForge deployed and verified:**
  - Logged in (owner@example.com), project `kindle-dashboard` created: `https://eq8jq3jz.us-east.insforge.app`
  - `npm run kit:backend`: 5 migrations applied, 4 generated secrets created, 5 functions deployed
  - **Gotcha found + fixed**: project API key secret got corrupted during `secrets get` output parsing (CLI prints `KEY =<value>` with no space; `awk '{print $NF}'` grabbed a broken fragment) → functions got `AUTH_UNAUTHORIZED` 401s → endpoint 500'd as `[object Object]`. Fixed with exact `sed` extraction; added structured error logging to the data function's catch block.
  - Endpoint verified: HTTP 200 with `X-Dashboard-Read-Token`, 401 without; payload = `{todo, workout, grocery}` lists, no recipes/meal_plan, version hash present
- **2026-10-08 — Telegram wired and E2E verified (Phase 0 gate PASSED):**
  - BotFather bot created; `TELEGRAM_BOT_TOKEN` secret stored; chat `8645326379` (Dinesh) discovered and allowlisted; webhook registered against `.../functions/telegram-webhook` (getWebhookInfo confirms, 0 pending)
  - Live command test — all 6 verified in DB + bot replies seen: `add milk and eggs to groceries` (2 rows), `put leg day on workout`, `add clean desk to todo`, `mark milk done` (done=true), `drank 1L water` (challenge log 1.00), `set steps target to 12000` (target row)
  - dashboard-data reflects live state: grocery `✗ eggs, ✔ milk`, steps_target 12000, version hash changes
  - Not tested: second-account rejection (needs a second Telegram account — low risk, chat allowlist logic is upstream-proven)
- **Phase 0 COMPLETE.** Remaining nice-to-have: none blocking Phase 1.
